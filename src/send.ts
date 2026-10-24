// the ONE outbound send path. The inbox routes (text, media, template), the legacy /api/send and the flow nodes
// (message, template) all call these functions, so every send enforces the same rules in the same order:
//   contact + destination -> 24 h window (text and media only; a template ignores it) -> adaptor call -> deferred
//   record (message row, conversation touch, first response) -> live publish. Timing is recorded by the adaptor's
//   timedFetch (AsyncLocalStorage), so no caller needs to pass anything for it.
// Callers translate the result: routes into their JSON envelopes, nodes into ports. Nothing here knows about HTTP.
import type { Env } from './db'
import { resolveActiveCached } from './adaptors'
import type { AdaptorResult, SendResult, TemplateHeaderSend } from './adaptors/types'
import { deferRecord, firstResponse, outboundConversation, outboundMessageInsert, previewOf } from './conversations'
import { publishMessage } from './live' // D20
import { sendMediaFile, type OutboundFile } from './media'
import { sendTarget } from './sendTarget'
import { safeComponents, sendability, type TemplateRow } from './templates'

type Waiter = Pick<ExecutionContext, 'waitUntil'> | undefined

export interface SendOpts {
  /** The request, so the inbox routes can reuse the target lookup they started in parallel with the session check. */
  req?: Request
  /** Used for the deferred record and the live publish. */
  ctx?: Waiter
  /** Await the message row before returning instead of deferring it (flow sends: the next node may read it). */
  awaitRecord?: boolean
  /** 'flow:<id>' for automation sends. Stored on the message row; an origin also skips first_response (reports measure humans). */
  origin?: string | null
}

/** The send was refused before anything left the building: no contact, window closed, or no adaptor. */
export interface Refused { ok: false; kind: 'refused'; code: 'contact_not_found' | 'window_closed' | 'no_adaptor'; message: string; response: Response }
/** The gateway or Meta answered with an error. `result` keeps their object verbatim for the route's envelope. */
export interface Upstream { ok: false; kind: 'upstream'; stage?: 'upload' | 'send'; message: string; result: AdaptorResult }
export type SendFail = Refused | Upstream

export interface Sent { ok: true; wamid: string | null; /** Unix seconds recorded on the message row. */ now: number; /** Set when the gateway queued the send instead of sending it. */ queued: string | null }

/** WhaBuzz answers 202 { status:'queued', id:'qmsg_...' } when it accepted but has not sent yet. */
export const queuedId = (r: { status: number; data?: any }): string | null =>
  r.status === 202 || r.data?.status === 'queued' ? (typeof r.data?.id === 'string' ? r.data.id : 'queued') : null

const refusedResponse = (error: string, status: number, message?: string) =>
  new Response(JSON.stringify({ ok: false, error, ...(message ? { message } : {}) }), { status, headers: { 'content-type': 'application/json' } })

async function refused(res: Response): Promise<Refused> {
  let body: any = null
  try { body = await res.clone().json() } catch { /* keep the status-based code */ }
  const code = res.status === 409 ? 'window_closed' : res.status === 503 ? 'no_adaptor' : 'contact_not_found'
  return { ok: false, kind: 'refused', code, message: String(body?.message ?? body?.error ?? code), response: res }
}

const noAdaptor = () => refused(refusedResponse('no WhatsApp adaptor configured', 503))
const upstream = (r: AdaptorResult, stage?: 'upload' | 'send'): Upstream => ({ ok: false, kind: 'upstream', stage, message: r.error?.message ?? 'send failed', result: r })

/** Resolves the destination (and the window, unless `ignoreWindow`) and the active adaptor. */
async function open(env: Env, contactId: number, o: SendOpts, ignoreWindow: boolean) {
  const target = await sendTarget(env, contactId, o.req, ignoreWindow)
  if (target instanceof Response) return refused(target)
  const active = await resolveActiveCached(env, target.cfgVersion)
  if (!active) return noAdaptor()
  return { dest: target.dest, adaptor: active.adaptor }
}

const nowSec = () => Math.floor(Date.now() / 1000)

// ---- text --------------------------------------------------------------------------------------------------

