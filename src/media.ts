// Message media (plan C4). Inbound files are copied from Meta to R2 on receipt (`storeMedia`), retried by
// the cron (`retryPending`), and served to staff through GET /api/media/:messageId (`serveMedia`). Outbound
// files are validated, uploaded to Meta and sent by `sendMediaFile`, and kept in R2 as well.
//
// Without the R2 binding (`env.MEDIA`, e.g. a free account with no card) nothing is stored: rows stay
// `pending`, the cron skips them, and serveMedia proxies the file live from Meta on every request.
import type { Env } from './db'
import { logEvent } from './db'
import { resolveActive } from './adaptors'
import { firstResponse, outboundConversation, outboundMessageInsert, previewOf, type SendRecord } from './conversations'
import type { AdaptorResult, MediaKind, MetaAdaptor, SendResult } from './adaptors/types'

export const MAX_INBOUND_BYTES = 25 * 1024 * 1024
export const MAX_ATTEMPTS = 5
export const CRON_BATCH = 10
/** Meta's own per-type caps, with the document cap lowered to 16 MB. */
export const OUTBOUND_LIMITS: Record<MediaKind, number> = { image: 5 * 1024 * 1024, audio: 16 * 1024 * 1024, video: 16 * 1024 * 1024, document: 16 * 1024 * 1024 }
/** Hard ceiling for the multipart body before it is parsed (largest file plus form overhead). */
export const MAX_UPLOAD_BODY = 17 * 1024 * 1024

/** Meta message types that carry a file. */
export const MEDIA_TYPES = new Set(['image', 'document', 'audio', 'video', 'sticker'])

// What staff may send. The allowlist is Meta's, minus webp images (WhatsApp accepts webp only as stickers).
const OUT_ALLOWED: [MediaKind, RegExp][] = [
  ['image', /^image\/(jpeg|png)$/],
  ['video', /^video\/(mp4|3gpp)$/],
  ['audio', /^audio\/(aac|mp4|mpeg|amr|ogg)$/],
  ['document', /^(application\/pdf|application\/(msword|vnd\.ms-excel|vnd\.ms-powerpoint|vnd\.openxmlformats-officedocument\.[a-z.]+)|text\/plain)$/],
]
/** Shown inline by the browser. Everything else is served as an `application/octet-stream` attachment. SVG and HTML are never here. */
const INLINE = /^(image\/(jpeg|png|webp|gif)|audio\/(aac|mp4|mpeg|amr|ogg|opus|webm)|video\/(mp4|3gpp|webm))$/

export const cleanMime = (m: string | null | undefined) => (m ?? '').split(';')[0]!.trim().toLowerCase()
export const isInlineMime = (m: string | null | undefined) => INLINE.test(cleanMime(m))
export function outboundKind(mime: string): MediaKind | null {
  const m = cleanMime(mime)
  return OUT_ALLOWED.find(([, re]) => re.test(m))?.[0] ?? null
}
export const mediaKey = (messageId: number) => `m/${messageId}`

export function safeFilename(name: string | null | undefined, fallback = 'file'): string {
  const n = (name ?? '').replace(/[\\/]+/g, '-').replace(/[^\p{L}\p{N}._ -]+/gu, '-').replace(/^[.\s-]+/, '').trim().slice(0, 100)
  return n || fallback
}

/** Cheap magic-byte check so a renamed file cannot pass as an image or PDF. Other types are accepted on declared type. */
export function sniffOk(mime: string, head: Uint8Array): boolean {
  const m = cleanMime(mime)
  const starts = (...b: number[]) => b.every((v, i) => head[i] === v)
  if (m === 'image/jpeg') return starts(0xff, 0xd8, 0xff)
  if (m === 'image/png') return starts(0x89, 0x50, 0x4e, 0x47)
  if (m === 'application/pdf') return starts(0x25, 0x50, 0x44, 0x46)
  return true
}

/** INSERT for the inbound media row; goes in the same batch as the message, after it. A replayed wamid inserts nothing. */
export function inboundMediaRow(db: D1Database, wamid: string, mediaId: string, mime: string | null, filename: string | null) {
  return db.prepare(
    `INSERT OR IGNORE INTO media (message_id, media_id, mime, filename, status)
     SELECT id, ?2, ?3, ?4, 'pending' FROM messages WHERE wamid = ?1`,
  ).bind(wamid, mediaId, mime ? cleanMime(mime) : null, filename ? safeFilename(filename) : null)
}

