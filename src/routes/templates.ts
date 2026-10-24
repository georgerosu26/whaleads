// /api/templates (list, create, delete, sync, sample media) and POST /api/inbox/:id/send-template.
// Behind the auth gate in index.ts (session + CSRF, or ADMIN_KEY). Create and delete are admin-only.
import type { Actor } from '../auth'
import { require as requireRole } from '../auth'
import type { Env } from '../db'
import { resolveActive, resolveActiveCached } from '../adaptors'
import type { TemplateHeaderSend } from '../adaptors/types'
import { deferRecord, firstResponse, outboundConversation, outboundMessageInsert, previewOf } from '../conversations'
import { json } from '../leads'
import { publishMessage } from '../live'
import { MAX_UPLOAD_BODY, OUTBOUND_LIMITS, cleanMime, mediaHeaders, outboundKind, safeFilename, sniffOk } from '../media'
import { sendTemplateToContact } from '../send'
import { buildComponents, paramProblem, renderParams, validateTemplate, type HeaderFormat, type TemplateInput } from '../templateRules'
import { mapMetaError, normalizeRemote, rowJson, safeComponents, sendability, templateHeaderOk, syncTemplates, upsertStatement, type TemplateRow } from '../templates'
import { sendOtp } from '../otp'
import { readJson } from './auth'

const HEADER_ALLOWED: Record<string, string> = { IMAGE: 'a JPEG or PNG image', VIDEO: 'an MP4 video', DOCUMENT: 'a PDF' }
const KIND_OF: Record<string, 'image' | 'video' | 'document'> = { IMAGE: 'image', VIDEO: 'video', DOCUMENT: 'document' }

const upstreamFail = (r: { status: number; data?: unknown; error?: { message: string; source: string; error: any } }, stage: string, extra: Record<string, unknown> = {}) => {
  const e = r.error?.error
  const m = mapMetaError(e)
  const verbatim = (e && typeof e === 'object' && (e.error_user_msg || e.message)) || r.error?.message || 'request failed'
  return json({ ok: false, error: String(verbatim), ...m, source: r.error?.source, graph: e ?? r.data, stage, ...extra }, 502)
}

/** Validate an uploaded sample/header file against what WhatsApp takes for `format`. */
async function checkFile(file: File, format: string): Promise<{ bytes: Uint8Array; mime: string; filename: string } | Response> {
  const mime = cleanMime(file.type)
  const kind = outboundKind(mime)
  if (!kind || !templateHeaderOk(format, mime)) return json({ ok: false, error: 'unsupported_type', message: `A ${format.toLowerCase()} header takes ${HEADER_ALLOWED[format] ?? 'a supported file'}${mime ? `, not ${mime}` : ''}.`, field: 'media' }, 415)
  if (file.size === 0) return json({ ok: false, error: 'empty_file', field: 'media' }, 400)
  if (file.size > OUTBOUND_LIMITS[kind]) return json({ ok: false, error: 'file_too_large', message: `${kind[0]!.toUpperCase()}${kind.slice(1)} files can be at most ${OUTBOUND_LIMITS[kind] / 1048576} MB.`, field: 'media' }, 413)
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (!sniffOk(mime, bytes.subarray(0, 8))) return json({ ok: false, error: 'unsupported_type', message: `This file is not really ${mime}.`, field: 'media' }, 415)
  return { bytes, mime, filename: safeFilename(file.name, kind) }
}

