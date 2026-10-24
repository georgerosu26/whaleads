// /api/auth/*: login, logout, me, change password, recover.
import { clearCookie, createSession, authenticate, guard, setupKeyOk, withRenewedCookie, type StaffRow } from '../auth'
import { adaptorConfigured } from '../adaptors'
import { logEvent, type Env } from '../db'
import { json } from '../leads'
import { revokeLive } from '../live' // D20
import { hashPassword, verifyOrDummy } from '../password'
import { clear, hit, peek } from '../ratelimit'
import { getSettings } from '../settings'

const WINDOW = 15 * 60
export const MIN_PASSWORD = 10
const MAX_PASSWORD = 200

export const clientIp = (req: Request) => req.headers.get('CF-Connecting-IP') ?? 'unknown'

export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const b = await req.json()
    return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : null
  } catch { return null }
}

/** Unauthenticated POSTs (login, setup) have no CSRF token; a cross-origin Origin header is refused outright. */
export function sameOriginOrNone(req: Request): boolean {
  const o = req.headers.get('Origin')
  return !o || o === new URL(req.url).origin
}

export const sessionMissing = () => json({ ok: false, error: 'session_secret_missing' }, 503)

/** What the SPA needs after authentication. Settings resolve setting > env > default (src/settings.ts). */
export async function mePayload(env: Env, staff: StaffRow, csrf: string) {
  const s = await getSettings(env)
  return {
    ok: true,
    staff: { id: staff.id, name: staff.name, email: staff.email, role: staff.role, must_change_pw: !!staff.must_change_pw },
    csrf,
    business_name: s.business_name,
    default_country: s.default_country,
    timezone: s.timezone,
    vapid_public: s.vapid_public,
    whatsapp_connected: await adaptorConfigured(env),
  }
}

async function login(req: Request, env: Env): Promise<Response> {
  if (!env.SESSION_SECRET) return sessionMissing()
  if (!sameOriginOrNone(req)) return json({ ok: false, error: 'bad_origin' }, 403)
  const b = await readJson(req)
  const email = typeof b?.email === 'string' ? b.email.trim().toLowerCase().slice(0, 254) : ''
  const password = typeof b?.password === 'string' ? b.password : ''
  if (!email || !password || password.length > MAX_PASSWORD) return json({ ok: false, error: 'invalid credentials' }, 401)

  // The per-IP limit counts every attempt, so hashing cost cannot be farmed. The per-email limit counts only
  // FAILURES (5 allowed, the next attempt is refused) and is cleared by a success, so strangers guessing at an
  // admin's email from many IPs can slow guessing but cannot lock the real owner out for good.
  const emailKey = `login:email:${email}`
  if (await hit(env.DB, `login:ip:${clientIp(req)}`, 10, WINDOW) || (await peek(env.DB, emailKey, WINDOW)) > 5) {
    return json({ ok: false, error: 'too many attempts, try again later' }, 429, { 'retry-after': String(WINDOW) })
  }

  const row = await env.DB.prepare(`SELECT id,email,name,role,must_change_pw,active,pw_hash FROM staff WHERE email=?`).bind(email).first<StaffRow & { active: number; pw_hash: string }>()
  const ok = await verifyOrDummy(password, row?.pw_hash)
  if (!row || !row.active || !ok) {
    await hit(env.DB, emailKey, 5, WINDOW)
    return json({ ok: false, error: 'invalid credentials' }, 401)
  }
  await clear(env.DB, emailKey)

  const s = await createSession(env, row.id, req.headers.get('User-Agent'))
  await env.DB.prepare(`UPDATE staff SET last_login_at=unixepoch() WHERE id=?`).bind(row.id).run()
  return json(await mePayload(env, row, s.csrf), 200, { 'set-cookie': s.setCookie })
}

// D26: self-service recovery for whoever holds SESSION_SECRET (the setup key). That secret already forges sessions and
// gates /setup, so this adds no privilege. A wrong key and an unknown or inactive email are the same 403 after the same
// work (one HMAC pair + one staff lookup), so the response never says which part was wrong or whether the email exists.
const RECOVER_IP = { limit: 5, window: WINDOW }
const RECOVER_ALL = { limit: 20, window: 3600 }
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