export async function sendTextToContact(env: Env, contactId: number, text: string, o: SendOpts = {}): Promise<Sent | SendFail> {
  const t = await open(env, contactId, o, false)
  if ('ok' in t) return t
  const r: SendResult = await t.adaptor.sendText(t.dest, text)
  if (!r.ok) return upstream(r)
  const now = nowSec()
  const wamid = r.wamid
  const origin = o.origin ?? null
  // Reply as soon as the upstream accepted; the row, conversation touch and first_response are written after the response.
  // The poll brings the row (the UI reconciles by wamid); a status webhook that wins the race is folded in by the insert.
  await deferRecord(env, o.awaitRecord ? undefined : o.ctx, { wamid, contact_id: contactId, type: 'text', body: text, media_id: null, ts: now, origin }, async () => {
    const res = await env.DB.batch([
      outboundMessageInsert(env.DB, contactId, wamid, 'text', text, null, now, origin),
      outboundConversation(env.DB, contactId, now, previewOf('text', text)),
      ...(origin ? [] : [firstResponse(env.DB, contactId)]),
    ])
    // D20: after the batch succeeded, so the row exists when the browser hears of it; a retry that found it already there stays silent.
    if (res[0]?.meta.changes) publishMessage(env, o.ctx, contactId, { id: res[0].meta.last_row_id as number })
  })
  return { ok: true, wamid, now, queued: queuedId(r) }
}

// ---- media -------------------------------------------------------------------------------------------------

export type MediaSent = Sent & { /** The file reached R2 binding-wise (the copy is stored by the deferred record). */ stored: boolean }

/** `file` is already validated (type, size, sniff) by the caller. */
export async function sendMediaToContact(env: Env, contactId: number, file: OutboundFile, o: SendOpts = {}): Promise<MediaSent | SendFail> {
  const t = await open(env, contactId, o, false)
  if ('ok' in t) return t
  const out = await sendMediaFile(t.adaptor, t.dest, file)
  if (!out.ok) return upstream(out.result, out.stage)
  const now = nowSec()
  const stored = !!env.MEDIA
  const wamid = out.wamid
  const origin = o.origin ?? null
  const caption = file.caption ?? ''
  // Store the file FIRST (random key, independent of the row id), and only then insert the message + media row, so a poll
  // can never see a 'stored' row whose object is not in R2 yet. A retry re-puts the same key.
  const r2Key = `o/${crypto.randomUUID()}`
  await deferRecord(env, o.awaitRecord ? undefined : o.ctx, { wamid, contact_id: contactId, type: file.kind, body: caption || null, media_id: out.mediaId, ts: now, origin, media: { mime: file.mime, filename: file.filename, size: file.bytes.byteLength } }, async () => {
    let status = 'failed', key: string | null = null, lastError: string | null = 'r2_unbound'
    if (env.MEDIA) {
      try { await env.MEDIA.put(r2Key, file.bytes, { httpMetadata: { contentType: file.mime } }); status = 'stored'; key = r2Key; lastError = null } catch (e) { lastError = String(e).slice(0, 300) }
    }
    const res = await env.DB.batch([
      outboundMessageInsert(env.DB, contactId, wamid, file.kind, caption || null, out.mediaId, now, origin),
      // Keyed by the new message row (last_insert_rowid), not the wamid, which a queued send does not have yet.
      env.DB.prepare(
        `INSERT OR IGNORE INTO media (message_id, media_id, r2_key, mime, filename, size, status, last_error, stored_at)
         SELECT last_insert_rowid(), ?1, ?2, ?3, ?4, ?5, ?6, ?7, ${status === 'stored' ? 'unixepoch()' : 'NULL'} WHERE changes() > 0`,
      ).bind(out.mediaId, key, file.mime, file.filename, file.bytes.byteLength, status, lastError),
      outboundConversation(env.DB, contactId, now, previewOf(file.kind, caption)),
      ...(origin ? [] : [firstResponse(env.DB, contactId)]),
    ])
    if (res[0]?.meta.changes) publishMessage(env, o.ctx, contactId, { id: res[0].meta.last_row_id as number }) // D20, after the batch
  })
  return { ok: true, wamid, now, queued: queuedId(out.send), stored }
}

// ---- template ----------------------------------------------------------------------------------------------

export interface TemplateMedia { bytes: Uint8Array; mime: string; filename: string; /** R2 key of an already stored copy; null for a fresh upload. */ key: string | null }

