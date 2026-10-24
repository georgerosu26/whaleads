// The single auth gate. Two credentials reach it:
//   - the `wl_session` cookie (humans, via the SPA): stateful, needs CSRF on state-changing requests;
//   - `Authorization: Bearer <ADMIN_KEY>` (scripts, recovery): acts as admin, not ambient, so no CSRF.
// Cookie shape: `v1.<token_b64url>.<mac_b64url>`, mac = HMAC-SHA256(token) under an HKDF key derived
// from SESSION_SECRET. A bad MAC is rejected before any D1 read. D1 keeps only SHA-256(token).
import { deriveHmacKey } from './crypto'
import type { Env } from './db'
import { timingSafeEqual } from './password'

export const COOKIE = 'wl_session'
export const SESSION_TTL = 30 * 24 * 3600
const SLIDE_AFTER = 24 * 3600
const INFO_SESSION = 'whaleads/session/v1'
const INFO_CSRF = 'whaleads/csrf/v1'
const enc = new TextEncoder()

export interface StaffRow { id: number; email: string; name: string; role: 'admin' | 'staff'; must_change_pw: number }
export type Actor =
  | { kind: 'staff'; staff: StaffRow; sid: string; csrf: string; csrfOk: boolean; renew?: string }
  | { kind: 'admin_key' }
export type Role = 'staff' | 'admin'

const json = (data: unknown, status: number) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

export function b64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export function unb64url(s: string): Uint8Array {
  const t = s.replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(atob(t + '='.repeat((4 - (t.length % 4)) % 4)), (c) => c.charCodeAt(0))
}

async function hmac(secret: string, info: string, msg: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign('HMAC', await deriveHmacKey(secret, info), enc.encode(msg)))
}

export async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** CSRF token for a session: HMAC(info csrf, token). Deterministic, so nothing extra is stored. */
export const csrfFor = async (secret: string, token: string) => b64url(await hmac(secret, INFO_CSRF, token))

export function cookieHeader(value: string, maxAge: number): string {
  return `${COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`
}
export const clearCookie = () => cookieHeader('', 0)

/** Creates the D1 session row. Returns the Set-Cookie value, the CSRF token and the session id hash. */
export async function createSession(env: Env, staffId: number, userAgent: string | null) {
  const secret = env.SESSION_SECRET!
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)))
  const mac = b64url(await hmac(secret, INFO_SESSION, token))
  const sid = await sha256Hex(token)
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare(`INSERT INTO sessions (id_hash,staff_id,expires_at,last_seen_at,user_agent) VALUES (?,?,?,?,?)`)
    .bind(sid, staffId, now + SESSION_TTL, now, userAgent ? userAgent.slice(0, 300) : null).run()
  return { setCookie: cookieHeader(`v1.${token}.${mac}`, SESSION_TTL), csrf: await csrfFor(secret, token), sid }
}

