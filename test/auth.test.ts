import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'
import { ensureSchema, type Env } from '../src/db'
import { decryptJson } from '../src/crypto'
import { DUMMY_HASH, hashPassword, verifyOrDummy, verifyPassword } from '../src/password'
import { hit } from '../src/ratelimit'
import { VAPID_INFO } from '../src/routes/setup'
import { ctx } from './helpers'
import { fakeD1 } from './d1'

const SECRET = 'test-session-secret-0123456789'
const ORIGIN = 'https://leads.example.com'
const PASS = 'correct horse battery'
const ADMIN = { name: 'Test Admin', email: 'admin@example.com', password: PASS }
const setupBody = (over: Record<string, unknown> = {}) => ({
  setup_key: SECRET, business_name: 'Example Co', default_country: 'IN', timezone: 'Asia/Kolkata', admin: ADMIN, ...over,
})

let env: Env
let raw: DatabaseSync
let dbReads = 0

type Opts = { cookie?: string; csrf?: string; origin?: string | null; bearer?: string; ip?: string }
const call = (method: string, path: string, body?: unknown, o: Opts = {}) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (o.cookie) headers.Cookie = o.cookie
  if (o.csrf) headers['X-CSRF-Token'] = o.csrf
  if (o.origin !== null && (o.origin || method !== 'GET')) headers.Origin = o.origin ?? ORIGIN
  if (o.bearer) headers.Authorization = `Bearer ${o.bearer}`
  if (o.ip) headers['CF-Connecting-IP'] = o.ip
  return worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx)
}
const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0]
// Flip the FIRST char: the last base64url char of a 32-byte value carries unused bits, so changing it can decode to the same bytes.
const flip = (t: string) => (t[0] === 'A' ? 'B' : 'A') + t.slice(1)
const count = (sql: string) => (raw.prepare(sql).get() as { n: number }).n

/** Runs setup and returns what a browser would hold afterwards. */
async function signedIn() {
  const res = await call('POST', '/api/setup', setupBody())
  const body: any = await res.json()
  return { res, body, cookie: cookieOf(res), csrf: body.csrf as string }
}
const addStaff = async (role: 'admin' | 'staff', email: string, password = PASS, extra = '') => {
  await ensureSchema(env.DB)
  return raw.prepare(`INSERT INTO staff (email,name,role,pw_hash${extra ? ',' + extra.split('=')[0] : ''}) VALUES (?,?,?,?${extra ? ',' + extra.split('=')[1] : ''})`).run(email, `Test ${role}`, role, await hashPassword(password, 1000))
}
const login = (email: string, password: string, o: Opts = {}) => call('POST', '/api/auth/login', { email, password }, o)

beforeEach(() => {
  const f = fakeD1(); raw = f.raw
  dbReads = 0
  const counted = new Proxy(f.d1, { get: (t, k, r) => { if (k === 'prepare') dbReads++; return Reflect.get(t, k, r) } })
  env = { DB: counted, ADMIN_KEY: 'adminkey', SESSION_SECRET: SECRET, INSTANCE_NAME: 'inst', ALLOWED_ORIGINS: '', } as unknown as Env
})
afterEach(() => vi.restoreAllMocks())

describe('password hashing', () => {
  it('hashes to pbkdf2-sha256$100000$salt$hash and verifies', async () => {
    const h = await hashPassword(PASS)
    const [scheme, iter, salt, hash] = h.split('$')
    expect([scheme, iter]).toEqual(['pbkdf2-sha256', '100000'])
    expect(atob(salt)).toHaveLength(16)
    expect(atob(hash)).toHaveLength(32)
    expect(await verifyPassword(PASS, h)).toBe(true)
    expect(await verifyPassword(PASS + 'x', h)).toBe(false)
    expect(await hashPassword(PASS)).not.toBe(h) // fresh salt
  })
  it('the iteration count lives in the hash, so a lowered count still verifies', async () => {
    expect(await verifyPassword(PASS, await hashPassword(PASS, 5000))).toBe(true)
  })
  it('malformed or out-of-range hashes are false, never a throw', async () => {
    for (const bad of ['', 'x', 'pbkdf2-sha256$100000$!!$!!', 'pbkdf2-sha256$0$AA==$AA==', 'pbkdf2-sha256$99999999$AA==$AA==', 'md5$1$a$b']) {
      expect(await verifyPassword(PASS, bad)).toBe(false)
    }
  })
  it('dummy-hash path: an unknown account still runs one full PBKDF2', async () => {
    const spy = vi.spyOn(crypto.subtle, 'deriveBits')
    expect(await verifyOrDummy(PASS, null)).toBe(false)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toMatchObject({ name: 'PBKDF2', iterations: 100000 })
    expect(DUMMY_HASH.startsWith('pbkdf2-sha256$100000$')).toBe(true)
  })
})