/** Reads a stream into memory, or returns null (and cancels the stream) as soon as it passes `cap` bytes. */
export async function readCapped(stream: ReadableStream<Uint8Array>, cap: number): Promise<Uint8Array | null> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > cap) { await reader.cancel().catch(() => {}); return null }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) { out.set(c, at); at += c.byteLength }
  return out
}

export type StoreOutcome = 'stored' | 'too_large' | 'retry' | 'failed' | 'skipped' | 'noop'

/**
 * Copy one pending inbound file from Meta into R2. Safe to run twice at once or to repeat: every write is
 * guarded by `status='pending'`, and the R2 key is fixed per message, so the worst case is a second download.
 */
export async function storeMedia(env: Env, messageId: number, adaptor?: MetaAdaptor): Promise<StoreOutcome> {
  if (!env.MEDIA) return 'skipped'
  const row = await env.DB.prepare(`SELECT media_id, mime FROM media WHERE message_id=? AND status='pending'`).bind(messageId).first<{ media_id: string | null; mime: string | null }>()
  if (!row?.media_id) return 'noop'
  // A transient failure (no adaptor, 401, 429, 5xx, network) records the error but does not use up an attempt,
  // so a long upstream outage cannot permanently fail files that were never actually refused.
  const fail = async (why: string, transient = false): Promise<StoreOutcome> => {
    if (transient) {
      await env.DB.prepare(`UPDATE media SET last_error=?2 WHERE message_id=?1 AND status='pending'`).bind(messageId, why.slice(0, 300)).run()
      return 'retry'
    }
    const r = await env.DB.prepare(
      `UPDATE media SET attempts = attempts + 1, last_error = ?2,
         status = CASE WHEN attempts + 1 >= ?3 THEN 'failed' ELSE 'pending' END
       WHERE message_id=?1 AND status='pending' RETURNING status`,
    ).bind(messageId, why.slice(0, 300), MAX_ATTEMPTS).first<{ status: string }>()
    return r?.status === 'failed' ? 'failed' : 'retry'
  }
  try {
    const ad = adaptor ?? (await resolveActive(env))?.adaptor
    if (!ad) return await fail('no WhatsApp adaptor configured', true)
    const f = await ad.fetchMedia(row.media_id)
    if (!f.ok) return await fail(f.error.message, f.status === 0 || f.status === 401 || f.status === 429 || f.status >= 500)
    const bytes = await readCapped(f.bytes, MAX_INBOUND_BYTES)
    if (!bytes) {
      await env.DB.prepare(`UPDATE media SET status='too_large', last_error=NULL WHERE message_id=? AND status='pending'`).bind(messageId).run()
      return 'too_large'
    }
    const got = cleanMime(f.mime)
    const mime = got && got !== 'application/octet-stream' ? got : (row.mime ?? 'application/octet-stream')
    const key = mediaKey(messageId)
    await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: mime } })
    await env.DB.prepare(
      `UPDATE media SET status='stored', r2_key=?2, size=?3, mime=?4, last_error=NULL, stored_at=unixepoch() WHERE message_id=?1 AND status='pending'`,
    ).bind(messageId, key, bytes.byteLength, mime).run()
    return 'stored'
  } catch (e) {
    return await fail(String(e))
  }
}

/** storeMedia by wamid, for the webhook pipeline (it knows the wamid, not the row id). */
export async function storeMediaForWamid(env: Env, wamid: string): Promise<void> {
  const m = await env.DB.prepare(`SELECT id FROM messages WHERE wamid=?`).bind(wamid).first<{ id: number }>()
  if (m) await storeMedia(env, m.id)
}