async function parseBody(req: Request): Promise<{ data: Record<string, any>; file: File | null } | Response> {
  if ((req.headers.get('content-type') ?? '').toLowerCase().startsWith('multipart/form-data')) {
    const len = req.headers.get('content-length')
    if (len === null) return json({ ok: false, error: 'length_required', message: 'Content-Length is required for uploads.' }, 411)
    if (!Number.isFinite(Number(len)) || Number(len) > MAX_UPLOAD_BODY) return json({ ok: false, error: 'file_too_large', message: 'The file is too large.', field: 'media' }, 413)
    let form: FormData
    try { form = await req.formData() } catch { return json({ ok: false, error: 'bad multipart body' }, 400) }
    const data: Record<string, any> = {}
    const p = form.get('payload')
    if (typeof p === 'string') { try { Object.assign(data, JSON.parse(p)) } catch { return json({ ok: false, error: 'invalid JSON in payload' }, 400) } }
    for (const [k, v] of form.entries()) if (typeof v === 'string' && k !== 'payload') { try { data[k] = JSON.parse(v) } catch { data[k] = v } }
    const f = form.get('sample') ?? form.get('file')
    return { data, file: f instanceof File ? f : null }
  }
  const b = await readJson(req)
  return b ? { data: b, file: null } : json({ ok: false, error: 'invalid JSON' }, 400)
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : x == null ? '' : String(x))) : [])

async function listRoute(env: Env, url: URL): Promise<Response> {
  // Reads never sync: `?sync=1` is ignored; sync is POST /api/templates/sync only.
  const status = url.searchParams.get('status')
  const { results } = await env.DB.prepare(
    `SELECT * FROM templates ${status ? 'WHERE status = ?1' : ''} ORDER BY (status='PENDING') DESC, updated_at DESC, name LIMIT 500`,
  ).bind(...(status ? [status.toUpperCase()] : [])).all<TemplateRow>()
  const last = await env.DB.prepare(`SELECT MAX(synced_at) AS t, SUM(status='PENDING') AS pending FROM templates`).first<{ t: number | null; pending: number | null }>()
  return json({ ok: true, templates: results.map(rowJson), synced_at: last?.t ?? null, pending: last?.pending ?? 0 })
}

async function syncRoute(env: Env): Promise<Response> {
  const out = await syncTemplates(env)
  if (!out.ok) return 'noAdaptor' in out ? json({ ok: false, error: 'no WhatsApp adaptor configured' }, 503) : upstreamFail(out.result, 'sync')
  return listRouteWith(env, { ok: true, count: out.count, changed: out.changed, removed: out.removed })
}
async function listRouteWith(env: Env, extra: Record<string, unknown>): Promise<Response> {
  const res = await listRoute(env, new URL('http://x/'))
  return json({ ...(await res.json() as object), ...extra })
}