describe('/api/setup', () => {
  it('status says needs_setup until an admin exists', async () => {
    expect(await (await call('GET', '/api/setup/status')).json()).toEqual({ ok: true, needs_setup: true, default_country: null })
    await signedIn()
    expect(await (await call('GET', '/api/setup/status')).json()).toEqual({ ok: true, needs_setup: false, default_country: null })
  })
  it('creates the admin, settings and VAPID keys, and signs in', async () => {
    const { res, body, cookie } = await signedIn()
    expect(res.status).toBe(201)
    expect(res.headers.get('set-cookie')).toMatch(/^wl_session=v1\.[\w-]+\.[\w-]+; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=2592000$/)
    expect(body).toMatchObject({ ok: true, staff: { name: 'Test Admin', email: 'admin@example.com', role: 'admin', must_change_pw: false }, business_name: 'Example Co', default_country: 'IN', timezone: 'Asia/Kolkata' })
    expect(body.vapid_public).toMatch(/^[\w-]{87}$/) // raw P-256 point, base64url
    expect(body.whatsapp_connected).toBe(false) // fresh instance: no adaptor row, no env Cloud API vars
    const st = raw.prepare('SELECT pw_hash FROM staff').get() as any
    expect(st.pw_hash).toMatch(/^pbkdf2-sha256\$100000\$/)
    const priv = JSON.parse((raw.prepare(`SELECT value FROM settings WHERE key='vapid_private_enc'`).get() as any).value)
    expect(priv).not.toContain('"d"')
    expect(await decryptJson<JsonWebKey>(SECRET, priv, VAPID_INFO)).toMatchObject({ kty: 'EC', crv: 'P-256' })
    expect(JSON.stringify(raw.prepare('SELECT * FROM settings').all())).not.toContain(SECRET)
    expect(count('SELECT COUNT(*) n FROM events')).toBe(0)
    expect((await call('GET', '/api/auth/me', undefined, { cookie })).status).toBe(200)
  })
  it('race: two concurrent setups -> one 201, one 409, one admin', async () => {
    await ensureSchema(env.DB)
    const [a, b] = await Promise.all([
      call('POST', '/api/setup', setupBody({ admin: { ...ADMIN, email: 'a@example.com' } })),
      call('POST', '/api/setup', setupBody({ admin: { ...ADMIN, email: 'b@example.com' } })),
    ])
    expect([a.status, b.status].sort()).toEqual([201, 409])
    expect(count('SELECT COUNT(*) n FROM staff')).toBe(1)
    expect(count('SELECT COUNT(*) n FROM sessions')).toBe(1)
    expect(count(`SELECT COUNT(*) n FROM settings WHERE key='vapid_public'`)).toBe(1)
  })
  it('409 once an admin exists, even with the right key', async () => {
    await signedIn()
    const res = await call('POST', '/api/setup', setupBody())
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'setup_locked' })
  })
  it('wrong key -> 403 and nothing written', async () => {
    const res = await call('POST', '/api/setup', setupBody({ setup_key: SECRET + 'x' }))
    expect(res.status).toBe(403)
    expect(count('SELECT COUNT(*) n FROM staff')).toBe(0)
  })
  it('503 when SESSION_SECRET is unset, for setup and login', async () => {
    delete env.SESSION_SECRET
    expect((await call('POST', '/api/setup', setupBody())).status).toBe(503)
    expect(await (await call('POST', '/api/auth/login', { email: 'a@example.com', password: PASS })).json()).toMatchObject({ error: 'session_secret_missing' })
  })
  it('rate limited: the 6th attempt from one IP is 429', async () => {
    const codes: number[] = []
    for (let i = 0; i < 6; i++) codes.push((await call('POST', '/api/setup', setupBody({ setup_key: 'nope' }), { ip: '192.0.2.1' })).status)
    expect(codes).toEqual([403, 403, 403, 403, 403, 429])
  })
  it('validates the body', async () => {
    for (const over of [{ business_name: '' }, { default_country: 'India' }, { timezone: 'Mars/Base' }, { admin: { ...ADMIN, password: 'short' } }, { admin: { ...ADMIN, email: 'not-an-email' } }]) {
      expect((await call('POST', '/api/setup', setupBody(over), { ip: crypto.randomUUID() })).status).toBe(400)
    }
    expect(count('SELECT COUNT(*) n FROM staff')).toBe(0)
  })
  it('refuses a cross-origin browser request', async () => {
    expect((await call('POST', '/api/setup', setupBody(), { origin: 'https://evil.example.org' })).status).toBe(403)
  })
})

