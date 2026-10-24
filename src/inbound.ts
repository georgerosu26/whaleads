// ONE shared inbound pipeline. Both /webhooks/meta (Cloud API) and /webhooks/whabuzz feed it
// InboundEvent[]. It is idempotent: during cutover Meta delivers every message to both the old
// Meta app and WhaBuzz, so the same wamid arrives twice. Dedupe = INSERT OR IGNORE against the
// unique wamid (messages) and unique (wamid,status) (message_statuses).
import { onInboundMessage } from './flows/triggers'
import type { Env } from './db'
import { logEvent } from './db'
import { notifyInbound, notifyLead } from './push'
import { publishMessage, publishMessageStatus } from './live' // D20
import { parseReferral, type Referral } from './attribution'
import { inboundConversation, previewOf } from './conversations'
import { MEDIA_TYPES, inboundMediaRow, storeMediaForWamid } from './media'
import { classifyKeyword, applyKeyword } from './broadcasts/optout'
import { broadcastStatusStmts, rank } from './broadcasts/receipts'
import { errorCode, errorMessage } from './broadcasts/classify'
import type { InboundEvent, InboundMessage, InboundStatus } from './adaptors/types'

/** Upsert a contact by wa_id (falling back to a form-captured phone match). Returns contact id. */
export async function upsertWaContact(db: D1Database, waId: string, name: string | null): Promise<number> {
  const find = () => db.prepare(`SELECT id FROM contacts WHERE wa_id=?1 OR (wa_id IS NULL AND phone=?1) LIMIT 1`).bind(waId).first<{ id: number }>()
  let existing = await find()
  if (!existing) {
    try {
      const r = await db.prepare(`INSERT INTO contacts (wa_id, phone, name, source) VALUES (?1,?1,?2,'whatsapp')`).bind(waId, name).run()
      return r.meta.last_row_id as number
    } catch {
      existing = await find() // lost a race with the other webhook route (wa_id is UNIQUE)
      if (!existing) throw new Error('contact upsert failed')
    }
  }
  await db.prepare(`UPDATE contacts SET wa_id=?2, last_seen_at=unixepoch(), name=COALESCE(name, ?3) WHERE id=?1`).bind(existing.id, waId, name).run()
  return existing.id
}

export interface PipelineResult { messages: number; duplicates: number; statuses: number; leads: number }

/** A string field of the Meta media object (`image.mime_type`, `document.filename`), from the untouched raw message. */
function rawField(e: InboundMessage, field: string): string | null {
  const v = (e.raw as any)?.[e.type]?.[field]
  return typeof v === 'string' && v ? v : null
}

