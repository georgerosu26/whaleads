// /api/inbox, /api/contacts/:id/messages, /api/conversations/:contactId. Behind the auth gate in index.ts
// (staff session with CSRF on non-GET, or the ADMIN_KEY bearer).
import type { Actor } from '../auth'
import type { Env } from '../db'
import { logEvent } from '../db'
import { resolveActive, resolveActiveCached } from '../adaptors'
import { deferRecord, firstResponse, outboundConversation, outboundMessageInsert, previewOf, windowState } from '../conversations'
import { json } from '../leads'
import { publishConversation, publishMessage } from '../live' // D20
import { sendMediaToContact, sendTextToContact } from '../send'
import { sendTarget } from '../sendTarget'
import {
  MAX_UPLOAD_BODY, OUTBOUND_LIMITS, cleanMime, outboundKind, safeFilename, sendMediaFile, sniffOk,
} from '../media'
import { readJson } from './auth'
import { actorId } from './settings'

const FILTERS = ['all', 'unread', 'mine', 'open', 'closed'] as const
type Filter = (typeof FILTERS)[number]
const num = (v: string | null, dflt: number, min: number, max: number) => Math.min(Math.max(Math.floor(Number(v)) || dflt, min), max)
const actorLabel = (a: Actor | null) => (a?.kind === 'staff' ? `staff:${a.staff.id}` : 'api')
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c)

