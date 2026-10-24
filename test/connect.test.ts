// one-click Connect to WhaBuzz, WhaLeads side, against a fake WhaBuzz (fetch stub).
import { EXPORT_SETTINGS } from '../src/export'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'
import { ensureSchema, type Env } from '../src/db'
import { b64url, sha256Hex } from '../src/auth'
import { decryptJson } from '../src/crypto'
import { hashPassword } from '../src/password'
import { connectAvailable, resolveConnectBase } from '../src/adaptors/whabuzz'
import { CONNECT_INFO } from '../src/routes/connect'
import { ctx } from './helpers'
import { fakeD1 } from './d1'

const SECRET = 'test-session-secret-0123456789'
const ORIGIN = 'https://leads.example.com'
const PASS = 'correct horse battery'
const CB = `${ORIGIN}/api/whabuzz/callback`
const GRANT = { api_key: 'wb_live_TEST_abcdef', webhook_secret: 'whsec_TEST_abc123', phone_number_id: '1000000000000002', waba_id: '2605997', tenant_id: 'tenant_demo_1', display_phone_number: '+1 555 0100' }

let env: Env
let raw: DatabaseSync
type Sess = { cookie: string; csrf: string }
type Fake = { exchange: () => Response; numbers: () => Response; calls: { url: string; init?: RequestInit }[] }
let fake: Fake

const jsonRes = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })
const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0]!

function call(method: string, path: string, s?: Sess, body?: unknown, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...extra }
  if (s) { headers.Cookie = s.cookie; if (method !== 'GET') { headers['X-CSRF-Token'] = s.csrf; headers.Origin = ORIGIN } }
  else if (method !== 'GET') headers.Origin = ORIGIN
  return worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx)
}
async function admin(): Promise<Sess> {
  const res = await call('POST', '/api/setup', undefined, { setup_key: SECRET, business_name: 'Example Co', default_country: 'IN', timezone: 'Asia/Kolkata', admin: { name: 'A', email: 'admin@example.com', password: PASS } })
  const b: any = await res.json()
  return { cookie: cookieOf(res), csrf: b.csrf }
}
async function login(email: string, role: 'admin' | 'staff'): Promise<Sess> {
  await ensureSchema(env.DB)
  raw.prepare(`INSERT INTO staff (email,name,role,pw_hash) VALUES (?,?,?,?)`).run(email, email, role, await hashPassword(PASS, 1000))
  const res = await call('POST', '/api/auth/login', undefined, { email, password: PASS })
  const b: any = await res.json()
  return { cookie: cookieOf(res), csrf: b.csrf }
}
const startOk = async (s: Sess) => {
  const res = await call('POST', '/api/connect/whabuzz/start', s)
  expect(res.status).toBe(200)
  return new URL(((await res.json()) as any).url as string)
}
const cb = (s: Sess | undefined, qs: string, extra: Record<string, string> = {}) => call('GET', `/api/whabuzz/callback?${qs}`, s, undefined, extra)
const loc = (r: Response) => new URL(r.headers.get('location') ?? '', ORIGIN)
const count = (sql: string) => (raw.prepare(sql).get() as { n: number }).n
const adaptors = () => count(`SELECT COUNT(*) n FROM adaptor_config`)
const pending = () => count(`SELECT COUNT(*) n FROM settings WHERE key='connect_pending'`)