async function onMessage(env: Env, ctx: ExecutionContext, e: InboundMessage, res: PipelineResult): Promise<void> {
  const contactId = await upsertWaContact(env.DB, e.from, e.name) // idempotent, safe to repeat on retry
  const ref = parseReferral(e.raw, e.body)
  // Message row + lead row commit together (or not at all). If anything throws, no dedupe row exists,
  // so the provider's retry of the same wamid is processed again instead of being skipped as a duplicate.
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT OR IGNORE INTO messages (contact_id,direction,wamid,type,body,media_id,status,timestamp,raw) VALUES (?,?,?,?,?,?,?,?,?)`,
    ).bind(contactId, 'in', e.wamid, e.type, e.body, e.media_id, 'received', e.timestamp, JSON.stringify(e.raw)),
    // changes() is the INSERT OR IGNORE above: 0 when the wamid already existed (replay / second route).
    // The conversation upsert is guarded the same way and reports one change when it ran, so the lead
    // insert below still sees "the message was new". Unread therefore moves once per wamid.
    inboundConversation(env.DB, contactId, e.timestamp, previewOf(e.type, e.body)),
    // a referral (ad click / reference code) creates its lead here, keyed on "no OPEN lead". It sits before the
    // plain statement on purpose: when it inserts, the plain one below sees changes() > 0 but finds the new lead
    // within 30 days and inserts nothing; when it does not, changes() is 0 and the plain one is skipped too.
    ...(ref?.fromAd ? [referralLeadInsert(env.DB, contactId, e.body, ref)] : []),
    env.DB.prepare(
      `INSERT INTO leads (contact_id,source,message) SELECT ?1,'whatsapp',?2
       WHERE changes() > 0 AND NOT EXISTS (SELECT 1 FROM leads WHERE contact_id=?1 AND created_at > unixepoch() - 2592000)`,
    ).bind(contactId, e.body),
    // the media row commits with the message. After the guarded statements above (they read changes()).
    // A replayed wamid inserts nothing: media.message_id is UNIQUE and the statement is INSERT OR IGNORE.
    ...(e.media_id && e.wamid && MEDIA_TYPES.has(e.type)
      ? [inboundMediaRow(env.DB, e.wamid, e.media_id, rawField(e, 'mime_type'), rawField(e, 'filename'))]
      : []),
  ]
  const results = await env.DB.batch(stmts)
  const ins = results[0]
  // a lead row inserted by this batch (referral or plain statement; index 1 is the conversation upsert).
  const newLead = results.slice(2, ref?.fromAd ? 4 : 3).find((r) => r.meta.changes > 0)?.meta.last_row_id as number | undefined
  // attribution on an existing lead + the timeline row. Runs for replays too (it is idempotent), so a
  // failure after the batch committed is repaired by the provider's retry instead of being lost as a duplicate.
  if (ref) await applyReferral(env.DB, contactId, e.wamid, ref)
  if (!ins.meta.changes) { res.duplicates++; return }

  res.messages++
  // Opt-out keywords (broadcasts): whole-message STOP / START style text only. Never fails the webhook.
  const kw = !MEDIA_TYPES.has(e.type) ? classifyKeyword(e.body) : null
  if (kw) await applyKeyword(env, ctx, contactId, kw).catch((err) => logEvent(env.DB, 'optout_keyword_error', { contactId, error: String(err) }))
  // copy the file to R2 after the response. Failures stay `pending` and the cron retries them.
  if (e.media_id && e.wamid && MEDIA_TYPES.has(e.type) && env.MEDIA) {
    ctx.waitUntil(storeMediaForWamid(env, e.wamid).catch((err) => logEvent(env.DB, 'media_store_error', { wamid: e.wamid, error: String(err) })))
  }
  // web push after the batch succeeded (D17: the only staff notification). A brand-new lead announces itself
  // (its first message is the lead); otherwise the message notifies the assignee, else everyone. Never fails the request.
  // D20: the live channel, after the same commit. Off the critical path, never able to fail the webhook.
  publishMessage(env, ctx, contactId, { id: ins.meta.last_row_id as number }, newLead)
  if (newLead) notifyLead(env, ctx, newLead)
  else notifyInbound(env, ctx, { contactId, name: e.name, phone: e.from, text: e.body ?? `[${e.type}]` })
  // flows. After the commit, off the critical path; a waiting run takes the reply first, then message.received, then lead.created.
  if (e.wamid) onInboundMessage(env, ctx, { contactId, wamid: e.wamid, text: e.body, newLeadId: newLead })
}

async function onStatus(env: Env, ctx: ExecutionContext, e: InboundStatus, res: PipelineResult): Promise<void> {
  // Dedupe row and the message update commit together. "failed" is terminal; otherwise status only moves forward.
  const at = Math.floor(Date.now() / 1000)
  const err = e.status === 'failed' ? (e.errors?.[0] ?? null) : null
  const code = errorCode(err)
  const [ins, upd] = await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO message_statuses (wamid,status,timestamp,raw) VALUES (?,?,?,?)`)
      .bind(e.wamid, e.status, e.timestamp, JSON.stringify(e.raw)),
    env.DB.prepare(`UPDATE messages SET status=?1 WHERE wamid=?2 AND changes() > 0 AND status IS NOT 'failed' AND (?1='failed' OR ${rank('status')} < ${rank('?1')})`)
      .bind(e.status, e.wamid),
    // Broadcast recipients, by wamid. After the two statements above (they read changes()). The counters run BEFORE the recipient
    // row moves, because they read its old status; the forward-only guards make a replay a no-op. A receipt that beats the
    // recipient's own `sent` write finds no 'sent' row here; the broadcast step reads it back in its sent-write batch and
    // replays it (src/broadcasts/step.ts), so nothing is lost.
    ...broadcastStatusStmts(env, e.wamid, e.status, at, code, errorMessage(err, '')),
  ])
  if (!ins.meta.changes) { res.duplicates++; return }
  res.statuses++
  if (upd?.meta.changes) publishMessageStatus(env, ctx, e.wamid) // D20: only when the tick actually moved
}