async function createRoute(req: Request, env: Env, actor: Actor | null): Promise<Response> {
  const parsed = await parseBody(req)
  if (parsed instanceof Response) return parsed
  const d = parsed.data
  const h = d.header && typeof d.header === 'object' ? d.header : null
  const format = (typeof h?.format === 'string' ? h.format.toUpperCase() : 'NONE') as HeaderFormat
  const input: TemplateInput = {
    name: typeof d.name === 'string' ? d.name.trim() : '', language: typeof d.language === 'string' ? d.language.trim() : '',
    category: typeof d.category === 'string' ? d.category.toUpperCase() : '', body: typeof d.body === 'string' ? d.body : '',
    body_samples: strs(d.body_samples), footer: typeof d.footer === 'string' ? d.footer.trim() : '',
    header: { format, text: typeof h?.text === 'string' ? h.text : undefined, text_sample: typeof h?.text_sample === 'string' ? h.text_sample : undefined },
    has_media_sample: !!parsed.file,
  }
  if (input.category === 'AUTHENTICATION') {
    const a = d.auth && typeof d.auth === 'object' ? d.auth : {}
    input.auth = {
      security_note: a.security_note === true,
      ...(a.expiry_minutes !== undefined && a.expiry_minutes !== null && a.expiry_minutes !== '' ? { expiry_minutes: Number(a.expiry_minutes) } : {}),
      ...(typeof a.button_text === 'string' && a.button_text.trim() ? { button_text: a.button_text } : {}),
      ...(typeof a.button_type === 'string' ? { button_type: a.button_type } : {}),
    }
    // Meta writes the body of an authentication template itself; a body the caller typed would be dropped silently.
    if (input.body.trim()) return json({ ok: false, error: 'An authentication template has no custom body; Meta writes the code message.', field: 'body', errors: [{ field: 'body', message: 'An authentication template has no custom body; Meta writes the code message.' }] }, 400)
    input.body = ''
  }
  const v = validateTemplate(input)
  if (v.errors.length) return json({ ok: false, error: v.errors[0]!.message, field: v.errors[0]!.field, errors: v.errors }, 400)
  let sample: { bytes: Uint8Array; mime: string; filename: string } | null = null
  if (format in KIND_OF) {
    const c = await checkFile(parsed.file!, format)
    if (c instanceof Response) return c
    sample = c
  }
  const active = await resolveActive(env)
  if (!active) return json({ ok: false, error: 'no WhatsApp adaptor configured' }, 503)
  let handle: string | undefined
  if (sample) {
    const mh = await active.adaptor.templates.mediaHandle(sample.bytes, sample.mime)
    handle = mh.data?.h
    if (!mh.ok || !handle) return upstreamFail(mh.ok ? { ...mh, error: { source: 'network', error: mh.data, message: 'media handle missing from the upload response' } } : mh, 'media_handle', { field: 'media' })
  }
  const def = { name: input.name, language: input.language, category: input.category, components: buildComponents(input, handle) }
  const r = await active.adaptor.templates.create(def)
  if (!r.ok) return upstreamFail(r, 'create')
  let key: string | null = null
  if (sample && env.MEDIA) {
    key = `t/${crypto.randomUUID()}`
    try { await env.MEDIA.put(key, sample.bytes, { httpMetadata: { contentType: sample.mime } }) } catch { key = null }
  }
  const now = Math.floor(Date.now() / 1000)
  const up = normalizeRemote({ id: r.data?.id, name: input.name, language: input.language, category: r.data?.category ?? input.category, status: r.data?.status ?? 'PENDING', components: def.components })!
  await env.DB.batch([upsertStatement(env.DB, up, now, actor?.kind === 'staff' ? actor.staff.id : null, key && sample ? { key, mime: sample.mime } : undefined)])
  const row = await env.DB.prepare(`SELECT * FROM templates WHERE name=? AND language=?`).bind(input.name, input.language).first<TemplateRow>()
  return json({ ok: true, template: rowJson(row!), warnings: v.warnings })
}

async function deleteRoute(env: Env, id: string): Promise<Response> {
  const row = await env.DB.prepare(`SELECT * FROM templates WHERE id=?`).bind(id).first<TemplateRow>()
  if (!row) return json({ ok: false, error: 'not found' }, 404)
  // A broadcast that has not finished still needs the template: refuse and say which one.
  const live = await env.DB.prepare(`SELECT id, name FROM broadcasts WHERE template_id=? AND status IN ('draft','queued','running','paused') ORDER BY created_at LIMIT 1`).bind(id).first<{ id: string; name: string }>()
  if (live) return json({ ok: false, error: 'template_in_use', message: `Broadcast "${live.name}" still uses this template. Finish or cancel it first.`, broadcast_id: live.id }, 409)
  const active = await resolveActive(env)
  if (!active) return json({ ok: false, error: 'no WhatsApp adaptor configured' }, 503)
  const r = await active.adaptor.templates.delete({ name: row.name, id: row.id.startsWith('local:') ? undefined : row.id })
  if (!r.ok && r.status !== 404) return upstreamFail(r, 'delete')
  await env.DB.prepare(`DELETE FROM templates WHERE id=?`).bind(id).run()
  return json({ ok: true })
}

async function sampleRoute(env: Env, id: string): Promise<Response> {
  const row = await env.DB.prepare(`SELECT header_media_r2_key AS k, header_media_mime AS m FROM templates WHERE id=?`).bind(id).first<{ k: string | null; m: string | null }>()
  if (!row?.k || !env.MEDIA) return json({ ok: false, error: 'not found' }, 404)
  const obj = await env.MEDIA.get(row.k)
  if (!obj) return json({ ok: false, error: 'not found' }, 404)
  return new Response(obj.body, { headers: mediaHeaders(row.m, 'sample') })
}