beforeEach(() => {
  const f = fakeD1(); raw = f.raw
  env = { DB: f.d1, ADMIN_KEY: 'adminkey', SESSION_SECRET: SECRET, INSTANCE_NAME: 'inst', ALLOWED_ORIGINS: '', WHABUZZ_CONNECT_BASE: 'https://app.whabuzz.com' } as unknown as Env
  fake = {
    calls: [],
    exchange: () => jsonRes(GRANT),
    numbers: () => jsonRes({ connection_state: 'connected', display_phone_number: '+1 555 0100', verified_name: 'Example Co' }),
  }
  vi.stubGlobal('fetch', async (input: any, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    fake.calls.push({ url, init })
    if (url.endsWith('/connect/token')) return fake.exchange()
    if (url.includes('/numbers/')) return fake.numbers()
    return jsonRes({}, 404)
  })
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('POST /api/connect/whabuzz/start', () => {
  it('is admin-only, CSRF-gated and needs a browser session', async () => {
    expect((await call('POST', '/api/connect/whabuzz/start')).status).toBe(401)
    const a = await admin()
    expect((await call('POST', '/api/connect/whabuzz/start', { ...a, csrf: 'nope' })).status).toBe(403)
    const staff = await login('s@example.com', 'staff')
    expect((await call('POST', '/api/connect/whabuzz/start', staff)).status).toBe(403)
    const bearer = await worker.fetch(new Request(`${ORIGIN}/api/connect/whabuzz/start`, { method: 'POST', headers: { Authorization: 'Bearer adminkey' } }), env, ctx)
    expect(bearer.status).toBe(403)
    expect(pending()).toBe(0)
  })

  it('returns a well-formed hosted URL (live contract shape) and stores the pending connect encrypted', async () => {
    const a = await admin()
    const u = await startOk(a)
    expect(`${u.origin}${u.pathname}`).toBe('https://app.whabuzz.com/connect')
    expect(u.searchParams.get('app')).toBe('whaleads')
    expect(u.searchParams.get('callback')).toBe(CB)
    expect([...u.searchParams.keys()].sort()).toEqual(['app', 'callback', 'code_challenge', 'state'])
    expect(u.toString().length).toBeLessThan(500)
    const state = u.searchParams.get('state')!
    expect(state).toMatch(/^[\x21-\x7e]{1,200}$/)
    expect(state).toMatch(/^[\w-]{43}$/)
    const row = raw.prepare(`SELECT value FROM settings WHERE key='connect_pending'`).get() as { value: string }
    const p = await decryptJson<any>(SECRET, JSON.parse(row.value), CONNECT_INFO)
    expect(p.verifier).toMatch(/^[\w-]{43}$/)
    expect(p.state_hash).toBe(await sha256Hex(state))
    expect(p.exp - Math.floor(Date.now() / 1000)).toBeGreaterThan(590)
    expect(u.searchParams.get('code_challenge')).toBe(b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(p.verifier)))))
    // nothing readable at rest
    expect(row.value).not.toContain(p.verifier)
    expect(row.value).not.toContain(state)
  })

  it('a new start replaces the pending row; the old state no longer works', async () => {
    const a = await admin()
    const first = await startOk(a)
    await startOk(a)
    expect(pending()).toBe(1)
    const r = await cb(a, `code=abcdefgh1234&state=${first.searchParams.get('state')}`)
    expect(loc(r).searchParams.get('connect_error')).toBe('state_mismatch')
  })

  it('is limited to 5 starts per 10 minutes per staff member', async () => {
    const a = await admin()
    for (let i = 0; i < 5; i++) expect((await call('POST', '/api/connect/whabuzz/start', a)).status).toBe(200)
    expect((await call('POST', '/api/connect/whabuzz/start', a)).status).toBe(429)
  })

  it('honours WHABUZZ_CONNECT_BASE and refuses a foreign host', async () => {
    const a = await admin()
    env.WHABUZZ_CONNECT_BASE = 'https://staging.whabuzz.com'
    expect((await startOk(a)).origin).toBe('https://staging.whabuzz.com')
    env.WHABUZZ_CONNECT_BASE = 'https://evil.example.com'
    expect((await call('POST', '/api/connect/whabuzz/start', a)).status).toBe(500)
  })

  it('resolveConnectBase allow-list', () => {
    expect(() => resolveConnectBase()).toThrow()
    expect(connectAvailable(undefined)).toBe(false)
    expect(connectAvailable('  ')).toBe(false)
    expect(connectAvailable('https://evil.example.com')).toBe(false)
    expect(connectAvailable('https://app.whabuzz.com')).toBe(true)
    expect(resolveConnectBase('https://app.whabuzz.com/')).toBe('https://app.whabuzz.com')
    expect(resolveConnectBase('http://127.0.0.1:9002')).toBe('http://127.0.0.1:9002')
    for (const bad of ['http://app.whabuzz.com', 'https://whabuzz.com.evil.com', 'https://evilwhabuzz.com', 'https://u:p@app.whabuzz.com', 'ftp://app.whabuzz.com', 'nope', 'http://10.0.0.1']) expect(() => resolveConnectBase(bad)).toThrow()
  })
})