describe('sessions and the single gate', () => {
  it('a tampered cookie is 401 and costs no D1 read', async () => {
    const { cookie } = await signedIn()
    const [name, value] = cookie.split('=')
    const [v, token, mac] = value.split('.')
    const flipped = flip(mac)
    dbReads = 0
    for (const bad of [`${name}=${v}.${token}.${flipped}`, `${name}=${v}.${token}x.${mac}`, `${name}=${v}.${token}`, `${name}=garbage`]) {
      const res = await worker.fetch(new Request(`${ORIGIN}/api/inbox`, { headers: { Cookie: bad } }), env, ctx)
      expect(res.status).toBe(401)
    }
    expect(dbReads).toBe(0)
    expect((await call('GET', '/api/inbox', undefined, { cookie })).status).toBe(200) // the untouched cookie still works
    expect(dbReads).toBeGreaterThan(0)
  })
  it('stores only the SHA-256 of the token', async () => {
    const { cookie } = await signedIn()
    const token = cookie.split('=')[1].split('.')[1]
    const id = (raw.prepare('SELECT id_hash FROM sessions').get() as any).id_hash
    expect(id).toMatch(/^[0-9a-f]{64}$/)
    expect(id).not.toContain(token)
  })
  it('a cookie signed under another SESSION_SECRET is rejected', async () => {
    const { cookie } = await signedIn()
    env.SESSION_SECRET = 'a-different-secret'
    expect((await call('GET', '/api/inbox', undefined, { cookie })).status).toBe(401)
  })
  it('unauthenticated /api/* is 401, unknown or wrong bearer too', async () => {
    expect((await call('GET', '/api/inbox')).status).toBe(401)
    expect((await call('GET', '/api/nothing-here')).status).toBe(401)
    expect((await call('GET', '/api/inbox', undefined, { bearer: 'wrong' })).status).toBe(401)
  })
  it('expired session and deactivated staff are rejected', async () => {
    const { cookie } = await signedIn()
    raw.exec(`UPDATE sessions SET expires_at = unixepoch() - 1`)
    expect((await call('GET', '/api/inbox', undefined, { cookie })).status).toBe(401)
    raw.exec(`UPDATE sessions SET expires_at = unixepoch() + 1000`)
    expect((await call('GET', '/api/inbox', undefined, { cookie })).status).toBe(200)
    raw.exec(`UPDATE staff SET active = 0`)
    expect((await call('GET', '/api/inbox', undefined, { cookie })).status).toBe(401)
  })
  it('slides the session at most once a day and re-issues the cookie', async () => {
    const { cookie } = await signedIn()
    const fresh = await call('GET', '/api/inbox', undefined, { cookie })
    expect(fresh.headers.get('set-cookie')).toBeNull()
    raw.exec(`UPDATE sessions SET last_seen_at = unixepoch() - 90000, expires_at = unixepoch() + 100`)
    const slid = await call('GET', '/api/inbox', undefined, { cookie })
    expect(slid.headers.get('set-cookie')).toContain('Max-Age=2592000')
    expect(count('SELECT COUNT(*) n FROM sessions WHERE expires_at > unixepoch() + 2500000')).toBe(1)
  })
  it('only admins reach /api/admin/*; staff reach the shared routes', async () => {
    await addStaff('staff', 'staff@example.com')
    const res = await login('staff@example.com', PASS)
    const body: any = await res.json()
    const o = { cookie: cookieOf(res), csrf: body.csrf }
    expect((await call('GET', '/api/inbox', undefined, o)).status).toBe(200)
    expect((await call('GET', '/api/admin/adaptor', undefined, o)).status).toBe(403)
    expect((await call('GET', '/api/admin/adaptor', undefined, { bearer: 'adminkey' })).status).toBe(200)
  })
  it('must_change_pw blocks everything except /api/auth/*', async () => {
    await addStaff('admin', 'admin@example.com', PASS, 'must_change_pw=1')
    const res = await login('admin@example.com', PASS)
    const body: any = await res.json()
    expect(body.staff.must_change_pw).toBe(true)
    const o = { cookie: cookieOf(res), csrf: body.csrf }
    expect((await call('GET', '/api/inbox', undefined, o)).status).toBe(403)
    expect((await call('GET', '/api/auth/me', undefined, o)).status).toBe(200)
  })
})

