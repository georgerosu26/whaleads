import { logEvent } from './db'
// Conversation state (one row per contact), maintained by the shared pipeline and the send path.
// unread_count only moves inside the same batch as a NEW message row, so a replayed or doubly delivered
// wamid (both webhook routes during cutover) can never double it.

export const WINDOW_SECONDS = 24 * 3600

/** First 140 characters of the body, or "[type]" for media-only messages. */
export function previewOf(type: string | null | undefined, body: string | null | undefined): string {
  const b = (body ?? '').trim()
  return (b || `[${type || 'message'}]`).slice(0, 140)
}

/** The customer-service window is open while the last inbound message is under 24h old (strict). */
export function windowState(lastInboundAt: number | null | undefined, now = Math.floor(Date.now() / 1000)) {
  if (lastInboundAt == null) return { window_open: false, window_closes_at: null as number | null }
  const closes = lastInboundAt + WINDOW_SECONDS
  return { window_open: now - lastInboundAt < WINDOW_SECONDS, window_closes_at: closes }
}

/**
 * Upsert for a freshly inserted INBOUND message. Must directly follow the message INSERT OR IGNORE in the
 * same batch: `WHERE changes() > 0` makes it a no-op for a duplicate wamid. An upsert reports one change,
 * so the lead statement after it can still read changes() as "the message was new".
 */
export function inboundConversation(db: D1Database, contactId: number, timestamp: number, preview: string) {
  return db.prepare(
    `INSERT INTO conversations (contact_id,last_message_at,last_inbound_at,last_preview,unread_count)
     SELECT ?1,?2,?2,?3,1 WHERE changes() > 0
     ON CONFLICT(contact_id) DO UPDATE SET
       last_preview = CASE WHEN excluded.last_message_at >= last_message_at THEN excluded.last_preview ELSE last_preview END,
       last_message_at = MAX(last_message_at, excluded.last_message_at),
       last_inbound_at = MAX(COALESCE(last_inbound_at,0), excluded.last_inbound_at),
       unread_count = unread_count + 1,
       status = 'open'`,
  ).bind(contactId, timestamp, preview)
}

/** Same, for an OUTBOUND message: no unread, does not reopen, keeps last_inbound_at. Follows the message INSERT. */
export function outboundConversation(db: D1Database, contactId: number, timestamp: number, preview: string) {
  return db.prepare(
    `INSERT INTO conversations (contact_id,last_message_at,last_preview)
     SELECT ?1,?2,?3 WHERE changes() > 0
     ON CONFLICT(contact_id) DO UPDATE SET
       last_preview = CASE WHEN excluded.last_message_at >= last_message_at THEN excluded.last_preview ELSE last_preview END,
       last_message_at = MAX(last_message_at, excluded.last_message_at)`,
  ).bind(contactId, timestamp, preview)
}

/** First staff reply stamps first_response_at on the contact's newest open lead, once the contact has written in. */
export function firstResponse(db: D1Database, contactId: number) {
  return db.prepare(
    `UPDATE leads SET first_response_at = unixepoch()
     WHERE id = (SELECT id FROM leads WHERE contact_id=?1 AND status NOT IN (SELECT key FROM stages WHERE kind <> 'open')
                 ORDER BY created_at DESC, id DESC LIMIT 1) AND first_response_at IS NULL
       AND EXISTS (SELECT 1 FROM conversations cv WHERE cv.contact_id=?1 AND cv.last_inbound_at >= leads.created_at - 300)`,
  ).bind(contactId)
}

/**
 * The outbound message row. Its status starts from the best status webhook already recorded for this wamid, because
 * with respond-before-batch a `delivered` receipt can land before this insert runs (the webhook then only stored it in
 * message_statuses). 'failed' wins, otherwise the highest of read > delivered > sent. Must stay the batch's first statement.
 */
export function outboundMessageInsert(db: D1Database, contactId: number, wamid: string | null | undefined, type: string, body: string | null, mediaId: string | null, ts: number, origin: string | null = null) {
  // A queued send has no wamid, so a retry after a commit whose acknowledgement was lost cannot be caught by the UNIQUE
  // wamid: the guard refuses a second identical null-wamid row (same contact, body and second).
  return db.prepare(
    `INSERT OR IGNORE INTO messages (contact_id,direction,wamid,type,body,media_id,status,timestamp,origin)
     SELECT ?1, 'out', ?2, ?3, ?4, ?5,
       COALESCE((SELECT status FROM message_statuses WHERE wamid = ?2
                 ORDER BY (status='failed') DESC, CASE status WHEN 'read' THEN 3 WHEN 'delivered' THEN 2 WHEN 'sent' THEN 1 ELSE 0 END DESC LIMIT 1), 'sent'),
       ?6, ?7
     WHERE ?2 IS NOT NULL OR NOT EXISTS (SELECT 1 FROM messages WHERE contact_id = ?1 AND direction = 'out' AND wamid IS NULL AND body IS ?4 AND timestamp = ?6)`,
  ).bind(contactId, wamid ?? null, type, body, mediaId, ts, origin)
}

/** What a repair needs to re-create a send whose deferred insert failed twice. */
export interface SendRecord {
  wamid: string | null | undefined; contact_id: number; type: string; body: string | null; media_id: string | null; ts: number
  media?: { mime: string; filename: string; size: number }
  /** 'flow:<id>' for automation sends; replayed by the repair job. */
  origin?: string | null
}

/**
 * Run the post-send writes after the reply: waitUntil in production, awaited when there is no context (scripts, tests).
 * One retry after ~500 ms, then a `send_record_error` event (and console.error) carrying the whole record, which the
 * cron (repairSendRecords in media.ts) replays: INSERT OR IGNORE on the wamid makes that safe.
 */
export function deferRecord(env: { DB: D1Database }, ctx: Pick<ExecutionContext, 'waitUntil'> | undefined, rec: SendRecord, work: () => Promise<unknown>, retryMs = 500): Promise<void> | void {
  const run = async () => {
    try { await work() } catch {
      await new Promise((r) => setTimeout(r, retryMs))
      try { await work() } catch (e) {
        const payload = { ...rec, wamid: rec.wamid ?? null, error: String(e).slice(0, 300) }
        console.error('send_record_error', JSON.stringify(payload))
        await logEvent(env.DB, 'send_record_error', payload).catch(() => {})
      }
    }
  }
  if (ctx) { ctx.waitUntil(run()); return }
  return run()
}
