// /api/staff: team admin. Every route needs the admin role (or the ADMIN_KEY bearer).
// Temporary passwords are generated here, returned exactly once and never logged.
import type { Actor } from '../auth'
import { require } from '../auth'
import type { Env } from '../db'
import { logEvent } from '../db'
import { json } from '../leads'
import { revokeLive } from '../live' // D20
import { hashPassword } from '../password'
import { readJson } from './auth'
import { actorId } from './settings'

// No 0/O/1/l/I: read aloud or typed from a phone screen.
const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export function tempPassword(len = 12): string {
  const out: string[] = []
  const limit = 256 - (256 % ALPHABET.length) // rejection sampling: no modulo bias
  while (out.length < len) for (const b of crypto.getRandomValues(new Uint8Array(len * 2))) if (b < limit && out.length < len) out.push(ALPHABET[b % ALPHABET.length])
  return out.join('')
}

const COLS = `id,email,name,role,active,must_change_pw,created_at,last_login_at`
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const row = (env: Env, id: number) => env.DB.prepare(`SELECT ${COLS} FROM staff WHERE id=?`).bind(id).first<Record<string, unknown>>()

async function add(req: Request, env: Env, actor: Actor | null): Promise<Response> {
  const b = await readJson(req)
  const name = typeof b?.name === 'string' ? b.name.trim() : ''
  const email = typeof b?.email === 'string' ? b.email.trim().toLowerCase() : ''
  const role = b?.role === 'admin' ? 'admin' : b?.role === 'staff' || b?.role === undefined ? 'staff' : null
  if (!name || name.length > 120) return json({ ok: false, error: 'name required (max 120 characters)', field: 'name' }, 400)
  if (!EMAIL.test(email) || email.length > 254) return json({ ok: false, error: 'a valid email is required', field: 'email' }, 400)
  if (!role) return json({ ok: false, error: "role must be 'admin' or 'staff'", field: 'role' }, 400)
  const temp = tempPassword()
  try {
    const r = await env.DB.prepare(`INSERT INTO staff (email,name,role,pw_hash,must_change_pw) VALUES (?,?,?,?,1)`).bind(email, name, role, await hashPassword(temp)).run()
    await logEvent(env.DB, 'staff_added', { id: r.meta.last_row_id, role, by: actorId(actor) ?? 'api' })
    return json({ ok: true, staff: await row(env, r.meta.last_row_id as number), temp_password: temp }, 201)
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) return json({ ok: false, error: 'email_taken', field: 'email' }, 409)
    throw e
  }
}

async function patch(req: Request, env: Env, actor: Actor | null, id: number, ctx?: ExecutionContext): Promise<Response> {
  const cur = await row(env, id)
  if (!cur) return json({ ok: false, error: 'not found' }, 404)
  const b = await readJson(req)
  if (!b) return json({ ok: false, error: 'invalid JSON' }, 400)
  const name = 'name' in b ? (typeof b.name === 'string' ? b.name.trim() : '') : (cur.name as string)
  const role = 'role' in b ? b.role : cur.role
  const active = 'active' in b ? (typeof b.active === 'boolean' ? (b.active ? 1 : 0) : null) : (cur.active as number)
  if (!name || name.length > 120) return json({ ok: false, error: 'name required (max 120 characters)', field: 'name' }, 400)
  if (role !== 'admin' && role !== 'staff') return json({ ok: false, error: "role must be 'admin' or 'staff'", field: 'role' }, 400)
  if (active === null) return json({ ok: false, error: 'active must be true or false', field: 'active' }, 400)

  // The guard is part of the UPDATE itself, so two concurrent demotions cannot both succeed.
  const r = await env.DB.prepare(
    `UPDATE staff SET name=?1, role=?2, active=?3 WHERE id=?4
       AND (NOT (role='admin' AND active=1 AND NOT (?2='admin' AND ?3=1))
            OR EXISTS (SELECT 1 FROM staff o WHERE o.id<>?4 AND o.role='admin' AND o.active=1))`,
  ).bind(name, role, active, id).run()
  if (!r.meta.changes) return json({ ok: false, error: 'last_admin' }, 409)
  if (!active) { await env.DB.prepare(`DELETE FROM sessions WHERE staff_id=?`).bind(id).run(); revokeLive(env, ctx, { staff: id }) }
  await logEvent(env.DB, 'staff_changed', { id, role, active, by: actorId(actor) ?? 'api' })
  return json({ ok: true, staff: await row(env, id) })
}

async function reset(env: Env, actor: Actor | null, id: number, ctx?: ExecutionContext): Promise<Response> {
  if (actor?.kind === 'staff' && actor.staff.id === id) return json({ ok: false, error: 'use_profile' }, 400)
  if (!(await row(env, id))) return json({ ok: false, error: 'not found' }, 404)
  const temp = tempPassword()
  await env.DB.batch([
    env.DB.prepare(`UPDATE staff SET pw_hash=?, must_change_pw=1 WHERE id=?`).bind(await hashPassword(temp), id),
    env.DB.prepare(`DELETE FROM sessions WHERE staff_id=?`).bind(id),
  ])
  revokeLive(env, ctx, { staff: id })
  await logEvent(env.DB, 'staff_password_reset', { id, by: actorId(actor) ?? 'api' })
  return json({ ok: true, staff: await row(env, id), temp_password: temp })
}

export async function handleStaff(req: Request, env: Env, path: string, actor: Actor | null, ctx?: ExecutionContext): Promise<Response | null> {
  const m = path.match(/^\/api\/staff(?:\/(\d+)(\/reset-password)?)?$/)
  if (!m) return null
  const denied = require(actor, 'admin')
  if (denied) return denied
  if (!m[1]) {
    if (req.method === 'GET') {
      const { results } = await env.DB.prepare(`SELECT ${COLS} FROM staff ORDER BY active DESC, name COLLATE NOCASE`).all()
      return json({ ok: true, staff: results })
    }
    if (req.method === 'POST') return add(req, env, actor)
    return null
  }
  const id = Number(m[1])
  if (m[2]) return req.method === 'POST' ? reset(env, actor, id, ctx) : null
  if (req.method === 'PATCH') return patch(req, env, actor, id, ctx)
  return null
}