describe('CSRF', () => {
  it('state-changing session requests need a matching X-CSRF-Token and same-origin Origin', async () => {
    const { cookie, csrf } = await signedIn()
    const payload = { text: 'hi' }
    const statuses = {
      missing: (await call('POST', '/api/send', payload, { cookie })).status,
      wrong: (await call('POST', '/api/send', payload, { cookie, csrf: flip(csrf) })).status,
      noOrigin: (await call('POST', '/api/send', payload, { cookie, csrf, origin: null })).status,
      badOrigin: (await call('POST', '/api/send', payload, { cookie, csrf, origin: 'https://evil.example.org' })).status,
    }
    expect(statuses).toEqual({ missing: 403, wrong: 403, noOrigin: 403, badOrigin: 403 })
    // right token + origin passes the gate (the handler then rejects the empty body: 400, not 403)
    expect((await call('POST', '/api/send', {}, { cookie, csrf })).status).toBe(400)
  })
  it('a CSRF token from another session does not work', async () => {
    const a = await signedIn()
    await addStaff('staff', 'staff@example.com')
    const other: any = await (await login('staff@example.com', PASS)).json()
    expect((await call('POST', '/api/send', {}, { cookie: a.cookie, csrf: other.csrf })).status).toBe(403)
  })
  it('GET needs no CSRF token', async () => {
    const { cookie } = await signedIn()
    expect((await call('GET', '/api/leads', undefined, { cookie })).status).toBe(200)
  })
  it('ADMIN_KEY works with no CSRF token and no Origin', async () => {
    const res = await call('POST', '/api/send', {}, { bearer: 'adminkey', origin: null })
    expect(res.status).toBe(400) // got past the gate to the handler
  })
  it('a CSRF failure on logout leaves the session alive', async () => {
    const { cookie } = await signedIn()
    expect((await call('POST', '/api/auth/logout', undefined, { cookie })).status).toBe(403)
    expect(count('SELECT COUNT(*) n FROM sessions')).toBe(1)
  })
})