/** Recently sent files of one kind, for the header picker. Served through /api/media/:messageId. */
async function recentMedia(env: Env, url: URL): Promise<Response> {
  const kind = KIND_OF[(url.searchParams.get('format') ?? '').toUpperCase()]
  if (!kind) return json({ ok: false, error: 'format must be IMAGE, VIDEO or DOCUMENT', field: 'format' }, 400)
  const { results } = await env.DB.prepare(
    `SELECT m.id AS message_id, d.mime, d.filename, d.size, m.timestamp FROM media d JOIN messages m ON m.id = d.message_id
      WHERE m.direction='out' AND d.status='stored' AND d.r2_key IS NOT NULL AND d.mime LIKE ?1 ORDER BY m.id DESC LIMIT 30`,
  ).bind(kind === 'document' ? 'application/%' : `${kind}/%`).all<{ message_id: number; mime: string; filename: string | null; size: number | null; timestamp: number }>()
  // The same stored object can sit behind several messages (default header reused): show each key once.
  return json({ ok: true, files: results.slice(0, 12) })
}

async function sendTemplateRoute(req: Request, env: Env, id: number, ctx: ExecutionContext): Promise<Response> {
  const parsed = await parseBody(req)
  if (parsed instanceof Response) return parsed
  const d = parsed.data
  const tid = typeof d.template_id === 'string' ? d.template_id : d.template_id != null ? String(d.template_id) : ''
  if (!tid) return json({ ok: false, error: 'template_id required', field: 'template_id' }, 400)
  const t = await env.DB.prepare(`SELECT * FROM templates WHERE id=?`).bind(tid).first<TemplateRow>()
  if (!t) return json({ ok: false, error: 'template not found', field: 'template_id' }, 404)
  const sb = sendability(safeComponents(t.components), t.category)
  if (!sb.sendable) return json({ ok: false, error: 'template_not_sendable', message: sb.reason, field: 'template_id' }, 422)
  if (t.status !== 'APPROVED') return json({ ok: false, error: 'template_not_approved', message: `This template is ${t.status.toLowerCase()}, so it cannot be sent.`, field: 'template_id' }, 422)

  const bodyParams = strs(d.body_params), headerParams = strs(d.header_params)
  if (bodyParams.length !== t.body_params_count) return json({ ok: false, error: `This template needs ${t.body_params_count} value${t.body_params_count === 1 ? '' : 's'}, got ${bodyParams.length}.`, field: 'body_params' }, 400)
  if (headerParams.length !== t.header_params_count) return json({ ok: false, error: `The header needs ${t.header_params_count} value${t.header_params_count === 1 ? '' : 's'}, got ${headerParams.length}.`, field: 'header_params' }, 400)
  for (const [field, list] of [['body_params', bodyParams], ['header_params', headerParams]] as const) {
    for (let i = 0; i < list.length; i++) { const p = paramProblem(list[i]!); if (p) return json({ ok: false, error: `Value ${i + 1}: ${p}`, field }, 400) }
  }

  // Header media: fresh upload, else a stored outbound file (message_id), else the template's own sample.
  const fmt = t.header_format
  let media: { bytes: Uint8Array; mime: string; filename: string; key: string | null } | null = null
  if (fmt in KIND_OF) {
    if (parsed.file) {
      const c = await checkFile(parsed.file, fmt)
      if (c instanceof Response) return c
      media = { ...c, key: null }
    } else {
      let key: string | null = null, mime = t.header_media_mime ?? '', filename = 'header'
      const mid = Number(d.header_message_id)
      if (d.header_message_id != null && d.header_message_id !== '' && d.header_message_id !== 'default') {
        const r = Number.isInteger(mid) && mid > 0
          ? await env.DB.prepare(`SELECT d.r2_key, d.mime, d.filename FROM media d JOIN messages m ON m.id=d.message_id WHERE d.message_id=? AND m.direction='out' AND d.status='stored'`).bind(mid).first<{ r2_key: string | null; mime: string | null; filename: string | null }>()
          : null
        if (!r?.r2_key || !templateHeaderOk(fmt, r.mime ?? '')) return json({ ok: false, error: 'That stored file is not available for this header.', field: 'header_media' }, 400)
        key = r.r2_key; mime = r.mime ?? ''; filename = r.filename ?? filename
      } else key = t.header_media_r2_key
      if (!key) return json({ ok: false, error: `This template needs a ${KIND_OF[fmt]} for its header. Upload one.`, field: 'header_media' }, 400)
      if (!env.MEDIA) return json({ ok: false, error: 'storage_unavailable', message: 'File storage is not set up here, so stored files cannot be reused. Upload the file instead.', field: 'header_media' }, 409)
      const obj = await env.MEDIA.get(key)
      if (!obj) return json({ ok: false, error: 'That stored file is no longer in storage. Upload it again.', field: 'header_media' }, 409)
      media = { bytes: new Uint8Array(await obj.arrayBuffer()), mime: cleanMime(mime), filename, key }
    }
  }

  const view = rowJson(t)
  const text = [view.header_text ? renderParams(view.header_text, headerParams) : '', renderParams(view.body, bodyParams)].filter(Boolean).join('\n')
  const out = await sendTemplateToContact(env, id, t, { bodyParams, headerParams, media, text }, { req, ctx })
  if (!out.ok) return out.kind === 'refused' ? out.response : upstreamFail(out.result, out.stage ?? 'send')
  const stored = !!env.MEDIA
  return json({
    ok: true, wamid: out.wamid, ...(out.queued ? { status: 'queued', queued_id: out.queued } : {}),
    message: { id: null, direction: 'out', wamid: out.wamid, type: 'template', body: text, status: 'sent', timestamp: out.now, media: media ? { status: stored || media.key ? 'stored' : 'failed', mime: media.mime, filename: media.filename, size: media.bytes.byteLength } : null },
  })
}