/** Cron: retry pending files, oldest first, at most CRON_BATCH per run (free-plan subrequest budget). */
export async function retryPending(env: Env, adaptor?: MetaAdaptor): Promise<Record<StoreOutcome, number>> {
  const tally: Record<StoreOutcome, number> = { stored: 0, too_large: 0, retry: 0, failed: 0, skipped: 0, noop: 0 }
  if (!env.MEDIA) return tally
  // Backoff without a new column: a row with N counted attempts is eligible once it is old enough that the
  // cumulative waits 15m, 1h, 6h, 24h (900, 4500, 26100, 112500 s after creation) have passed.
  const { results } = await env.DB.prepare(
    `SELECT message_id FROM media WHERE status='pending' AND attempts < ?1 AND media_id IS NOT NULL
       AND unixepoch() - created_at >= CASE attempts WHEN 0 THEN 0 WHEN 1 THEN 900 WHEN 2 THEN 4500 WHEN 3 THEN 26100 ELSE 112500 END
     ORDER BY message_id LIMIT ?2`,
  ).bind(MAX_ATTEMPTS, CRON_BATCH).all<{ message_id: number }>()
  for (const r of results) tally[await storeMedia(env, r.message_id, adaptor)]++
  return tally
}

/** Cron housekeeping: expired sessions and stale rate-limit rows (the longest window is 15 minutes). */
export async function purgeExpired(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).bind(now),
    env.DB.prepare(`DELETE FROM rate_limits WHERE window_start < ?`).bind(now - 24 * 3600),
  ])
}

/**
 * Replays outbound sends whose deferred insert failed twice (send_record_error events of the last 7 days with a wamid).
 * INSERT OR IGNORE on the wamid makes a repeat harmless. A media send is re-created as a `pending` media row carrying
 * its Meta media_id, so serving fetches it from Meta (the cron then copies it to R2). Each event is marked repaired.
 */
export async function repairSendRecords(env: Env): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT id, payload FROM events WHERE kind='send_record_error' AND created_at >= unixepoch() - 7*86400 ORDER BY id LIMIT 20`,
  ).all<{ id: number; payload: string }>()
  let n = 0
  for (const ev of results) {
    let r: SendRecord
    try { r = JSON.parse(ev.payload) } catch { continue }
    if (!r?.wamid || !r.contact_id || !r.ts) continue
    const stmts = [
      outboundMessageInsert(env.DB, r.contact_id, r.wamid, r.type, r.body, r.media_id, r.ts, r.origin ?? null),
      outboundConversation(env.DB, r.contact_id, r.ts, previewOf(r.type, r.body ?? '')),
      // Automation sends (origin flow:<id>) never count as the first human response.
      ...(r.origin ? [] : [firstResponse(env.DB, r.contact_id)]),
    ]
    if (r.media_id && r.media) stmts.push(inboundMediaRow(env.DB, r.wamid, r.media_id, r.media.mime, r.media.filename))
    stmts.push(env.DB.prepare(`UPDATE events SET kind='send_record_repaired' WHERE id=?`).bind(ev.id))
    await env.DB.batch(stmts)
    n++
  }
  return n
}

export async function scheduled(env: Env): Promise<void> {
  try {
    await purgeExpired(env)
    const fixed = await repairSendRecords(env)
    if (fixed) await logEvent(env.DB, 'send_record_repair_run', { count: fixed })
    const t = await retryPending(env)
    if (t.stored || t.failed || t.too_large) await logEvent(env.DB, 'media_cron', t)
  } catch (e) {
    await logEvent(env.DB, 'media_cron_error', { error: String(e) })
  }
}

// ---- serving ---------------------------------------------------------------------------------------

/** Safe response headers. Uploaded HTML/SVG can never run on the app origin: only allowlisted image/audio/video is inline. */
export function mediaHeaders(mime: string | null, filename: string | null, extra: Record<string, string> = {}): Headers {
  const inline = isInlineMime(mime)
  const h = new Headers({
    'Content-Type': inline ? cleanMime(mime) : 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': 'sandbox',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'private, no-store',
    'Accept-Ranges': 'bytes',
    ...extra,
  })
  if (inline) h.set('Content-Disposition', 'inline')
  else {
    const name = safeFilename(filename)
    const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
    h.set('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`)
  }
  return h
}

const gone = (error: string, reason: string) =>
  new Response(JSON.stringify({ ok: false, error, reason }), { status: 410, headers: { 'content-type': 'application/json' } })
const plain = (status: number, error: string) =>
  new Response(JSON.stringify({ ok: false, error }), { status, headers: { 'content-type': 'application/json' } })