async function recover(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const secret = env.SESSION_SECRET
  if (!secret) return sessionMissing()
  if (!sameOriginOrNone(req)) return json({ ok: false, error: 'bad_origin' }, 403)
  const b = await readJson(req)
  if (!b) return json({ ok: false, error: 'invalid JSON' }, 400)
  const key = typeof b.setup_key === 'string' ? b.setup_key : ''
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : ''
  const next = typeof b.new_password === 'string' ? b.new_password : ''
  if (!EMAIL.test(email) || email.length > 254) return json({ ok: false, error: 'a valid email is required' }, 400)
  if (next.length < MIN_PASSWORD) return json({ ok: false, error: `new password must be at least ${MIN_PASSWORD} characters` }, 400)
  if (next.length > MAX_PASSWORD) return json({ ok: false, error: 'new password is too long' }, 400)

  // Every attempt counts. The global counter caps guessing from many addresses; the cost is that a flood can block
  // recovery for up to an hour (the ADMIN_KEY bearer reset still works).
  const limited = (retry: number) => json({ ok: false, error: 'too many attempts, try again later' }, 429, { 'retry-after': String(retry) })
  if (await hit(env.DB, `recover:ip:${clientIp(req)}`, RECOVER_IP.limit, RECOVER_IP.window)) return limited(RECOVER_IP.window)
  if (await hit(env.DB, 'recover:all', RECOVER_ALL.limit, RECOVER_ALL.window)) return limited(RECOVER_ALL.window)

  const [keyOk, row] = await Promise.all([
    setupKeyOk(key, secret),
    env.DB.prepare(`SELECT id,email,name,role,active FROM staff WHERE email=?`).bind(email).first<StaffRow & { active: number }>(),
  ])
  if (!keyOk || !row || !row.active) return json({ ok: false, error: 'invalid_recovery' }, 403)

  const hash = await hashPassword(next)
  await env.DB.batch([
    env.DB.prepare(`UPDATE staff SET pw_hash=?, must_change_pw=0, last_login_at=unixepoch() WHERE id=?`).bind(hash, row.id),
    env.DB.prepare(`DELETE FROM sessions WHERE staff_id=?`).bind(row.id),
  ])
  await clear(env.DB, `login:email:${email}`)
  const s = await createSession(env, row.id, req.headers.get('User-Agent'))
  revokeLive(env, ctx, { staff: row.id, exceptSid: s.sid })
  await logEvent(env.DB, 'staff_password_recovered', { id: row.id, by: 'recovery' })
  return json(await mePayload(env, { ...row, must_change_pw: 0 }, s.csrf), 200, { 'set-cookie': s.setCookie })
}

async function logout(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const actor = await authenticate(req, env)
  if (actor?.kind === 'staff') {
    if (!actor.csrfOk) return json({ ok: false, error: 'csrf' }, 403)
    await env.DB.prepare(`DELETE FROM sessions WHERE id_hash=?`).bind(actor.sid).run()
    revokeLive(env, ctx, { sid: actor.sid })
  }
  return json({ ok: true }, 200, { 'set-cookie': clearCookie() })
}

async function me(req: Request, env: Env): Promise<Response> {
  const g = await guard(req, env, 'staff', { allowMustChange: true })
  if ('res' in g) return g.res
  if (g.actor.kind !== 'staff') return json({ ok: false, error: 'a staff session is required' }, 400)
  return withRenewedCookie(json(await mePayload(env, g.actor.staff, g.actor.csrf)), g.actor)
}

async function changePassword(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const g = await guard(req, env, 'staff', { allowMustChange: true })
  if ('res' in g) return g.res
  const a = g.actor
  if (a.kind !== 'staff') return json({ ok: false, error: 'a staff session is required' }, 400)
  const b = await readJson(req)
  const cur = typeof b?.current_password === 'string' ? b.current_password : ''
  const next = typeof b?.new_password === 'string' ? b.new_password : ''
  if (next.length < MIN_PASSWORD) return json({ ok: false, error: `new password must be at least ${MIN_PASSWORD} characters` }, 400)
  if (next.length > MAX_PASSWORD) return json({ ok: false, error: 'new password is too long' }, 400)
  if (next === cur) return json({ ok: false, error: 'new password must differ from the current one' }, 400)
  if (await hit(env.DB, `pw:staff:${a.staff.id}`, 5, WINDOW)) return json({ ok: false, error: 'too many attempts, try again later' }, 429)

  const row = await env.DB.prepare(`SELECT pw_hash FROM staff WHERE id=?`).bind(a.staff.id).first<{ pw_hash: string }>()
  if (!(await verifyOrDummy(cur, row?.pw_hash))) return json({ ok: false, error: 'current password is wrong' }, 403)

  const hash = await hashPassword(next)
  await env.DB.batch([
    env.DB.prepare(`UPDATE staff SET pw_hash=?, must_change_pw=0 WHERE id=?`).bind(hash, a.staff.id),
    env.DB.prepare(`DELETE FROM sessions WHERE staff_id=? AND id_hash<>?`).bind(a.staff.id, a.sid),
  ])
  revokeLive(env, ctx, { staff: a.staff.id, exceptSid: a.sid })
  return withRenewedCookie(json({ ok: true }), a)
}

async function updateProfile(req: Request, env: Env): Promise<Response> {
  const g = await guard(req, env, 'staff')
  if ('res' in g) return g.res
  if (g.actor.kind !== 'staff') return json({ ok: false, error: 'a staff session is required' }, 400)
  const b = await readJson(req)
  const name = typeof b?.name === 'string' ? b.name.trim() : ''
  if (!name || name.length > 120) return json({ ok: false, error: 'name required (max 120 characters)', field: 'name' }, 400)
  await env.DB.prepare(`UPDATE staff SET name=? WHERE id=?`).bind(name, g.actor.staff.id).run()
  return withRenewedCookie(json(await mePayload(env, { ...g.actor.staff, name }, g.actor.csrf)), g.actor)
}

export async function handleAuth(req: Request, env: Env, path: string, ctx?: ExecutionContext): Promise<Response | null> {
  if (path === '/api/auth/login' && req.method === 'POST') return login(req, env)
  if (path === '/api/auth/logout' && req.method === 'POST') return logout(req, env, ctx)
  if (path === '/api/auth/me' && req.method === 'GET') return me(req, env)
  if (path === '/api/auth/me' && req.method === 'PATCH') return updateProfile(req, env)
  if (path === '/api/auth/password' && req.method === 'POST') return changePassword(req, env, ctx)
  if (path === '/api/auth/recover' && req.method === 'POST') return recover(req, env, ctx)
  return null
}