describe('login, logout, me, password', () => {
  it('logs in, returns me with a CSRF token, updates last_login_at', async () => {
    await signedIn()
    const res = await login('ADMIN@example.com', PASS)  // email is case-insensitive
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body).toMatchObject({ ok: true, staff: { role: 'admin' } })
    expect(body.csrf).toMatch(/^[\w-]{43}$/)
    expect(count('SELECT COUNT(*) n FROM staff WHERE last_login_at IS NOT NULL')).toBe(1)
    expect(count('SELECT COUNT(*) n FROM sessions')).toBe(2)
  })
  it('wrong password and unknown email give the same generic 401', async () => {
    await signedIn()
    const a = await login('admin@example.com', 'wrong-password-1')
    const b = await login('nobody@example.com', 'wrong-password-1')
    expect([a.status, b.status]).toEqual([401, 401])
    expect(await a.json()).toEqual(await b.json())
    expect(a.headers.get('set-cookie')).toBeNull()
  })
  it('an unknown email still runs a full PBKDF2 (timing equalised)', async () => {
    await ensureSchema(env.DB)
    const spy = vi.spyOn(crypto.subtle, 'deriveBits')
    await login('nobody@example.com', 'wrong-password-1')
    expect(spy.mock.calls.filter((c) => (c[0] as any).name === 'PBKDF2')).toHaveLength(1)
  })
  it('a deactivated account cannot log in', async () => {
    await signedIn()
    raw.exec('UPDATE staff SET active = 0')
    expect((await login('admin@example.com', PASS)).status).toBe(401)
  })
  it('per-email limit counts only failures: 5 failures then the right password from a fresh IP is 200, and clears the counter', async () => {
    await signedIn()
    for (let i = 0; i < 5; i++) expect((await login('admin@example.com', 'wrong-password-1', { ip: `192.0.2.${20 + i}` })).status).toBe(401)
    expect((await login('ADMIN@example.com', PASS, { ip: '192.0.2.99' })).status).toBe(200) // case-folded key
    expect(count(`SELECT COUNT(*) n FROM rate_limits WHERE key='login:email:admin@example.com'`)).toBe(0)
    for (let i = 0; i < 5; i++) expect((await login('admin@example.com', 'wrong-password-1', { ip: `192.0.2.${30 + i}` })).status).toBe(401)
  })
  it('6 failures lock the email: the next attempt is 429, even with the right password', async () => {
    await signedIn()
    const codes: number[] = []
    for (let i = 0; i < 6; i++) codes.push((await login('admin@example.com', 'wrong-password-1', { ip: `192.0.2.${40 + i}` })).status)
    codes.push((await login('admin@example.com', PASS, { ip: '192.0.2.99' })).status)
    expect(codes).toEqual([401, 401, 401, 401, 401, 401, 429])
  })
  it('successful logins do not count toward the per-email limit', async () => {
    await signedIn()
    for (let i = 0; i < 8; i++) expect((await login('admin@example.com', PASS, { ip: `192.0.2.${60 + i}` })).status).toBe(200)
  })
  it('cookie renewal reaches the browser from /api/auth/me and /api/auth/password too', async () => {
    const { cookie, csrf } = await signedIn()
    raw.exec(`UPDATE sessions SET last_seen_at = unixepoch() - 90000, expires_at = unixepoch() + 100`)
    const me = await call('GET', '/api/auth/me', undefined, { cookie })
    expect(me.headers.get('set-cookie')).toMatch(/^wl_session=v1\..*Max-Age=2592000/)
    raw.exec(`UPDATE sessions SET last_seen_at = unixepoch() - 90000`)
    const pw = await call('POST', '/api/auth/password', { current_password: PASS, new_password: 'a-brand-new-pass' }, { cookie, csrf })
    expect(pw.status).toBe(200)
    expect(pw.headers.get('set-cookie')).toContain('Max-Age=2592000')
  })
  it('limits per IP: the 11th attempt from one address is 429', async () => {
    await ensureSchema(env.DB)
    const codes: number[] = []
    for (let i = 0; i < 11; i++) codes.push((await login(`user${i}@example.com`, PASS, { ip: '192.0.2.9' })).status)
    expect(codes).toEqual([...Array(10).fill(401), 429])
    expect((await login('user99@example.com', PASS, { ip: '192.0.2.10' })).status).toBe(401) // another IP is unaffected
  })
  it('the limit window expires', async () => {
    await ensureSchema(env.DB)
    for (let i = 0; i < 6; i++) await login('x@example.com', PASS)
    raw.exec(`UPDATE rate_limits SET window_start = window_start - 901`)
    expect((await login('x@example.com', PASS)).status).toBe(401)
  })
  it('logout deletes the session row and clears the cookie', async () => {
    const { cookie, csrf } = await signedIn()
    const res = await call('POST', '/api/auth/logout', undefined, { cookie, csrf })
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(count('SELECT COUNT(*) n FROM sessions')).toBe(0)
    expect((await call('GET', '/api/auth/me', undefined, { cookie })).status).toBe(401)
  })
  it('logout with no session is a harmless 200', async () => {
    expect((await call('POST', '/api/auth/logout')).status).toBe(200)
  })
  it('me needs a staff session (the ADMIN_KEY has no profile)', async () => {
    expect((await call('GET', '/api/auth/me')).status).toBe(401)
    expect((await call('GET', '/api/auth/me', undefined, { bearer: 'adminkey' })).status).toBe(400)
  })
  it('change password: checks the current one, enforces length, revokes the other sessions', async () => {
    const { cookie, csrf } = await signedIn()
    const other = await login('admin@example.com', PASS)
    const o = { cookie, csrf }
    expect((await call('POST', '/api/auth/password', { current_password: 'wrong-wrong-1', new_password: 'a-brand-new-pass' }, o)).status).toBe(403)
    expect((await call('POST', '/api/auth/password', { current_password: PASS, new_password: 'short' }, o)).status).toBe(400)
    expect((await call('POST', '/api/auth/password', { current_password: PASS, new_password: PASS }, o)).status).toBe(400)
    const ok = await call('POST', '/api/auth/password', { current_password: PASS, new_password: 'a-brand-new-pass' }, o)
    expect(ok.status).toBe(200)
    expect(count('SELECT COUNT(*) n FROM sessions')).toBe(1)
    expect((await call('GET', '/api/auth/me', undefined, { cookie: cookieOf(other) })).status).toBe(401)
    expect((await call('GET', '/api/auth/me', undefined, { cookie })).status).toBe(200)
    expect((await login('admin@example.com', PASS, { ip: '192.0.2.77' })).status).toBe(401)
    expect((await login('admin@example.com', 'a-brand-new-pass', { ip: '192.0.2.78' })).status).toBe(200)
  })
  it('change password clears must_change_pw', async () => {
    await addStaff('admin', 'admin@example.com', PASS, 'must_change_pw=1')
    const res = await login('admin@example.com', PASS)
    const body: any = await res.json()
    const o = { cookie: cookieOf(res), csrf: body.csrf }
    expect((await call('POST', '/api/auth/password', { current_password: PASS, new_password: 'a-brand-new-pass' }, o)).status).toBe(200)
    expect((await call('GET', '/api/inbox', undefined, o)).status).toBe(200)
  })
})