export interface TemplateInput {
  bodyParams: string[]
  headerParams: string[]
  /** Required when the template's header is IMAGE / VIDEO / DOCUMENT. */
  media: TemplateMedia | null
  /** The rendered text recorded on the message row (header + body with the values filled in). */
  text: string
}

export type TemplateSent = Sent & { text: string; mediaId: string | null }

/**
 * Sends an approved template. The caller has already validated the template, the value counts and the header media
 * (the route and the template node differ in how they report that). A template ignores the 24 h window.
 */
export async function sendTemplateToContact(env: Env, contactId: number, t: TemplateRow, input: TemplateInput, o: SendOpts = {}): Promise<TemplateSent | SendFail> {
  const target = await open(env, contactId, o, true)
  if ('ok' in target) return target
  const { media, bodyParams, headerParams, text } = input
  const fmt = t.header_format
  let header: TemplateHeaderSend | undefined, mediaId: string | null = null
  if (media) {
    const up = await target.adaptor.uploadMedia(media.bytes, media.mime)
    mediaId = up.data?.id ?? null
    if (!up.ok || !mediaId) return upstream(up.ok ? { ...up, ok: false, error: { source: 'network', error: up.data, message: 'upload returned no media id' } } : up, 'upload')
    header = { format: fmt as 'IMAGE' | 'VIDEO' | 'DOCUMENT', mediaId, filename: fmt === 'DOCUMENT' ? media.filename : undefined }
  } else if (fmt === 'TEXT' && headerParams.length) header = { format: 'TEXT', params: headerParams }
  const r = await target.adaptor.sendTemplate(target.dest, t.name, t.language, bodyParams, header)
  if (!r.ok) return upstream(r, 'send')

  const now = nowSec()
  const wamid = r.wamid
  const origin = o.origin ?? null
  const newKey = media && !media.key ? `o/${crypto.randomUUID()}` : null
  await deferRecord(env, o.awaitRecord ? undefined : o.ctx, { wamid, contact_id: contactId, type: 'template', body: text, media_id: mediaId, ts: now, origin, ...(media ? { media: { mime: media.mime, filename: media.filename, size: media.bytes.byteLength } } : {}) }, async () => {
    const stmts = [outboundMessageInsert(env.DB, contactId, wamid, 'template', text, mediaId, now, origin)]
    if (media) {
      let status = 'failed', key: string | null = null, lastError: string | null = 'r2_unbound'
      if (media.key) { status = 'stored'; key = media.key; lastError = null }
      else if (env.MEDIA && newKey) {
        try { await env.MEDIA.put(newKey, media.bytes, { httpMetadata: { contentType: media.mime } }); status = 'stored'; key = newKey; lastError = null } catch (e) { lastError = String(e).slice(0, 300) }
      }
      stmts.push(env.DB.prepare(
        `INSERT OR IGNORE INTO media (message_id, media_id, r2_key, mime, filename, size, status, last_error, stored_at)
         SELECT last_insert_rowid(), ?1, ?2, ?3, ?4, ?5, ?6, ?7, ${status === 'stored' ? 'unixepoch()' : 'NULL'} WHERE changes() > 0`,
      ).bind(mediaId, key, media.mime, media.filename, media.bytes.byteLength, status, lastError))
    }
    stmts.push(outboundConversation(env.DB, contactId, now, previewOf('template', text)), ...(origin ? [] : [firstResponse(env.DB, contactId)]))
    const res = await env.DB.batch(stmts)
    if (res[0]?.meta.changes) publishMessage(env, o.ctx, contactId, { id: res[0].meta.last_row_id as number })
  })
  return { ok: true, wamid, now, queued: queuedId(r), text, mediaId }
}

// ---- template, prepared (broadcasts) -------------------------------------------------------------------------

export interface PreparedTemplate {
  name: string
  language: string
  bodyParams: string[]
  headerParams: string[]
  /** Already uploaded (once per broadcast). Set for IMAGE / VIDEO / DOCUMENT headers. */
  header: TemplateHeaderSend | null
  /** The rendered text recorded on the message row. */
  text: string
}

export type PreparedSent = { ok: true; wamid: string | null; now: number; queued: string | null; statements: D1PreparedStatement[] } | { ok: false; result: AdaptorResult }