/** POST /api/send-otp. Bearer ADMIN_KEY only: a signed-in session (even an admin) gets 403. */
async function sendOtpRoute(req: Request, env: Env, actor: Actor | null, ctx: ExecutionContext): Promise<Response> {
  if (actor?.kind !== 'admin_key') return json({ ok: false, error: 'forbidden', message: 'One-time codes are sent with the ADMIN_KEY bearer only.' }, 403)
  const b = await readJson(req)
  if (!b || typeof b !== 'object') return json({ ok: false, error: 'invalid JSON' }, 400)
  const out = await sendOtp(env, b as Record<string, any>, ctx)
  if (out.ok) return json({ ok: true, wamid: out.wamid, queued: out.queued })
  if (out.kind === 'bad_request') return json({ ok: false, error: out.error, message: out.message, field: out.field }, out.status)
  if (out.kind === 'rate_limited') return new Response(JSON.stringify({ ok: false, error: 'rate_limited', limit: 'destination', retry_after: 600 }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '600', 'cache-control': 'no-store' } })
  return upstreamFail(out.result, 'send')
}

export async function handleTemplates(req: Request, env: Env, ctx: ExecutionContext, path: string, actor: Actor | null, url: URL): Promise<Response | null> {
  const st = path.match(/^\/api\/inbox\/(\d+)\/send-template$/)
  if (st) return req.method === 'POST' ? sendTemplateRoute(req, env, Number(st[1]), ctx) : null
  if (path === '/api/send-otp') return req.method === 'POST' ? sendOtpRoute(req, env, actor, ctx) : null
  if (path !== '/api/templates' && !path.startsWith('/api/templates/')) return null
  const admin = () => requireRole(actor, 'admin')
  if (path === '/api/templates') {
    if (req.method === 'GET') return listRoute(env, url)
    if (req.method === 'POST') return admin() ?? createRoute(req, env, actor)
    return null
  }
  if (path === '/api/templates/sync' && req.method === 'POST') return syncRoute(env)
  if (path === '/api/templates/recent-media' && req.method === 'GET') return recentMedia(env, url)
  const m = path.match(/^\/api\/templates\/([^/]+)(\/media)?$/)
  if (m) {
    let id: string
    try { id = decodeURIComponent(m[1]!) } catch { return json({ ok: false, error: 'invalid template id' }, 400) }
    if (m[2] && req.method === 'GET') return sampleRoute(env, id)
    if (!m[2] && req.method === 'DELETE') return admin() ?? deleteRoute(env, id)
  }
  return null
}
