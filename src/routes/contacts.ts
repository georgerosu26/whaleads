// /api/contacts: list + search, and the merged contact view (leads + conversation). The thread itself is
// /api/contacts/:id/messages in routes/inbox.ts.
import type { Actor } from '../auth'
import type { Env } from '../db'
import { json } from '../leads'
import { readJson } from './auth'
import { manualStmts, publishContact } from '../broadcasts/optout'
import { Bad, attachTags, actorLabel, clampInt, escapeLike, LEAD_COLS, LEAD_FROM, nowSec, parseCursor } from '../crm'

async function list(env: Env, url: URL): Promise<Response> {
  const limit = clampInt(url.searchParams.get('limit'), 50, 1, 100)
  const cur = parseCursor(url.searchParams.get('before'))
  if (cur === 'bad') return json({ ok: false, error: 'bad cursor', field: 'before' }, 400)
  const where: string[] = []
  const args: unknown[] = []
  const q = (url.searchParams.get('q') ?? '').trim().slice(0, 80)
  if (q) {
    const parts = [`c.name LIKE ? ESCAPE '\\'`, `c.email LIKE ? ESCAPE '\\'`]
    args.push('%' + escapeLike(q) + '%', '%' + escapeLike(q) + '%')
    const digits = q.replace(/\D/g, '')
    if (digits.length >= 3) { parts.push(`c.phone LIKE ? ESCAPE '\\'`, `c.wa_id LIKE ? ESCAPE '\\'`); args.push('%' + digits + '%', '%' + digits + '%') }
    where.push(`(${parts.join(' OR ')})`)
  }
  if (cur) { where.push('(c.last_seen_at < ? OR (c.last_seen_at = ? AND c.id < ?))'); args.push(cur[0], cur[0], cur[1]) }
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.name, c.phone, c.wa_id, c.email, c.source, c.first_seen_at, c.last_seen_at, c.opted_out_at,
            (SELECT COUNT(*) FROM leads l WHERE l.contact_id = c.id) AS lead_count,
            (SELECT l.id FROM leads l JOIN stages s ON s.key = l.status WHERE l.contact_id = c.id AND s.kind = 'open' ORDER BY l.created_at DESC LIMIT 1) AS open_lead_id,
            v.last_message_at, v.last_preview, v.unread_count
       FROM contacts c LEFT JOIN conversations v ON v.contact_id = c.id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.last_seen_at DESC, c.id DESC LIMIT ?`,
  ).bind(...args, limit + 1).all<{ id: number; last_seen_at: number }>()
  const more = results.length > limit
  const page = results.slice(0, limit)
  const last = page[page.length - 1]
  return json({ ok: true, contacts: page, next_before: more && last ? `${last.last_seen_at}.${last.id}` : null })
}

async function detail(env: Env, id: number): Promise<Response> {
  const contact = await env.DB.prepare(`SELECT id,name,phone,wa_id,email,source,first_seen_at,last_seen_at,opted_out_at,opt_out_source FROM contacts WHERE id=?`).bind(id).first()
  if (!contact) return json({ ok: false, error: 'not found' }, 404)
  const { results } = await env.DB.prepare(`SELECT ${LEAD_COLS} FROM ${LEAD_FROM} WHERE l.contact_id=? ORDER BY l.created_at DESC, l.id DESC LIMIT 100`).bind(id).all<{ id: number }>()
  const conversation = await env.DB.prepare(
    `SELECT v.contact_id,v.last_message_at,v.last_inbound_at,v.last_preview,v.unread_count,v.status,v.assigned_to,s.name AS assigned_name
       FROM conversations v LEFT JOIN staff s ON s.id=v.assigned_to WHERE v.contact_id=?`,
  ).bind(id).first()
  return json({ ok: true, contact, leads: await attachTags(env, results), conversation, messages_url: `/api/contacts/${id}/messages` })
}

async function patch(req: Request, env: Env, actor: Actor | null, id: number): Promise<Response> {
  const b = await readJson(req)
  if (!b) return json({ ok: false, error: 'invalid JSON' }, 400)
  const cur = await env.DB.prepare(`SELECT name,email FROM contacts WHERE id=?`).bind(id).first<{ name: string | null; email: string | null }>()
  if (!cur) return json({ ok: false, error: 'not found' }, 404)
  const sets: string[] = []
  const args: unknown[] = []
  const changes: Record<string, { from: string | null; to: string | null }> = {}
  try {
    if ('name' in b) {
      const v = b.name === null ? null : typeof b.name === 'string' ? b.name.trim() || null : undefined
      if (v === undefined || (v && v.length > 120)) throw new Bad('name is text up to 120 characters', 'name')
      if (v !== cur.name) { sets.push('name=?'); args.push(v); changes.name = { from: cur.name, to: v } }
    }
    if ('email' in b) {
      const v = b.email === null ? null : typeof b.email === 'string' ? b.email.trim() || null : undefined
      if (v === undefined || (v && (v.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)))) throw new Bad('email looks wrong', 'email')
      if (v !== cur.email) { sets.push('email=?'); args.push(v); changes.email = { from: cur.email, to: v } }
    }
    if (!('name' in b) && !('email' in b)) throw new Bad('nothing to change')
  } catch (e) {
    if (e instanceof Bad) return json({ ok: false, error: e.message, ...(e.field ? { field: e.field } : {}) }, e.status)
    throw e
  }
  if (!sets.length) return json({ ok: true, changed: [] })
  // Contact-level change: the activity row has contact_id only (lead_id NULL), so it is NOT part of any lead's
  // timeline (that query filters on lead_id); it is the contact's own audit trail.
  await env.DB.batch([
    env.DB.prepare(`UPDATE contacts SET ${sets.join(', ')} WHERE id=?`).bind(...args, id),
    env.DB.prepare(`INSERT INTO activity (contact_id,actor,kind,data,created_at) VALUES (?,?,?,?,?)`).bind(id, actorLabel(actor), 'contact_updated', JSON.stringify(changes), nowSec()),
  ])
  return json({ ok: true, changed: Object.keys(changes) })
}

/** Returns null when the path is not a contacts route. `/api/contacts/:id/messages` belongs to the inbox. */
/** PATCH /api/contacts/:id/opt-out {opted_out: boolean}. Any staff member; the source is 'manual', so only staff can undo it. */
async function setOptOut(req: Request, env: Env, ctx: ExecutionContext | undefined, actor: Actor | null, id: number): Promise<Response> {
  const b = await readJson(req)
  if (!b || typeof b.opted_out !== 'boolean') return json({ ok: false, error: 'opted_out must be true or false', field: 'opted_out' }, 400)
  const c = await env.DB.prepare(`SELECT 1 AS ok FROM contacts WHERE id=?`).bind(id).first()
  if (!c) return json({ ok: false, error: 'not found' }, 404)
  const res = await env.DB.batch(manualStmts(env, id, b.opted_out, actorLabel(actor), nowSec()))
  if ((res[0]?.meta.changes ?? 0) > 0) publishContact(env, ctx, id)
  const row = await env.DB.prepare(`SELECT opted_out_at, opt_out_source FROM contacts WHERE id=?`).bind(id).first()
  return json({ ok: true, ...row })
}

export async function handleContacts(req: Request, env: Env, path: string, actor: Actor | null, url: URL, ctx?: ExecutionContext): Promise<Response | null> {
  const oo = path.match(/^\/api\/contacts\/(\d+)\/opt-out$/)
  if (oo) return req.method === 'PATCH' ? setOptOut(req, env, ctx, actor, Number(oo[1])) : null
  if (path === '/api/contacts' && req.method === 'GET') return list(env, url)
  const m = path.match(/^\/api\/contacts\/(\d+)$/)
  if (!m) return null
  if (req.method === 'GET') return detail(env, Number(m[1]))
  if (req.method === 'PATCH') return patch(req, env, actor, Number(m[1]))
  return null
}
