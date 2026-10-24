// The cron step that sends broadcasts (plan D2, D3). One broadcast runs at a time; each minute the step claims a few
// recipients, sends them one by one and records each in the SAME D1 call that settles the recipient row.
//
// Safety properties (each has a test):
//  - A recipient is claimed (`queued` -> `sending`, attempts+1) by a compare-and-set BEFORE the adaptor is called, and the
//    claim is only granted while the broadcast is `running`. A retried or overlapping tick cannot claim it twice.
//  - A send whose outcome is unknown (timeout, dropped connection) leaves the row `unknown`. It is never re-sent
//    automatically; an admin can requeue it.
//  - After every send the same batch reads the broadcast status and any contact who opted out since the claim; the loop
//    stops (or skips that contact) at once, so a cancel or an opt-out mid-tick takes effect before the next message.
//  - Opted-out contacts are skipped at candidate selection and again right before each send.
//
// Budget (Workers Free: 50 subrequests per invocation, D1 calls count): the caller passes what is left after the flow
// tick. Per send: 1 fetch + 1 D1 batch = 2 subrequests, 1 D1 call. Fixed overhead: 3 to 5 D1 calls and one live publish.
import { resolveActiveCached, CONFIG_VERSION_SQL } from '../adaptors'
import type { TemplateHeaderSend } from '../adaptors/types'
import type { Env } from '../db'
import { logEvent } from '../db'
import { meteredEnv } from '../flows/engine'
import { countSubrequest, type Meter } from '../flows/meter'
import { publish } from '../live'
import { sendTemplatePrepared, sampleHeaderMedia } from '../send'
import { safeComponents, sendability, rowJson, type TemplateRow } from '../templates'
import { renderParams } from '../templateRules'
import { MAX_ATTEMPTS, backoff, classifySend, errorCode, errorMessage, reasonOf, type Verdict } from './classify'
import { metaOptOutStmts } from './optout'
import { broadcastStatusStmts, rank } from './receipts'
import { parseFrozen } from './params'
import { MEDIA_REFRESH_S, type BroadcastRow } from './store'

export const DEFAULT_PER_MINUTE = 20
export const MAX_PER_MINUTE = 40
/** A claim older than this never finished (isolate evicted mid-send): the outcome is unknown. */
export const STUCK_S = 600

export interface StepOpts {
  /** D1 calls this step may spend. */
  dbBudget: number
  /** Subrequests (D1 calls + fetches + DO calls) this step may spend. */
  subrequestBudget: number
  now?: number
}
export interface StepResult { broadcast: string | null; sent: number; failed: number; unknown: number; skipped: number; paused: string | null; dbCalls: number; subrequests: number }

const nowSec = () => Math.floor(Date.now() / 1000)
const parseSetting = (v: unknown): number => { try { return Number(JSON.parse(String(v))) } catch { return Number(v) } }

/** The per-minute pace setting, clamped to 1..40. */
export const perMinute = (raw: unknown): number => {
  const n = parseSetting(raw)
  return Number.isFinite(n) && n >= 1 ? Math.min(MAX_PER_MINUTE, Math.floor(n)) : DEFAULT_PER_MINUTE
}

const placeholders = (n: number, from: number) => Array.from({ length: n }, (_, i) => `?${from + i}`).join(',')

interface Candidate { contact_id: string; params: string | null; attempts: number; dest: string | null }