/** Cursor = "<unread flag>.<last_message_at>.<contact_id>", the sort key of the last row of the previous page. */
function parseCursor(s: string | null): [number, number, number] | null {
  const m = /^([01])\.(\d+)\.(\d+)$/.exec(s ?? '')
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

async function list(env: Env, actor: Actor | null, url: URL): Promise<Response> {
  const raw = url.searchParams.get('filter') ?? 'all'
  if (!(FILTERS as readonly string[]).includes(raw)) return json({ ok: false, error: `filter must be one of ${FILTERS.join(', ')}`, field: 'filter' }, 400)
  const filter = raw as Filter
  const limit = num(url.searchParams.get('limit'), 30, 1, 100)
  const where: string[] = []
  const args: unknown[] = []
  if (filter === 'unread') where.push('v.unread_count > 0')
  if (filter === 'open' || filter === 'closed') { where.push('v.status = ?'); args.push(filter) }
  if (filter === 'mine') { where.push('v.assigned_to = ?'); args.push(actorId(actor) ?? -1) }
  const q = (url.searchParams.get('q') ?? '').trim().slice(0, 80)
  if (q) {
    const digits = q.replace(/\D/g, '')
    const parts = [`c.name LIKE ? ESCAPE '\\'`]
    args.push(escapeLike(q) + '%')
    if (digits) { parts.push(`c.phone LIKE ? ESCAPE '\\'`, `c.wa_id LIKE ? ESCAPE '\\'`); args.push(digits + '%', digits + '%') }
    where.push(`(${parts.join(' OR ')})`)
  }
  const cur = parseCursor(url.searchParams.get('before'))
  if (url.searchParams.get('before') && !cur) return json({ ok: false, error: 'bad cursor', field: 'before' }, 400)
  const flag = '(v.unread_count > 0)'
  if (cur) {
    where.push(`(${flag} < ? OR (${flag} = ? AND (v.last_message_at < ? OR (v.last_message_at = ? AND v.contact_id < ?))))`)
    args.push(cur[0], cur[0], cur[1], cur[1], cur[2])
  }
  const { results } = await env.DB.prepare(
    `SELECT v.contact_id, c.name, c.phone, c.wa_id, v.last_preview, v.last_message_at, v.last_inbound_at, v.unread_count,
            v.status, v.assigned_to, s.name AS assigned_name, ${flag} AS has_unread,
            (SELECT COUNT(*) FROM conversations WHERE unread_count > 0) AS unread_total
       FROM conversations v JOIN contacts c ON c.id = v.contact_id LEFT JOIN staff s ON s.id = v.assigned_to
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY has_unread DESC, v.last_message_at DESC, v.contact_id DESC LIMIT ?`,
  ).bind(...args, limit + 1).all<Record<string, any>>()
  const more = results.length > limit
  const page = results.slice(0, limit)
  const now = Math.floor(Date.now() / 1000)
  // The badge total rides on the same query (an uncorrelated subquery over the partial index: one trip, no scan).
  // Only an empty page has no row to carry it.
  const unread_total = results.length ? Number(results[0]!.unread_total) : await unreadTotal(env)
  const inbox = page.map(({ has_unread, unread_total: _t, ...r }) => ({
    ...r,
    ...windowState(r.last_inbound_at, now),
    // Legacy names, kept so existing API consumers do not break
    last_body: r.last_preview, last_at: r.last_message_at,
  }))
  const last = page[page.length - 1]
  // For the empty state: which number is connected. Only looked up when there is genuinely nothing to show.
  let connected_number: string | null = null
  if (!inbox.length && filter === 'all' && !q && !cur) {
    try { connected_number = (await (await resolveActive(env))?.adaptor.status())?.display_number ?? null } catch { /* shown without a number */ }
  }
  return json({
    ok: true, inbox, connected_number,
    next_before: more && last ? `${last.has_unread}.${last.last_message_at}.${last.contact_id}` : null,
    unread_total,
  })
}

export async function unreadTotal(env: Env): Promise<number> {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM conversations WHERE unread_count > 0`).first<{ n: number }>()
  return r?.n ?? 0
}

async function thread(env: Env, id: number, url: URL): Promise<Response> {
  const contact = await env.DB.prepare(`SELECT * FROM contacts WHERE id=?`).bind(id).first()
  if (!contact) return json({ ok: false, error: 'not found' }, 404)
  const limit = num(url.searchParams.get('limit'), 50, 1, 100)
  const beforeRaw = url.searchParams.get('before')
  const before = beforeRaw ? Number(beforeRaw) : null
  if (beforeRaw && !(Number.isInteger(before) && before! > 0)) return json({ ok: false, error: 'bad cursor', field: 'before' }, 400)
  // Live refresh poll: only messages newer than the id the client already shows (oldest first), plus fresh conversation state.
  const afterRaw = url.searchParams.get('after')
  const after = afterRaw ? Number(afterRaw) : null
  if (afterRaw && !(Number.isInteger(after) && after! >= 0)) return json({ ok: false, error: 'bad cursor', field: 'after' }, 400)
  if (afterRaw && beforeRaw) return json({ ok: false, error: 'use either before or after', field: 'after' }, 400)
  const SELECT_MSG = `SELECT m.id, m.direction, m.wamid, m.type, m.body, m.media_id, m.status, m.timestamp,
            d.status AS media_status, d.mime AS media_mime, d.filename AS media_filename, d.size AS media_size
       FROM messages m LEFT JOIN media d ON d.message_id = m.id`
  const { results } = afterRaw
    ? await env.DB.prepare(`${SELECT_MSG} WHERE m.contact_id = ?1 AND m.id > ?3 ORDER BY m.id ASC LIMIT ?2`).bind(id, limit, after).all<Record<string, any>>()
    : await env.DB.prepare(`${SELECT_MSG} WHERE m.contact_id = ?1 ${before ? 'AND m.id < ?3' : ''} ORDER BY m.id DESC LIMIT ?2`)
      .bind(...(before ? [id, limit + 1, before] : [id, limit + 1])).all<Record<string, any>>()
  const more = !afterRaw && results.length > limit
  const page = afterRaw ? results : results.slice(0, limit).reverse() // oldest first for display
  const messages = page.map(({ media_status, media_mime, media_filename, media_size, ...m }) => ({
    ...m,
    media: media_status ? { status: media_status, mime: media_mime, filename: media_filename, size: media_size } : null,
  }))
  const conv = await env.DB.prepare(
    `SELECT v.contact_id, v.last_message_at, v.last_inbound_at, v.unread_count, v.status, v.assigned_to, s.name AS assigned_name
       FROM conversations v LEFT JOIN staff s ON s.id = v.assigned_to WHERE v.contact_id=?`,
  ).bind(id).first<Record<string, any>>()
  // Ticks: current status of recent outbound messages (indexed timestamp range, newest 30), in the same response.
  const statuses = afterRaw
    ? (await env.DB.prepare(`SELECT id, status FROM messages WHERE contact_id=?1 AND timestamp >= ?2 AND direction='out' ORDER BY timestamp DESC LIMIT 30`)
        .bind(id, Math.floor(Date.now() / 1000) - 86_400).all<{ id: number; status: string | null }>()).results
    : undefined
  return json({
    ok: true, contact, messages, conversation: conv, ...(statuses ? { statuses } : {}),
    ...windowState(conv?.last_inbound_at ?? null),
    has_more: more, next_before: more && page[0] ? page[0].id : null,
  })
}

async function markRead(env: Env, ctx: ExecutionContext, id: number): Promise<Response> {
  const conv = await env.DB.prepare(`SELECT unread_count FROM conversations WHERE contact_id=?`).bind(id).first<{ unread_count: number }>()
  if (!conv) return json({ ok: false, error: 'not found' }, 404)
  const wasUnread = conv.unread_count > 0
  await env.DB.prepare(`UPDATE conversations SET unread_count=0 WHERE contact_id=?`).bind(id).run()
  if (wasUnread) {
    publishConversation(env, ctx, id) // D20: the other tabs / staff drop their badge
    // Best effort: the blue ticks on the customer's phone. Never blocks or fails the request.
    ctx.waitUntil((async () => {
      try {
        const m = await env.DB.prepare(`SELECT wamid FROM messages WHERE contact_id=? AND direction='in' AND wamid IS NOT NULL ORDER BY timestamp DESC, id DESC LIMIT 1`).bind(id).first<{ wamid: string }>()
        const active = m && (await resolveActive(env))
        if (!m || !active) return
        const r = await active.adaptor.markRead(m.wamid)
        if (!r.ok) await logEvent(env.DB, 'mark_read_failed', { contact_id: id, status: r.status, message: r.error?.message })
      } catch (e) {
        await logEvent(env.DB, 'mark_read_failed', { contact_id: id, error: String(e) })
      }
    })())
  }
  return json({ ok: true, unread_count: 0, marked: wasUnread })
}

async function patchConversation(req: Request, env: Env, ctx: ExecutionContext, actor: Actor | null, id: number): Promise<Response> {
  const b = await readJson(req)
  if (!b) return json({ ok: false, error: 'invalid JSON' }, 400)
  const conv = await env.DB.prepare(`SELECT status, assigned_to FROM conversations WHERE contact_id=?`).bind(id).first<{ status: string; assigned_to: number | null }>()
  if (!conv) return json({ ok: false, error: 'not found' }, 404)
  const sets: string[] = []
  const args: unknown[] = []
  const acts: [string, unknown][] = []
  if ('status' in b) {
    if (b.status !== 'open' && b.status !== 'closed') return json({ ok: false, error: "status must be 'open' or 'closed'", field: 'status' }, 400)
    sets.push('status=?'); args.push(b.status)
    if (b.status !== conv.status) acts.push([b.status === 'closed' ? 'conversation_closed' : 'conversation_reopened', null])
  }
  if ('assigned_to' in b) {
    let to: number | null = null
    if (b.assigned_to !== null) {
      to = Number(b.assigned_to)
      const ok = Number.isInteger(to) && (await env.DB.prepare(`SELECT 1 AS x FROM staff WHERE id=? AND active=1`).bind(to).first())
      if (!ok) return json({ ok: false, error: 'assignee must be an active staff member', field: 'assigned_to' }, 400)
    }
    sets.push('assigned_to=?'); args.push(to)
    if (to !== conv.assigned_to) acts.push([to === null ? 'conversation_unassigned' : 'conversation_assigned', { from: conv.assigned_to, to }])
  }
  if (!sets.length) return json({ ok: false, error: 'nothing to change' }, 400)
  await env.DB.batch([
    env.DB.prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE contact_id=?`).bind(...args, id),
    ...acts.map(([kind, data]) => env.DB.prepare(`INSERT INTO activity (contact_id,actor,kind,data) VALUES (?,?,?,?)`).bind(id, actorLabel(actor), kind, data === null ? null : JSON.stringify(data))),
  ])
  const out = await env.DB.prepare(
    `SELECT v.contact_id, v.status, v.assigned_to, s.name AS assigned_name, v.unread_count FROM conversations v LEFT JOIN staff s ON s.id=v.assigned_to WHERE v.contact_id=?`,
  ).bind(id).first()
  publishConversation(env, ctx, id) // D20
  return json({ ok: true, conversation: out })
}