/** `bytes=a-b`, `bytes=a-`, `bytes=-n` against a known size. null = no/ignored range, 'bad' = unsatisfiable. */
export function parseRange(h: string | null, size: number): { offset: number; length: number } | 'bad' | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec((h ?? '').trim())
  if (!m || (m[1] === '' && m[2] === '')) return null
  let start: number, end: number
  if (m[1] === '') { const n = Number(m[2]); if (!n) return 'bad'; start = Math.max(0, size - n); end = size - 1 }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1) }
  if (start >= size || end < start) return 'bad'
  return { offset: start, length: end - start + 1 }
}

export async function serveMedia(req: Request, env: Env, ctx: ExecutionContext, messageId: number, adaptor?: MetaAdaptor): Promise<Response> {
  const row = await env.DB.prepare(`SELECT media_id, r2_key, mime, filename, size, status, last_error FROM media WHERE message_id=?`).bind(messageId)
    .first<{ media_id: string | null; r2_key: string | null; mime: string | null; filename: string | null; size: number | null; status: string; last_error: string | null }>()
  if (!row) return plain(404, 'not found')
  const head = req.method === 'HEAD'

  if (row.status === 'too_large') return gone('too_large', 'This file is over 25 MB, so it was not copied. It is only on the customer\'s phone.')
  if (row.status === 'failed') return gone('unavailable', 'This file could not be copied from WhatsApp. It is only on the customer\'s phone.')

  if (row.status === 'stored' && row.r2_key && env.MEDIA) {
    const size = row.size ?? 0
    const range = size ? parseRange(req.headers.get('Range'), size) : null
    if (range === 'bad') return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
    const obj = await env.MEDIA.get(row.r2_key, range ? { range } : undefined)
    if (!obj) return gone('unavailable', 'This file is no longer in storage.')
    if (range) {
      const h = mediaHeaders(row.mime, row.filename, { 'Content-Length': String(range.length), 'Content-Range': `bytes ${range.offset}-${range.offset + range.length - 1}/${size}` })
      return new Response(head ? null : (obj as R2ObjectBody).body, { status: 206, headers: h })
    }
    return new Response(head ? null : (obj as R2ObjectBody).body, { headers: mediaHeaders(row.mime, row.filename, size ? { 'Content-Length': String(size) } : {}) })
  }

  // pending, or stored but R2 is not bound here: proxy live from Meta (and keep trying to store it).
  if (!row.media_id) return gone('unavailable', 'This file is not available.')
  const ad = adaptor ?? (await resolveActive(env))?.adaptor
  if (!ad) return plain(503, 'no WhatsApp adaptor configured')
  const f = await ad.fetchMedia(row.media_id)
  if (!f.ok) return plain(502, f.error.message)
  if (env.MEDIA && row.status === 'pending') ctx.waitUntil(storeMedia(env, messageId, adaptor).then(() => {}, () => {}))
  const mime = cleanMime(f.mime) !== 'application/octet-stream' ? f.mime : (row.mime ?? f.mime)
  return new Response(head ? null : f.bytes, { headers: mediaHeaders(mime, row.filename) })
}

// ---- outbound --------------------------------------------------------------------------------------

export interface OutboundFile { bytes: Uint8Array; mime: string; kind: MediaKind; filename: string; caption?: string }
export type MediaSendOutcome =
  | { ok: true; wamid: string | null; mediaId: string; send: SendResult }
  | { ok: false; stage: 'upload' | 'send'; result: AdaptorResult }

/** The two-step send: upload the bytes, then send the returned media id. Errors keep Meta's object verbatim. */
export async function sendMediaFile(adaptor: MetaAdaptor, to: string, f: OutboundFile): Promise<MediaSendOutcome> {
  const up = await adaptor.uploadMedia(f.bytes, f.mime)
  const mediaId = up.data?.id
  if (!up.ok || !mediaId) {
    return { ok: false, stage: 'upload', result: up.ok ? { ...up, ok: false, error: { source: 'network', error: up.data, message: 'upload returned no media id' } } : up }
  }
  const send = await adaptor.sendMedia(to, { kind: f.kind, mediaId, caption: f.caption, filename: f.kind === 'document' ? f.filename : undefined })
  if (!send.ok) return { ok: false, stage: 'send', result: send }
  return { ok: true, wamid: send.wamid, mediaId, send }
}