export async function broadcastStep(env: Env, opts: StepOpts): Promise<StepResult> {
  const m: Meter = { calls: 0, subrequests: 0 }
  const menv = meteredEnv(env, m)
  const db = menv.DB
  const now = opts.now ?? nowSec()
  const out: StepResult = { broadcast: null, sent: 0, failed: 0, unknown: 0, skipped: 0, paused: null, dbCalls: 0, subrequests: 0 }
  const used = () => m.calls + (m.subrequests ?? 0)
  const finish = (): StepResult => { out.dbCalls = m.calls; out.subrequests = m.subrequests ?? 0; return out }

  // Call 1: promote the oldest queued broadcast if none is running, then read the running one, its template, the pace and the adaptor version.
  const [, runRes, tplRes] = await db.batch([
    db.prepare(
      `UPDATE broadcasts SET status='running', started_at=COALESCE(started_at, ?1), updated_at=?1
        WHERE id = (SELECT id FROM broadcasts WHERE status='queued' ORDER BY created_at, id LIMIT 1)
          AND NOT EXISTS (SELECT 1 FROM broadcasts WHERE status='running')`,
    ).bind(now),
    db.prepare(
      `SELECT b.*, (SELECT value FROM settings WHERE key='broadcast_per_minute') AS per_minute, ${CONFIG_VERSION_SQL} AS cv
         FROM broadcasts b WHERE b.status='running' ORDER BY b.created_at, b.id LIMIT 1`,
    ),
    db.prepare(`SELECT t.* FROM templates t WHERE t.id = (SELECT template_id FROM broadcasts WHERE status='running' ORDER BY created_at, id LIMIT 1)`),
  ])
  const b = runRes!.results[0] as (BroadcastRow & { per_minute: unknown; cv: string | null }) | undefined
  if (!b) return finish()
  out.broadcast = b.id
  const t = (tplRes!.results[0] as TemplateRow | undefined) ?? null

  const pause = async (reason: string) => {
    out.paused = reason
    await db.prepare(`UPDATE broadcasts SET status='paused', pause_reason=?2, updated_at=?3 WHERE id=?1 AND status='running'`).bind(b.id, reason.slice(0, 400), now).run()
    await logEvent(db, 'broadcast_paused', { id: b.id, reason }).catch(() => {})
    await progress()
    return finish()
  }
  const progress = async () => {
    if (!env.LIVE) return
    const row = await db.prepare(`SELECT id,status,pause_reason,total,sent,delivered,read,failed FROM broadcasts WHERE id=?`).bind(b.id).first<Record<string, unknown>>()
    if (row) { countSubrequest(m); await publish(env, [{ type: 'broadcast.progress', ts: Date.now(), data: row }]) }
  }

  // Template and sender must still be usable. These pause the broadcast (account-level), they never fail recipients.
  if (!t) return pause('The template was deleted.')
  if (t.status !== 'APPROVED') return pause(`The template is ${t.status.toLowerCase()}.`)
  const sb = sendability(safeComponents(t.components), t.category)
  if (!sb.sendable) return pause(sb.reason ?? 'The template cannot be sent.')
  const active = await resolveActiveCached(menv, b.cv ?? null)
  if (!active) return pause('No WhatsApp adaptor is configured.')
  const adaptor = active.adaptor

  // Header media: Meta keeps an uploaded id for 30 days. Re-upload the template sample past 25 days (or when missing).
  let mediaId = b.header_media_id
  const needsMedia = ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(t.header_format)
  if (needsMedia && (!mediaId || !b.header_media_at || b.header_media_at < now - MEDIA_REFRESH_S)) {
    if (used() + 6 > opts.subrequestBudget) return finish()
    const s = await sampleHeaderMedia(menv, t)
    if (!s.ok) return pause(s.message)
    countSubrequest(m, 2) // R2 read + upload
    const up = await adaptor.uploadMedia(s.media.bytes, s.media.mime)
    if (!up.ok || !up.data?.id) return pause(`Header media upload failed: ${up.error?.message ?? 'no media id returned'}`)
    mediaId = up.data.id
    await db.prepare(`UPDATE broadcasts SET header_media_id=?2, header_media_at=?3, updated_at=?3 WHERE id=?1`).bind(b.id, mediaId, now).run()
  }

  // Sends this step: pace setting, then whatever the budgets leave after the fixed overhead (skip+select, claim, end batch, publish).
  const perStep = Math.min(
    perMinute(b.per_minute),
    Math.floor((opts.subrequestBudget - used() - 6) / 2),
    opts.dbBudget - m.calls - 4,
  )

  let candidates: Candidate[] = []
  if (perStep >= 1) {
    // Call 2: skip contacts who opted out since the recipients were written (driven from the opted-out side), then pick the due ones.
    const res = await db.batch([
      db.prepare(
        `UPDATE broadcast_recipients SET status='skipped', error_message='opted out', updated_at=?2
          WHERE broadcast_id=?1 AND status='queued' AND contact_id IN (SELECT CAST(id AS TEXT) FROM contacts WHERE opted_out_at IS NOT NULL)`,
      ).bind(b.id, now),
      db.prepare(
        `SELECT r.contact_id, r.params, r.attempts, COALESCE(NULLIF(c.wa_id,''), NULLIF(c.phone,'')) AS dest
           FROM broadcast_recipients r JOIN contacts c ON c.id = CAST(r.contact_id AS INTEGER)
          WHERE r.broadcast_id=?1 AND r.status='queued' AND r.next_attempt_at <= ?2 AND c.opted_out_at IS NULL
          ORDER BY r.next_attempt_at, r.contact_id LIMIT ?3`,
      ).bind(b.id, now, perStep),
    ])
    out.skipped += res[0]!.meta.changes ?? 0
    candidates = res[1]!.results as unknown as Candidate[]
  }

  // Call 3: the claim. Only rows this statement flips are ours to send, and only while the broadcast is still running.
  let claimed: Candidate[] = []
  if (candidates.length) {
    const ids = candidates.map((c) => c.contact_id)
    const { results } = await db.prepare(
      `UPDATE broadcast_recipients SET status='sending', attempts=attempts+1, updated_at=?2
        WHERE broadcast_id=?1 AND status='queued' AND contact_id IN (${placeholders(ids.length, 3)})
          AND contact_id NOT IN (SELECT CAST(id AS TEXT) FROM contacts WHERE opted_out_at IS NOT NULL)
          AND EXISTS (SELECT 1 FROM broadcasts WHERE id=?1 AND status='running') RETURNING contact_id`,
    ).bind(b.id, now, ...ids).all<{ contact_id: string }>()
    const won = new Set(results.map((r) => String(r.contact_id)))
    claimed = candidates.filter((c) => won.has(c.contact_id))
  }

  const view = rowJson(t)
  const optedNow = new Set<string>()
  const done = new Set<string>()
  const endStmts: D1PreparedStatement[] = []
  let stop = false

  const recipientSet = (cid: string, set: string, ...binds: unknown[]) =>
    db.prepare(`UPDATE broadcast_recipients SET ${set}, updated_at=? WHERE broadcast_id=? AND contact_id=? AND status='sending'`).bind(...binds, now, b.id, cid)
  const failed = (cid: string, code: number | null, message: string) => [
    recipientSet(cid, `status='failed', error_code=?, error_message=?`, code, message.slice(0, 300)),
    db.prepare(`UPDATE broadcasts SET failed=failed+1, updated_at=?2 WHERE id=?1 AND changes() > 0`).bind(b.id, now),
  ]
  /**
   * Trailing reads on every send batch: the broadcast status, contacts who opted out since the claim, and (for a send that
   * just got its wamid) the best delivery receipt already stored for it. A receipt can beat the sent-write.
   */
  const tail = (wamid: string | null = null) => [
    db.prepare(`SELECT status FROM broadcasts WHERE id=?`).bind(b.id),
    db.prepare(`SELECT CAST(id AS TEXT) AS id FROM contacts WHERE opted_out_at IS NOT NULL AND opted_out_at >= ?`).bind(now),
    db.prepare(
      `SELECT status, raw FROM message_statuses WHERE wamid=?1 ORDER BY (status='failed') DESC, ${rank('status')} DESC LIMIT 1`,
    ).bind(wamid),
  ]
  const readTail = (res: D1Result[]) => {
    const st = (res[res.length - 3]!.results[0] as { status: string } | undefined)?.status
    for (const r of res[res.length - 2]!.results as Array<{ id: string }>) optedNow.add(String(r.id))
    if (st !== 'running') stop = true
    return res[res.length - 1]!.results[0] as { status: string; raw: string | null } | undefined
  }

  for (const c of claimed) {
    if (stop) break
    // Stop before the budget is gone: this send costs 1 D1 call and 2 subrequests (+1 D1 call if a receipt beat the write), the end batch, the progress read, the publish and a pause event need room.
    if (m.calls + 2 + 2 > opts.dbBudget || used() + 3 + 4 > opts.subrequestBudget) break
    if (optedNow.has(c.contact_id)) continue // released as skipped below
    const cid = c.contact_id
    const frozen = parseFrozen(c.params, t.body_params_count, t.header_params_count)
    if (!frozen || !c.dest) {
      endStmts.push(...failed(cid, null, !c.dest ? 'The contact has no phone number.' : 'The saved values are unusable.'))
      done.add(cid)
      continue
    }
    const text = [view.header_text ? renderParams(view.header_text, frozen.header) : '', renderParams(view.body, frozen.body)].filter(Boolean).join('\n')
    const header: TemplateHeaderSend | null = needsMedia && mediaId ? { format: t.header_format as 'IMAGE' | 'VIDEO' | 'DOCUMENT', mediaId, filename: t.header_format === 'DOCUMENT' ? 'header' : undefined } : null
    countSubrequest(m)
    const r = await sendTemplatePrepared(menv, adaptor, Number(cid), c.dest, { name: t.name, language: t.language, bodyParams: frozen.body, headerParams: frozen.header, header, text }, `broadcast:${b.id}`)
    done.add(cid)
    if (r.ok) {
      const res = await db.batch([
        ...r.statements,
        recipientSet(cid, `status='sent', wamid=?, sent_at=?`, r.wamid, r.now),
        db.prepare(`UPDATE broadcasts SET sent=sent+1, updated_at=?2 WHERE id=?1 AND changes() > 0`).bind(b.id, r.now),
        ...tail(r.wamid),
      ])
      out.sent++
      const receipt = readTail(res)
      if (receipt && r.wamid) {
        // A receipt (delivered / read / failed, maybe Meta 131050) landed between the adaptor's answer and this write: the webhook found no
        // 'sent' recipient and dropped the counters. Replay it now through the webhook's own statements (forward-only, so safe).
        let err: unknown = null
        try { err = receipt.status === 'failed' ? (JSON.parse(receipt.raw ?? 'null')?.errors?.[0] ?? null) : null } catch { /* keep null */ }
        // An early 'sent' receipt yields no statements; real D1 rejects an empty batch, so only replay when there is something to apply.
        const replay = broadcastStatusStmts(menv, r.wamid, receipt.status, r.now, errorCode(err), errorMessage(err, ''))
        if (replay.length) await db.batch(replay)
      }
      continue
    }
    const v: Verdict = classifySend(r.result)
    let stmts: D1PreparedStatement[]
    if (v.class === 'unknown_outcome') {
      out.unknown++; stop = true
      stmts = [recipientSet(cid, `status='unknown', error_message=?`, 'No answer from the sender; the message may have gone out. Not re-sent.'),
        db.prepare(`UPDATE broadcasts SET failed=failed+1, updated_at=?2 WHERE id=?1 AND changes() > 0`).bind(b.id, now)]
    } else if (v.class === 'retry') {
      const attempts = c.attempts + 1
      if (v.stop) stop = true
      if (attempts >= MAX_ATTEMPTS) { out.failed++; stmts = failed(cid, v.code, v.message) }
      else stmts = [recipientSet(cid, `status='queued', next_attempt_at=?, error_code=?, error_message=?`, now + backoff(attempts), v.code, v.message.slice(0, 300))]
    } else if (v.class === 'pause') {
      stop = true
      out.paused = reasonOf(v)
      stmts = [recipientSet(cid, `status='queued', attempts=attempts-1`),
        db.prepare(`UPDATE broadcasts SET status='paused', pause_reason=?2, updated_at=?3 WHERE id=?1 AND status='running'`).bind(b.id, reasonOf(v), now)]
    } else {
      out.failed++
      stmts = [...failed(cid, v.code, v.message), ...(v.optOut ? metaOptOutStmts(menv, Number(cid), now) : [])]
    }
    const res = await db.batch([...stmts, ...tail()])
    readTail(res)
    if (v.class === 'pause') await logEvent(db, 'broadcast_paused', { id: b.id, reason: out.paused }).catch(() => {})
  }

  // End batch: give back claims we did not use, settle the rows that failed without a send, reap abandoned claims, finish if drained.
  const left = claimed.filter((c) => !done.has(c.contact_id)).map((c) => c.contact_id)
  if (left.length) {
    endStmts.push(db.prepare(
      `UPDATE broadcast_recipients SET attempts=attempts-1, updated_at=?2,
         status = CASE WHEN (SELECT status FROM broadcasts WHERE id=?1)='cancelled' OR EXISTS (SELECT 1 FROM contacts c WHERE CAST(c.id AS TEXT)=broadcast_recipients.contact_id AND c.opted_out_at IS NOT NULL) THEN 'skipped' ELSE 'queued' END
        WHERE broadcast_id=?1 AND status='sending' AND contact_id IN (${placeholders(left.length, 3)})`,
    ).bind(b.id, now, ...left))
  }
  endStmts.push(
    db.prepare(`UPDATE broadcast_recipients SET status='unknown', error_message='The send did not complete; the message may have gone out.', updated_at=?2 WHERE broadcast_id=?1 AND status='sending' AND updated_at < ?3`).bind(b.id, now, now - STUCK_S),
    db.prepare(`UPDATE broadcasts SET failed=failed+changes(), updated_at=?2 WHERE id=?1 AND changes() > 0`).bind(b.id, now),
    db.prepare(
      `UPDATE broadcasts SET status='finished', finished_at=?2, updated_at=?2 WHERE id=?1 AND status='running'
         AND NOT EXISTS (SELECT 1 FROM broadcast_recipients WHERE broadcast_id=?1 AND status IN ('queued','sending'))`,
    ).bind(b.id, now),
  )
  // Anyone who opted out after the candidate select was refused by the claim above: settle them as skipped now, not a minute later.
  endStmts.unshift(db.prepare(
    `UPDATE broadcast_recipients SET status='skipped', error_message='opted out', updated_at=?2
      WHERE broadcast_id=?1 AND status='queued' AND contact_id IN (SELECT CAST(id AS TEXT) FROM contacts WHERE opted_out_at IS NOT NULL)`,
  ).bind(b.id, now))
  const endRes = await db.batch(endStmts)
  out.skipped += endRes[0]!.meta.changes ?? 0
  if (out.sent || out.failed || out.unknown || out.skipped || out.paused) await progress()
  return finish()
}