describe('rate limiter and intake', () => {
  it('hit(): limit hits pass, the next is limited, the window resets', async () => {
    await ensureSchema(env.DB)
    const r: boolean[] = []
    for (let i = 0; i < 4; i++) r.push(await hit(env.DB, 'k', 3, 60))
    expect(r).toEqual([false, false, false, true])
    raw.exec(`UPDATE rate_limits SET window_start = window_start - 61`)
    expect(await hit(env.DB, 'k', 3, 60)).toBe(false)
    expect(count(`SELECT count n FROM rate_limits WHERE key='k'`)).toBe(1)
  })
  it('intake is unchanged: key leads:<ip>, 10 per 60 s, the 11th is 429', async () => {
    env.ALLOWED_ORIGINS = ORIGIN
    const lead = () => call('POST', '/api/leads', { name: 'Test Lead', phone: '+15550000001', source: 'contact_form' }, { ip: '192.0.2.5' })
    const codes: number[] = []
    for (let i = 0; i < 11; i++) codes.push((await lead()).status)
    expect(codes).toEqual([...Array(10).fill(200), 429])
    expect(count(`SELECT COUNT(*) n FROM rate_limits WHERE key='leads:192.0.2.5'`)).toBe(1)
    expect(count('SELECT COUNT(*) n FROM leads')).toBe(10)
  })
})