export async function processEvents(env: Env, ctx: ExecutionContext, events: InboundEvent[]): Promise<PipelineResult> {
  const res: PipelineResult = { messages: 0, duplicates: 0, statuses: 0, leads: 0 }
  for (const e of events) {
    if (e.kind === 'message') await onMessage(env, ctx, e, res)
    else if (e.kind === 'status') await onStatus(env, ctx, e, res)
    else {
      // Lead Ads (WhaBuzz only). Stored as an event for now; the CRM lead mapping lives in attribution.
      res.leads++
      await logEvent(env.DB, 'lead_event', e.data)
    }
  }
  return res
}

// ---- click-to-WhatsApp referral capture ---------------------------------------------------------

/**
 * Lead for an inbound message that carries a referral: one while the contact has no OPEN lead, so an ad click after
 * an old won/lost lead starts a fresh one. Only an ad click inserts a lead (source 'ctwa'); a typed reference code never does (typed codes are handled by reports/attribution).
 * Must follow the conversation upsert: `changes() > 0` there means the message was new.
 */
function referralLeadInsert(db: D1Database, contactId: number, body: string | null, ref: Referral) {
  return db.prepare(
    `INSERT INTO leads (contact_id,source,message,attribution,ctwa_clid,ad_source_id) SELECT ?1,?2,?3,?4,?5,?6
     WHERE changes() > 0 AND NOT EXISTS (SELECT 1 FROM leads WHERE contact_id=?1 AND status NOT IN (SELECT key FROM stages WHERE kind <> 'open'))`,
  ).bind(contactId, 'ctwa', body, JSON.stringify(ref.attribution), ref.ctwa_clid, ref.ad_source_id)
}

/**
 * Attribution rule: a lead's attribution columns are written once and never overwritten (COALESCE), and every
 * referral, first or later, adds one `referral` activity row (deduped per wamid). A second ad click on an open
 * lead therefore changes the timeline only. Targets the contact's newest OPEN lead, else the newest lead.
 */
async function applyReferral(db: D1Database, contactId: number, wamid: string, ref: Referral): Promise<void> {
  const lead = await db.prepare(
    `SELECT id FROM leads WHERE contact_id=?1
     ORDER BY (status NOT IN (SELECT key FROM stages WHERE kind <> 'open')) DESC, created_at DESC, id DESC LIMIT 1`,
  ).bind(contactId).first<{ id: number }>()
  if (!lead) return
  await db.batch([
    db.prepare(`UPDATE leads SET attribution=COALESCE(attribution,?2), ctwa_clid=COALESCE(ctwa_clid,?3), ad_source_id=COALESCE(ad_source_id,?4) WHERE id=?1`)
      .bind(lead.id, JSON.stringify(ref.attribution), ref.ctwa_clid, ref.ad_source_id),
    db.prepare(
      `INSERT INTO activity (lead_id,contact_id,actor,kind,data)
       SELECT ?1,?2,'system','referral',?3
       WHERE NOT EXISTS (SELECT 1 FROM activity WHERE lead_id=?1 AND kind='referral' AND json_extract(data,'$.wamid')=?4)`,
    ).bind(lead.id, contactId, JSON.stringify({ ...ref.attribution, wamid }), wamid),
  ])
}