// ---- send, send-media, quick replies ------------------------------------------------------------

const MAX_TEXT = 4096
const MAX_CAPTION = 1024

const upstreamFail = (r: { status: number; data?: unknown; error?: { message: string; source: string; error: unknown } }, stage?: string) =>
  json({ ok: false, error: r.error?.message ?? 'send failed', source: r.error?.source, graph: r.error?.error ?? r.data, ...(stage ? { stage } : {}) }, 502)

async function sendText(req: Request, env: Env, id: number, ctx?: ExecutionContext): Promise<Response> {
  const b = await readJson(req)
  if (!b) return json({ ok: false, error: 'invalid JSON' }, 400)
  const text = typeof b.text === 'string' ? b.text.trim() : ''
  if (!text) return json({ ok: false, error: 'text required', field: 'text' }, 400)
  if (text.length > MAX_TEXT) return json({ ok: false, error: `text is over ${MAX_TEXT} characters`, field: 'text' }, 400)
  const out = await sendTextToContact(env, id, text, { req, ctx })
  if (!out.ok) return out.kind === 'refused' ? out.response : upstreamFail(out.result, out.stage)
  return json({ ok: true, wamid: out.wamid, ...(out.queued ? { status: 'queued', queued_id: out.queued } : {}), message: { id: null, direction: 'out', wamid: out.wamid, type: 'text', body: text, status: 'sent', timestamp: out.now, media: null } })
}