describe('/api/auth/recover (D26)', () => {
  const NEW = 'a-recovered-password'
  const recover = (over: Record<string, unknown> = {}, o: Opts = {}) =>
    call('POST', '/api/auth/recover', { setup_key: SECRET, email: 'admin@example.com', new_password: NEW, ...over }, { ip: o.ip ?? crypto.randomUUID(), ...o })
  const pwHash = () => (raw.prepare(`SELECT pw_hash FROM staff WHERE email='admin@example.com'`).get() as { pw_hash: string }).pw_hash

  it('wrong key -> 403 invalid_recovery and nothing changes', async () => {
    const { cookie } = await signedIn()
    const before = pwHash()
    const res = await recover({ setup_key: SECRET + 'x' })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ ok: false, error: 'invalid_recovery' })
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(pwHash()).toBe(before)
    expect((await call('GET', '/api/auth/me', undefined, { cookie })).status).toBe(200)
  })
  it('unknown email gives the identical 403 body, with the same work and no PBKDF2 either way', async () => {
    await signedIn()
    const spy = vi.spyOn(crypto.subtle, 'deriveBits')
    const wrongKey = await recover({ setup_key: 'nope' })
    const unknown = await recover({ email: 'nobody@example.com' })
    expect([wrongKey.status, unknown.status]).toEqual([403, 403])
    expect(await unknown.json()).toEqual(await wrongKey.json())
    expect(spy.mock.calls.filter((c) => (c[0] as any).name === 'PBKDF2')).toHaveLength(0)
  })
  it('an inactive staff member cannot be recovered', async () => {
    await signedIn()
    await addStaff('staff', 'gone@example.com', PASS, 'active=0')
    const res = await recover({ email: 'gone@example.com' })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ ok: false, error: 'invalid_recovery' })
  })
  it('validates the new password and email', async () => {
    await signedIn()
    expect((await recover({ new_password: 'short' })).status).toBe(400)
    expect((await recover({ new_password: 'x'.repeat(201) })).status).toBe(400)
    expect((await recover({ email: 'not-an-email' })).status).toBe(400)
  })
  it('success: signs in, ends every old session, sets the new password, clears must_change_pw, logs an event', async () => {
    const { cookie } = await signedIn()
    const other = await login('admin@example.com', PASS)
    raw.exec(`UPDATE staff SET must_change_pw = 1`)
    for (let i = 0; i < 3; i++) await login('admin@example.com', 'wrong-password-1', { ip: `192.0.2.${120 + i}` })
    const res = await recover({ email: 'ADMIN@example.com' })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body).toMatchObject({ ok: true, staff: { email: 'admin@example.com', role: 'admin', must_change_pw: false } })
    expect(res.headers.get('set-cookie')).toMatch(/^wl_session=v1\..*HttpOnly; Secure; SameSite=Lax/)
    expect(count('SELECT COUNT(*) n FROM sessions')).toBe(1)
    expect((await call('GET', '/api/auth/me', undefined, { cookie })).status).toBe(401)
    expect((await call('GET', '/api/auth/me', undefined, { cookie: cookieOf(other) })).status).toBe(401)
    expect((await call('GET', '/api/inbox', undefined, { cookie: cookieOf(res), csrf: body.csrf })).status).toBe(200)
    expect(count('SELECT COUNT(*) n FROM staff WHERE must_change_pw = 1')).toBe(0)
    expect(count(`SELECT COUNT(*) n FROM rate_limits WHERE key='login:email:admin@example.com'`)).toBe(0)
    const ev = raw.prepare(`SELECT payload FROM events WHERE kind='staff_password_recovered'`).all() as { payload: string }[]
    expect(ev.map((e) => JSON.parse(e.payload))).toEqual([{ id: body.staff.id, by: 'recovery' }])
    expect(ev[0].payload).not.toContain(NEW)
    expect((await login('admin@example.com', PASS, { ip: '192.0.2.130' })).status).toBe(401)
    expect((await login('admin@example.com', NEW, { ip: '192.0.2.131' })).status).toBe(200)
  })
  it('works for a non-admin staff row too (the key holder owns the instance)', async () => {
    await signedIn()
    await addStaff('staff', 'member@example.com')
    const res = await recover({ email: 'member@example.com' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ staff: { email: 'member@example.com', role: 'staff' } })
  })
  it('per IP: every attempt counts, the 6th from one address is 429 with retry-after', async () => {
    await signedIn()
    const codes: number[] = []
    for (let i = 0; i < 6; i++) codes.push((await recover({ setup_key: 'nope' }, { ip: '192.0.2.140' })).status)
    expect(codes).toEqual([403, 403, 403, 403, 403, 429])
    const blocked = await recover({}, { ip: '192.0.2.140' }) // even the right key
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('retry-after')).toBe('900')
    expect((await login('admin@example.com', PASS, { ip: '192.0.2.141' })).status).toBe(200)
  })
  it('global: the 21st attempt in an hour from any address is 429', async () => {
    await signedIn()
    const codes: number[] = []
    for (let i = 0; i < 21; i++) codes.push((await recover({ setup_key: 'nope' }, { ip: `198.51.100.${i}` })).status)
    expect(codes).toEqual([...Array(20).fill(403), 429])
    const blocked = await recover({}, { ip: '198.51.100.200' })
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('retry-after')).toBe('3600')
    raw.exec(`UPDATE rate_limits SET window_start = window_start - 3601 WHERE key='recover:all'`)
    expect((await recover({}, { ip: '198.51.100.201' })).status).toBe(200)
  })
  it('refuses a cross-origin browser request', async () => {
    await signedIn()
    const before = pwHash()
    expect((await recover({}, { origin: 'https://evil.example.org' })).status).toBe(403)
    expect(pwHash()).toBe(before)
  })
  it('503 when SESSION_SECRET is unset', async () => {
    await signedIn()
    delete env.SESSION_SECRET
    const res = await recover()
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: 'session_secret_missing' })
  })
})