describe('GET /api/whabuzz/callback', () => {
  it('happy path: exchanges with the PKCE verifier, saves the adaptor (no second verify call)', async () => {
    const a = await admin()
    const u = await startOk(a)
    const row = raw.prepare(`SELECT value FROM settings WHERE key='connect_pending'`).get() as { value: string }
    const verifier = (await decryptJson<any>(SECRET, JSON.parse(row.value), CONNECT_INFO)).verifier
    const r = await cb(a, `code=code012345678901234567890123456789012345678&state=${u.searchParams.get('state')}`)
    expect(r.status).toBe(302)
    expect(loc(r).pathname + loc(r).search).toBe('/settings/whatsapp?connected=1')
    expect(r.headers.get('referrer-policy')).toBe('no-referrer')

    const ex = fake.calls.find((c) => c.url.endsWith('/connect/token'))!
    expect(ex.url).toBe('https://api.whabuzz.com/connect/token') // API root, not under /v1
    expect(JSON.parse(String(ex.init!.body))).toEqual({ app: 'whaleads', code: 'code012345678901234567890123456789012345678', state: u.searchParams.get('state'), code_verifier: verifier })
    expect(verifier).toMatch(/^[\w-]{43,128}$/)
    expect((ex.init!.headers as Record<string, string>).Authorization).toBeUndefined()
    // no verify call after the exchange, and nothing that a connect-issued key may not do
    expect(fake.calls.map((c) => new URL(c.url).pathname).sort()).toEqual(['/connect/token', `/v1/numbers/${GRANT.phone_number_id}`])

    expect(pending()).toBe(0)
    const stored = raw.prepare(`SELECT kind, config_enc FROM adaptor_config`).get() as any
    expect(stored.kind).toBe('whabuzz')
    const info: any = JSON.parse((raw.prepare(`SELECT value FROM settings WHERE key='whabuzz_connect_info'`).get() as any).value)
    expect(info).toEqual({ phone_number_id: GRANT.phone_number_id, display_phone_number: GRANT.display_phone_number, tenant_id: GRANT.tenant_id })
    expect(await decryptJson<any>(SECRET, stored.config_enc)).toEqual({ api_key: GRANT.api_key, phone_number_id: GRANT.phone_number_id, waba_id: GRANT.waba_id, webhook_secret: GRANT.webhook_secret })
    const ev = raw.prepare(`SELECT payload FROM events WHERE kind='adaptor_changed'`).get() as { payload: string }
    expect(JSON.parse(ev.payload)).toMatchObject({ kind: 'whabuzz', via: 'connect' })
    // the active connection is now whabuzz and not a sandbox
    const got: any = await (await call('GET', '/api/admin/adaptor', a)).json()
    expect(got).toMatchObject({ kind: 'whabuzz', onboarding: 'connect_button', sandbox: false, connect_info: { display_phone_number: GRANT.display_phone_number, tenant_id: GRANT.tenant_id } })
  })

  it('a wb_test_ key prefix (never issued by connect today) still shows as sandbox', async () => {
    const a = await admin()
    fake.exchange = () => jsonRes({ ...GRANT, api_key: 'wb_test_TEST_abcdef' })
    const u = await startOk(a)
    await cb(a, `code=code012345678901234567890123456789012345678&state=${u.searchParams.get('state')}`)
    expect(await (await call('GET', '/api/admin/adaptor', a)).json()).toMatchObject({ kind: 'whabuzz', sandbox: true })
  })

  it('redirects to /login?next= without a session, and consumes nothing', async () => {
    const a = await admin()
    const u = await startOk(a)
    const qs = `code=code012345678901234567890123456789012345678&state=${u.searchParams.get('state')}`
    const r = await cb(undefined, qs)
    expect(r.status).toBe(302)
    expect(loc(r).pathname).toBe('/login')
    expect(loc(r).searchParams.get('next')).toBe(`/api/whabuzz/callback?${qs}`)
    expect(pending()).toBe(1)
    expect(fake.calls).toHaveLength(0)
    // and after signing in the same URL completes
    expect(loc(await cb(a, qs)).searchParams.get('connected')).toBe('1')
  })

  it('state mismatch: nothing saved, no exchange, and the real pending row survives', async () => {
    const a = await admin()
    await startOk(a)
    const r = await cb(a, 'code=code012345678901234567890123456789012345678&state=wrong')
    expect(loc(r).searchParams.get('connect_error')).toBe('state_mismatch')
    expect(adaptors()).toBe(0)
    expect(pending()).toBe(1)
    expect(fake.calls).toHaveLength(0)
  })

  it('a pending connect started in another session is refused', async () => {
    const a = await admin()
    const u = await startOk(a)
    const other = await login('b@example.com', 'admin')
    const r = await cb(other, `code=code012345678901234567890123456789012345678&state=${u.searchParams.get('state')}`)
    expect(loc(r).searchParams.get('connect_error')).toBe('state_mismatch')
    expect(adaptors()).toBe(0)
    expect(fake.calls).toHaveLength(0)
    expect(pending()).toBe(1) // the owner's pending connect is not wiped by someone else's callback
    const ok = await cb(a, `code=code012345678901234567890123456789012345678&state=${u.searchParams.get('state')}`)
    expect(loc(ok).searchParams.get('connected')).toBe('1')
  })

  it('a forged callback (wrong state) does not wipe a real pending connect', async () => {
    const a = await admin()
    const u = await startOk(a)
    for (let i = 0; i < 3; i++) expect(loc(await cb(a, `code=code012345678901234567890123456789012345678&state=forged${i}`)).searchParams.get('connect_error')).toBe('state_mismatch')
    expect(pending()).toBe(1)
    expect(loc(await cb(a, `code=code012345678901234567890123456789012345678&state=${u.searchParams.get('state')}`)).searchParams.get('connected')).toBe('1')
    expect(pending()).toBe(0)
  })

  it('single use: only the call whose delete changes one row proceeds', async () => {
    const a = await admin()
    const u = await startOk(a)
    const q = `code=code012345678901234567890123456789012345678&state=${u.searchParams.get('state')}`
    const [r1, r2] = await Promise.all([cb(a, q), cb(a, q)])
    const outcomes = [r1, r2].map((r) => loc(r).searchParams.get('connected') ?? loc(r).searchParams.get('connect_error')).sort()
    expect(outcomes).toEqual(['1', 'state_mismatch'])
    expect(fake.calls.filter((c) => c.url.endsWith('/connect/token'))).toHaveLength(1)
  })

  it('the signed-in callback budget is per staff member, not per IP', async () => {
    const a = await admin()
    for (let i = 0; i < 10; i++) await cb(a, 'code=x&state=y', { 'cf-connecting-ip': `203.0.113.${i}` })
    expect(loc(await cb(a, 'code=x&state=y', { 'cf-connecting-ip': '203.0.113.99' })).searchParams.get('connect_error')).toBe('too_many_attempts')
    // signed-out hits from an unrelated IP do not touch the admin's bucket
    const b = await login('b2@example.com', 'admin')
    expect(loc(await cb(b, 'code=x&state=y')).searchParams.get('connect_error')).toBe('state_mismatch')
  })

  it('without WHABUZZ_CONNECT_BASE: start is 409 connect_unavailable and the adaptor GET says connect_available=false', async () => {
    const a = await admin()
    delete env.WHABUZZ_CONNECT_BASE
    const r = await call('POST', '/api/connect/whabuzz/start', a)
    expect(r.status).toBe(409)
    expect(((await r.json()) as any).error).toBe('connect_unavailable')
    expect(pending()).toBe(0)
    expect(((await (await call('GET', '/api/admin/adaptor', a)).json()) as any).connect_available).toBe(false)
    env.WHABUZZ_CONNECT_BASE = 'https://app.whabuzz.com'
    expect(((await (await call('GET', '/api/admin/adaptor', a)).json()) as any).connect_available).toBe(true)
    expect((await call('POST', '/api/connect/whabuzz/start', a)).status).toBe(200)
  })

  it('a non-admin session is refused', async () => {
    const a = await admin()
    const u = await startOk(a)
    const staff = await login('s@example.com', 'staff')
    expect(loc(await cb(staff, `code=code012345678901234567890123456789012345678&state=${u.searchParams.get('state')}`)).searchParams.get('connect_error')).toBe('forbidden')
    expect(fake.calls).toHaveLength(0)
  })

  it('expired: nothing saved, invalid_code', async () => {
    const a = await admin()
    const u = await startOk(a)
    const real = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(real + 11 * 60_000)
    const r = await cb(a, `code=code012345678901234567890123456789012345678&state=${u.searchParams.get('state')}`)
    expect(loc(r).searchParams.get('connect_error')).toBe('invalid_code')
    expect(adaptors()).toBe(0)
    expect(fake.calls).toHaveLength(0)
  })

  it('replayed callback: second use is refused and exchanges nothing', async () => {
    const a = await admin()
    const u = await startOk(a)
    const qs = `code=code012345678901234567890123456789012345678&state=${u.searchParams.get('state')}`
    expect(loc(await cb(a, qs)).searchParams.get('connected')).toBe('1')
    const before = fake.calls.length
    expect(loc(await cb(a, qs)).searchParams.get('connect_error')).toBe('state_mismatch')
    expect(fake.calls.length).toBe(before)
  })

  it('every exchange error code maps to its redirect, saves nothing, and code_used also logs connect_revoked', async () => {
    await admin()
    const table: [number, string, string, Record<string, string>?][] = [
      [400, 'unknown_app', 'unknown_app'], [400, 'invalid_code', 'invalid_code'], [410, 'code_used', 'code_used'], [410, 'code_expired', 'code_expired'],
      [410, 'connection_gone', 'connection_gone'], [409, 'connection_unavailable', 'connection_unavailable'], [429, 'rate_limited', 'rate_limited', { 'retry-after': '30' }],
      [400, 'something_new', 'invalid_code'], [429, '', 'rate_limited'], [502, '', 'exchange_failed'],
    ]
    let n = 0
    for (const [status, code, want] of table) {
      const a = await login(`e${n++}@example.com`, 'admin') // a fresh person per row: start and callback budgets are per staff member
      fake.exchange = () => new Response(JSON.stringify(code ? { error: { code, message: 'x' } } : {}), { status, headers: { 'content-type': 'application/json' } })
      const u = await startOk(a)
      const r = await cb(a, `code=code012345678901234567890123456789012345678&state=${u.searchParams.get('state')}`)
      expect(loc(r).searchParams.get('connect_error'), `${status} ${code}`).toBe(want)
      expect(loc(r).searchParams.get('detail')).toBeNull()
    }
    expect(adaptors()).toBe(0)
    expect(count(`SELECT COUNT(*) n FROM events WHERE kind='connect_revoked'`)).toBe(1)
    expect(count(`SELECT COUNT(*) n FROM events WHERE kind='connect_done'`)).toBe(0)
  })

  it('a wrong-state callback never reaches WhaBuzz; the state is sent in the exchange body', async () => {
    const a = await admin()
    const u = await startOk(a)
    await cb(a, 'code=code012345678901234567890123456789012345678&state=nope')
    expect(fake.calls).toHaveLength(0)
    await cb(a, `code=code012345678901234567890123456789012345678&state=${u.searchParams.get('state')}`)
    expect(JSON.parse(String(fake.calls[0]!.init!.body)).state).toBe(u.searchParams.get('state'))
  })

  it('exchange 5xx -> exchange_failed', async () => {
    const a = await admin()
    fake.exchange = () => jsonRes({}, 503)
    const u = await startOk(a)
    expect(loc(await cb(a, `code=code012345678901234567890123456789012345678&state=${u.searchParams.get('state')}`)).searchParams.get('connect_error')).toBe('exchange_failed')
    expect(adaptors()).toBe(0)
  })

  it('a malformed grant saves nothing', async () => {
    const a = await admin()
    fake.exchange = () => jsonRes({ api_key: 'x' })
    const u = await startOk(a)
    expect(loc(await cb(a, `code=code012345678901234567890123456789012345678&state=${u.searchParams.get('state')}`)).searchParams.get('connect_error')).toBe('exchange_failed')
    expect(adaptors()).toBe(0)
  })

  it('status() failure after a good exchange: grant is still saved, redirect carries a warning', async () => {
    const a = await admin()
    fake.numbers = () => jsonRes({ source: 'whabuzz', error: { message: 'number not found' } }, 404)
    const u = await startOk(a)
    const r = await cb(a, `code=code012345678901234567890123456789012345678&state=${u.searchParams.get('state')}`)
    expect(loc(r).pathname).toBe('/settings/whatsapp')
    expect(loc(r).searchParams.get('connected')).toBe('1')
    expect(loc(r).searchParams.get('warn')).toBe('status_failed')
    expect(loc(r).searchParams.get('connect_error')).toBeNull()
    expect(adaptors()).toBe(1)
  })

  it('status() throws after a good exchange: grant is still saved, redirect carries a warning', async () => {
    const a = await admin()
    fake.numbers = () => { throw new Error('network down') }
    const u = await startOk(a)
    const r = await cb(a, `code=code012345678901234567890123456789012345678&state=${u.searchParams.get('state')}`)
    expect(loc(r).searchParams.get('connected')).toBe('1')
    expect(loc(r).searchParams.get('warn')).toBe('status_failed')
    expect(adaptors()).toBe(1)
  })

  it('removed routes: the old callback path and the verify route no longer exist', async () => {
    const a = await admin()
    const u = await startOk(a)
    const old = await call('GET', `/api/connect/whabuzz/callback?code=code012345678901234567890123456789012345678&state=${u.searchParams.get('state')}`, a)
    expect(old.status).toBe(404)
    expect((await call('POST', '/api/connect/whabuzz/verify', a)).status).toBe(404)
    expect(pending()).toBe(1)
    expect(fake.calls).toHaveLength(0)
  })

  it('WhaBuzz error redirects map to fixed codes; unknown codes are folded and never echoed', async () => {
    const a = await admin()
    for (const [wb, want] of [['access_denied', 'access_denied'], ['tenant_pending', 'connect_failed'], ['<script>x', 'connect_failed']] as const) {
      const u = await startOk(a)
      const r = await cb(a, `error=${encodeURIComponent(wb)}&error_description=hello&state=${u.searchParams.get('state')}`)
      expect(loc(r).searchParams.get('connect_error')).toBe(want)
      expect(loc(r).searchParams.get('detail')).toBeNull()
    }
    expect(adaptors()).toBe(0)
    expect(fake.calls).toHaveLength(0)
  })

  it('an error redirect with a bad state is a state mismatch, not an error code', async () => {
    const a = await admin()
    await startOk(a)
    expect(loc(await cb(a, 'error=access_denied&state=forged')).searchParams.get('connect_error')).toBe('state_mismatch')
  })

  it('rejects a malformed or short code before calling WhaBuzz', async () => {
    const a = await admin()
    const u = await startOk(a)
    expect(loc(await cb(a, `code=${encodeURIComponent('a b/../c')}&state=${u.searchParams.get('state')}`)).searchParams.get('connect_error')).toBe('invalid_code')
    expect(fake.calls).toHaveLength(0)
  })

  it('is limited to 10 hits per 10 minutes per IP', async () => {
    for (let i = 0; i < 10; i++) expect(loc(await cb(undefined, 'code=x&state=y')).pathname).toBe('/login')
    const r = await cb(undefined, 'code=x&state=y')
    expect(loc(r).searchParams.get('connect_error')).toBe('too_many_attempts')
  })

  it('only GET', async () => {
    expect((await call('POST', '/api/whabuzz/callback')).status).toBe(405)
  })

  it('the pending row and endpoint id never appear in a data export', async () => {
    const a = await admin()
    const u = await startOk(a)
    await cb(a, `code=code012345678901234567890123456789012345678&state=${u.searchParams.get('state')}`)
    await startOk(a)
    const text = await (await call('GET', '/api/export/full.json', a)).text()
    expect(text).toContain('"settings"')
    expect(text).not.toContain('connect_pending')
    expect(text).not.toContain('whabuzz_connect_info')
  })

  it('export is an allowlist: unlisted and secret-looking settings never leave', async () => {
    const a = await admin()
    raw.exec(`INSERT OR REPLACE INTO settings (key,value) VALUES ('business_name','"Example Co"'),('adaptor_config','"x"'),('anthropic_key_enc','"x"'),('vapid_private_enc','"x"'),('whabuzz_anything','"x"'),('connect_other','"x"'),('some_future_setting','"x"')`)
    const j = JSON.parse(await (await call('GET', '/api/export/full.json', a)).text())
    expect(j.settings.business_name).toBe('Example Co')
    expect(Object.keys(j.settings).every((k) => EXPORT_SETTINGS.has(k))).toBe(true)
    for (const k of ['adaptor_config', 'anthropic_key_enc', 'vapid_private_enc', 'whabuzz_anything', 'connect_other', 'some_future_setting']) expect(j.settings).not.toHaveProperty(k)
  })
})