async function sendMediaRoute(req: Request, env: Env, id: number, ctx?: ExecutionContext): Promise<Response> {
  // formData() buffers the whole body, so a length must be declared up front (chunked uploads are refused).
  const lenHeader = req.headers.get('content-length')
  if (lenHeader === null) return json({ ok: false, error: 'length_required', message: 'Content-Length is required for uploads.' }, 411)
  const len = Number(lenHeader)
  if (!Number.isFinite(len) || len > MAX_UPLOAD_BODY) return json({ ok: false, error: 'file_too_large', message: 'The file is too large to send.', field: 'file' }, 413)
  if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('multipart/form-data')) return json({ ok: false, error: 'multipart/form-data expected' }, 400)
  let form: FormData
  try { form = await req.formData() } catch { return json({ ok: false, error: 'bad multipart body' }, 400) }
  const file = form.get('file')
  if (!(file instanceof File)) return json({ ok: false, error: 'file required', field: 'file' }, 400)
  const mime = cleanMime(file.type)
  const kind = outboundKind(mime)
  if (!kind) return json({ ok: false, error: 'unsupported_type', message: `WhatsApp cannot send ${mime || 'this kind of file'}. Use JPEG or PNG images, MP4 video, common audio, PDF or Office documents.`, field: 'file' }, 415)
  const cap = OUTBOUND_LIMITS[kind]
  if (file.size === 0) return json({ ok: false, error: 'empty_file', field: 'file' }, 400)
  if (file.size > cap) return json({ ok: false, error: 'file_too_large', message: `${kind[0]!.toUpperCase()}${kind.slice(1)} files can be at most ${cap / 1048576} MB.`, field: 'file' }, 413)
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (!sniffOk(mime, bytes.subarray(0, 8))) return json({ ok: false, error: 'unsupported_type', message: `This file is not really ${mime}.`, field: 'file' }, 415)
  const captionRaw = form.get('caption')
  const caption = kind === 'audio' || typeof captionRaw !== 'string' ? '' : captionRaw.trim()
  if (caption.length > MAX_CAPTION) return json({ ok: false, error: `caption is over ${MAX_CAPTION} characters`, field: 'caption' }, 400)
  const filename = safeFilename(file.name, kind)

  const out = await sendMediaToContact(env, id, { bytes, mime, kind, filename, caption: caption || undefined }, { req, ctx })
  if (!out.ok) return out.kind === 'refused' ? out.response : upstreamFail(out.result, out.stage)
  return json({
    ok: true, wamid: out.wamid, ...(out.queued ? { status: 'queued', queued_id: out.queued } : {}),
    message: { id: null, direction: 'out', wamid: out.wamid, type: kind, body: caption || null, status: 'sent', timestamp: out.now, media: { status: out.stored ? 'stored' : 'failed', mime, filename, size: bytes.byteLength } },
  })
}

interface QuickReply { id: number; shortcut: string; body: string }

function quickReplyInput(b: Record<string, any>, partial: boolean): { shortcut?: string; body?: string } | Response {
  const out: { shortcut?: string; body?: string } = {}
  if (!partial || 'shortcut' in b) {
    const sc = typeof b.shortcut === 'string' ? b.shortcut.trim().replace(/^\/+/, '') : ''
    if (!/^[\p{L}\p{N}_-]{1,32}$/u.test(sc)) return json({ ok: false, error: 'Use 1 to 32 letters, numbers, dashes or underscores.', field: 'shortcut' }, 400)
    out.shortcut = sc
  }
  if (!partial || 'body' in b) {
    const body = typeof b.body === 'string' ? b.body.trim() : ''
    if (!body || body.length > MAX_TEXT) return json({ ok: false, error: `Write a reply of 1 to ${MAX_TEXT} characters.`, field: 'body' }, 400)
    out.body = body
  }
  return out
}