/**
 * The broadcast send: no target lookup (the destination comes from the claim), no upload, no deferral. Returns the
 * message row + conversation touch as statements for the caller's own batch, which also settles the recipient row, so one
 * D1 call records a send. No first_response (an origin marks it automated) and no live publish (the step publishes once).
 */
export async function sendTemplatePrepared(env: Env, adaptor: { sendTemplate: (to: string, name: string, lang: string, params: string[], header?: TemplateHeaderSend) => Promise<SendResult> }, contactId: number, dest: string, t: PreparedTemplate, origin: string): Promise<PreparedSent> {
  const header = t.header ?? (t.headerParams.length ? ({ format: 'TEXT', params: t.headerParams } as TemplateHeaderSend) : undefined)
  const r = await adaptor.sendTemplate(dest, t.name, t.language, t.bodyParams, header)
  if (!r.ok) return { ok: false, result: r }
  const now = nowSec()
  return {
    ok: true, wamid: r.wamid, now, queued: queuedId(r),
    statements: [
      outboundMessageInsert(env.DB, contactId, r.wamid, 'template', t.text, null, now, origin),
      outboundConversation(env.DB, contactId, now, previewOf('template', t.text)),
    ],
  }
}

// ---- template lookup for automation -------------------------------------------------------------------------

export type TemplateLookup = { ok: true; template: TemplateRow } | { ok: false; code: 'template_not_found' | 'template_not_sendable' | 'template_not_approved'; message: string }

/** An approved, sendable template by id, or by name when the id is not found (a graph may carry either). */
export async function loadSendableTemplate(env: Env, ref: { id?: unknown; name?: unknown; language?: unknown }, allowAuth = false): Promise<TemplateLookup> {
  const id = typeof ref.id === 'string' ? ref.id : ref.id != null ? String(ref.id) : ''
  const name = typeof ref.name === 'string' ? ref.name : ''
  let t = id ? await env.DB.prepare(`SELECT * FROM templates WHERE id=?`).bind(id).first<TemplateRow>() : null
  const language = typeof ref.language === 'string' ? ref.language : ''
  if (!t && name) t = language
    ? await env.DB.prepare(`SELECT * FROM templates WHERE name=? AND language=?`).bind(name, language).first<TemplateRow>()
    : await env.DB.prepare(`SELECT * FROM templates WHERE name=? AND status='APPROVED' ORDER BY updated_at DESC LIMIT 1`).bind(name).first<TemplateRow>()
  if (!t) return { ok: false, code: 'template_not_found', message: 'The template no longer exists.' }
  // allowAuth is passed by src/otp.ts only: it then accepts AUTHENTICATION templates and nothing else.
  if (allowAuth && t.category !== 'AUTHENTICATION') return { ok: false, code: 'template_not_sendable', message: 'Only authentication templates can be sent as one-time codes.' }
  const sb = allowAuth ? { sendable: true, reason: null } : sendability(safeComponents(t.components), t.category)
  if (!sb.sendable) return { ok: false, code: 'template_not_sendable', message: sb.reason ?? 'This template cannot be sent.' }
  if (t.status !== 'APPROVED') return { ok: false, code: 'template_not_approved', message: `This template is ${t.status.toLowerCase()}, so it cannot be sent.` }
  return { ok: true, template: t }
}

/** The template's own stored sample as header media (the default for a media header). */
export async function sampleHeaderMedia(env: Env, t: TemplateRow): Promise<{ ok: true; media: TemplateMedia } | { ok: false; code: string; message: string }> {
  if (!t.header_media_r2_key) return { ok: false, code: 'header_media_missing', message: 'This template needs a header file and has no sample stored.' }
  if (!env.MEDIA) return { ok: false, code: 'storage_unavailable', message: 'File storage is not set up, so the template sample cannot be reused.' }
  const obj = await env.MEDIA.get(t.header_media_r2_key)
  if (!obj) return { ok: false, code: 'header_media_missing', message: 'The stored sample file is no longer in storage.' }
  return { ok: true, media: { bytes: new Uint8Array(await obj.arrayBuffer()), mime: t.header_media_mime ?? 'application/octet-stream', filename: 'header', key: t.header_media_r2_key } }
}