function readCookie(req: Request): string | null {
  for (const part of (req.headers.get('Cookie') ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim()
  }
  return null
}

/** Returns the session token only when the MAC checks out. No D1 access. */
async function verifiedToken(env: Env, cookie: string): Promise<string | null> {
  if (!env.SESSION_SECRET) return null
  const [ver, token, mac] = cookie.split('.')
  if (ver !== 'v1' || !token || !mac) return null
  try {
    const key = await deriveHmacKey(env.SESSION_SECRET, INFO_SESSION)
    return (await crypto.subtle.verify('HMAC', key, unb64url(mac), enc.encode(token))) ? token : null
  } catch { return null }
}

function adminKeyOk(given: string, env: Env): boolean {
  const want = env.ADMIN_KEY ?? ''
  return !!want && timingSafeEqual(enc.encode(given), enc.encode(want))
}

async function csrfValid(req: Request, secret: string, token: string): Promise<boolean> {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return true
  if (req.headers.get('Origin') !== new URL(req.url).origin) return false
  const given = req.headers.get('X-CSRF-Token') ?? ''
  return timingSafeEqual(enc.encode(given), enc.encode(await csrfFor(secret, token)))
}

/**
 * A rate-limit identity for a request that is about to be authenticated, with no D1 access: 'api' for a correct
 * ADMIN_KEY bearer, the session id for a cookie whose MAC checks out AND that carries an X-CSRF-Token header (a cross-site
 * form cannot set one), else null. Lets the gate start a limiter hit in parallel with the session lookup.
 */
export async function limitIdentity(req: Request, env: Env): Promise<string | null> {
  const h = req.headers.get('Authorization') ?? ''
  if (h.startsWith('Bearer ')) return adminKeyOk(h.slice(7), env) ? 'api' : null
  if (!req.headers.has('X-CSRF-Token')) return null
  const cookie = readCookie(req)
  const token = cookie ? await verifiedToken(env, cookie) : null
  return token ? `s${(await sha256Hex(token)).slice(0, 32)}` : null
}

/** Bearer ADMIN_KEY first, then the session cookie. A wrong Bearer is final: it never falls back to a cookie. */
export async function authenticate(req: Request, env: Env): Promise<Actor | null> {
  const h = req.headers.get('Authorization') ?? ''
  if (h.startsWith('Bearer ')) return adminKeyOk(h.slice(7), env) ? { kind: 'admin_key' } : null

  const cookie = readCookie(req)
  if (!cookie) return null
  const token = await verifiedToken(env, cookie)
  if (!token) return null

  const sid = await sha256Hex(token)
  const row = await env.DB.prepare(
    `SELECT s.expires_at, s.last_seen_at, st.id, st.email, st.name, st.role, st.must_change_pw, st.active
       FROM sessions s JOIN staff st ON st.id = s.staff_id WHERE s.id_hash = ?`,
  ).bind(sid).first<StaffRow & { expires_at: number; last_seen_at: number | null; active: number }>()
  const now = Math.floor(Date.now() / 1000)
  if (!row || !row.active || row.expires_at <= now) return null

  let renew: string | undefined
  if (now - (row.last_seen_at ?? 0) >= SLIDE_AFTER) {
    await env.DB.prepare(`UPDATE sessions SET expires_at=?, last_seen_at=? WHERE id_hash=?`).bind(now + SESSION_TTL, now, sid).run()
    renew = cookieHeader(cookie, SESSION_TTL)
  }
  const secret = env.SESSION_SECRET!
  return {
    kind: 'staff', sid, renew,
    staff: { id: row.id, email: row.email, name: row.name, role: row.role, must_change_pw: row.must_change_pw },
    csrf: await csrfFor(secret, token),
    csrfOk: await csrfValid(req, secret, token),
  }
}

/** 401 / 403 as a Response, or null when the actor may proceed. */
export function require(actor: Actor | null, role: Role, opts: { allowMustChange?: boolean } = {}): Response | null {
  if (!actor) return json({ ok: false, error: 'unauthorized' }, 401)
  if (actor.kind === 'admin_key') return null
  if (!actor.csrfOk) return json({ ok: false, error: 'csrf' }, 403)
  if (actor.staff.must_change_pw && !opts.allowMustChange) return json({ ok: false, error: 'password_change_required' }, 403)
  if (role === 'admin' && actor.staff.role !== 'admin') return json({ ok: false, error: 'forbidden' }, 403)
  return null
}

/** authenticate + require in one call. */
export async function guard(req: Request, env: Env, role: Role, opts: { allowMustChange?: boolean } = {}): Promise<{ actor: Actor } | { res: Response }> {
  const actor = await authenticate(req, env)
  const res = require(actor, role, opts)
  return res ? { res } : { actor: actor! }
}

/** Constant-time check that `given` equals SESSION_SECRET (the first-boot setup key). Both sides are HMACed first. */
export async function setupKeyOk(given: string, secret: string): Promise<boolean> {
  const [a, b] = await Promise.all([hmac(secret, 'whaleads/setup/v1', given), hmac(secret, 'whaleads/setup/v1', secret)])
  return timingSafeEqual(a, b)
}

/** A slid session gets a fresh Max-Age on its cookie. Every authenticated response passes through this. */
export function withRenewedCookie(res: Response, actor: Actor | null): Response {
  if (actor?.kind !== 'staff' || !actor.renew) return res
  const out = new Response(res.body, res)
  out.headers.append('set-cookie', actor.renew)
  return out
}