const taken = (e: unknown) => /UNIQUE/i.test(String(e))

async function quickReplies(req: Request, env: Env, actor: Actor | null, path: string): Promise<Response | null> {
  if (path === '/api/quick-replies') {
    if (req.method === 'GET') {
      const { results } = await env.DB.prepare(`SELECT id, shortcut, body FROM quick_replies ORDER BY shortcut COLLATE NOCASE`).all<QuickReply>()
      return json({ ok: true, quick_replies: results })
    }
    if (req.method === 'POST') {
      const b = await readJson(req)
      if (!b) return json({ ok: false, error: 'invalid JSON' }, 400)
      const v = quickReplyInput(b, false)
      if (v instanceof Response) return v
      try {
        const r = await env.DB.prepare(`INSERT INTO quick_replies (shortcut, body, created_by) VALUES (?,?,?)`).bind(v.shortcut, v.body, actorId(actor)).run()
        return json({ ok: true, quick_reply: { id: r.meta.last_row_id, shortcut: v.shortcut, body: v.body } }, 201)
      } catch (e) {
        if (taken(e)) return json({ ok: false, error: 'That shortcut is already in use.', field: 'shortcut' }, 409)
        throw e
      }
    }
    return null
  }
  const m = path.match(/^\/api\/quick-replies\/(\d+)$/)
  if (!m) return null
  const id = Number(m[1])
  if (req.method === 'DELETE') {
    const r = await env.DB.prepare(`DELETE FROM quick_replies WHERE id=?`).bind(id).run()
    return r.meta.changes ? json({ ok: true }) : json({ ok: false, error: 'not found' }, 404)
  }
  if (req.method === 'PATCH') {
    const b = await readJson(req)
    if (!b) return json({ ok: false, error: 'invalid JSON' }, 400)
    const v = quickReplyInput(b, true)
    if (v instanceof Response) return v
    if (v.shortcut === undefined && v.body === undefined) return json({ ok: false, error: 'nothing to change' }, 400)
    try {
      const r = await env.DB.prepare(`UPDATE quick_replies SET shortcut=COALESCE(?1,shortcut), body=COALESCE(?2,body) WHERE id=?3`).bind(v.shortcut ?? null, v.body ?? null, id).run()
      if (!r.meta.changes) return json({ ok: false, error: 'not found' }, 404)
    } catch (e) {
      if (taken(e)) return json({ ok: false, error: 'That shortcut is already in use.', field: 'shortcut' }, 409)
      throw e
    }
    const row = await env.DB.prepare(`SELECT id, shortcut, body FROM quick_replies WHERE id=?`).bind(id).first<QuickReply>()
    return json({ ok: true, quick_reply: row })
  }
  return null
}

/** Returns null when the path is not an inbox route. */
export async function handleInbox(req: Request, env: Env, ctx: ExecutionContext, path: string, actor: Actor | null, url: URL): Promise<Response | null> {
  if (path === '/api/inbox' && req.method === 'GET') return list(env, actor, url)
  let sb = path.match(/^\/api\/inbox\/(\d+)\/(send|send-media)$/)
  if (sb && req.method === 'POST') return sb[2] === 'send' ? sendText(req, env, Number(sb[1]), ctx) : sendMediaRoute(req, env, Number(sb[1]), ctx)
  if (path.startsWith('/api/quick-replies')) return quickReplies(req, env, actor, path)
  if (path === '/api/inbox/unread' && req.method === 'GET') return json({ ok: true, unread: await unreadTotal(env) })
  let m = path.match(/^\/api\/contacts\/(\d+)\/messages$/)
  if (m && req.method === 'GET') return thread(env, Number(m[1]), url)
  m = path.match(/^\/api\/conversations\/(\d+)\/read$/)
  if (m && req.method === 'POST') return markRead(env, ctx, Number(m[1]))
  m = path.match(/^\/api\/conversations\/(\d+)$/)
  if (m && req.method === 'PATCH') return patchConversation(req, env, ctx, actor, Number(m[1]))
  return null
}
