import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'
import { ensureSchema, type Env } from '../src/db'
import { WhaBuzzAdaptor, resolveBaseUrl } from '../src/adaptors/whabuzz'
import { decryptJson, encryptJson } from '../src/crypto'
import { hashPassword } from '../src/password'
import { clearSettingsCache, getSettings, putSetting } from '../src/settings'
import { tempPassword } from '../src/routes/staff'
import { ctx } from './helpers'
import { fakeD1 } from './d1'

const SECRET = 'test-session-secret-0123456789'
const ORIGIN = 'https://leads.example.com'
const PASS = 'correct horse battery'
let env: Env
let raw: DatabaseSync

type Opts = { cookie?: string; csrf?: string; bearer?: string; origin?: string | null }
const call = (method: string, path: string, body?: unknown, o: Opts = {}) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (o.cookie) headers.Cookie = o.cookie
  if (o.csrf) headers['X-CSRF-Token'] = o.csrf
  if (o.bearer) headers.Authorization = `Bearer ${o.bearer}`
  if (o.origin !== null && method !== 'GET') headers.Origin = o.origin ?? ORIGIN
  return worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx)
}
type Sess = { cookie: string; csrf: string; id: number }
const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0]
async function login(email: string, password = PASS): Promise<Sess & { res: Response; body: any }> {
  const res = await call('POST', '/api/auth/login', { email, password })
  const body: any = await res.json()
  return { res, body, cookie: cookieOf(res), csrf: body.csrf, id: body.staff?.id }
}
async function seedStaff(email: string, role: 'admin' | 'staff') {
  await ensureSchema(env.DB)
  return Number(raw.prepare(`INSERT INTO staff (email,name,role,pw_hash) VALUES (?,?,?,?)`).run(email, `Test ${role}`, role, await hashPassword(PASS, 1000)).lastInsertRowid)
}
const as = (s: Sess): Opts => ({ cookie: s.cookie, csrf: s.csrf })
const n = (sql: string) => (raw.prepare(sql).get() as { n: number }).n
let admin: Sess, staff: Sess

beforeEach(async () => {
  const f = fakeD1(); raw = f.raw
  env = { DB: f.d1, ADMIN_KEY: 'adminkey', SESSION_SECRET: SECRET, INSTANCE_NAME: 'inst', ALLOWED_ORIGINS: '' } as unknown as Env
  await seedStaff('admin@example.com', 'admin'); await seedStaff('staff@example.com', 'staff')
  admin = await login('admin@example.com'); staff = await login('staff@example.com')
})

describe('settings resolver', () => {
  it('setting > env > default, and the source is reported', async () => {
    env.INSTANCE_NAME = ''; env.TIMEZONE = 'Asia/Kolkata'; env.DEFAULT_COUNTRY = 'in'
    let s = await getSettings(env)
    expect([s.business_name, s.timezone, s.default_country]).toEqual(['WhaLeads', 'Asia/Kolkata', 'IN'])
    expect([s.sources.business_name, s.sources.timezone]).toEqual(['default', 'env'])
    env.INSTANCE_NAME = 'From Env'
    expect((await getSettings(env)).business_name).toBe('From Env')
    await putSetting(env, 'business_name', 'From Setting', null)
    await putSetting(env, 'timezone', 'Europe/Paris', null)
    s = await getSettings(env)
    expect([s.business_name, s.timezone, s.sources.business_name]).toEqual(['From Setting', 'Europe/Paris', 'setting'])
    await putSetting(env, 'business_name', undefined, null) // deleting the row falls back to env again
    expect((await getSettings(env)).business_name).toBe('From Env')
  })
  it('caches raw rows for 30 s and a write in this isolate invalidates', async () => {
    await putSetting(env, 'business_name', 'One', null)
    expect((await getSettings(env)).business_name).toBe('One')
    raw.prepare(`UPDATE settings SET value='"Two"' WHERE key='business_name'`).run()
    expect((await getSettings(env)).business_name).toBe('One') // stale on purpose
    clearSettingsCache(env.DB)
    expect((await getSettings(env)).business_name).toBe('Two')
  })
  it('/api/auth/me uses the same resolver', async () => {
    await call('PATCH', '/api/settings', { business_name: 'Shown In Header' }, as(admin))
    const me: any = await (await call('GET', '/api/auth/me', undefined, as(admin))).json()
    expect(me.business_name).toBe('Shown In Header')
  })
})

describe('/api/settings', () => {
  it('staff may read but not write; secrets are never returned', async () => {
    expect((await call('GET', '/api/settings', undefined, as(staff))).status).toBe(200)
    expect((await call('PATCH', '/api/settings', { business_name: 'x' }, as(staff))).status).toBe(403)
    await call('PATCH', '/api/settings', { anthropic_key: 'sk-ant-test-abcdefgh1234' }, as(admin))
    await putSetting(env, 'vapid_private_enc', 'v1.secret.blob', null)
    for (const who of [admin, staff]) {
      const text = await (await call('GET', '/api/settings', undefined, as(who))).text()
      expect(text).not.toContain('abcdefgh1234')
      expect(text).not.toContain('vapid_private')
      expect(text).not.toContain('anthropic_key_enc')
      expect(text).not.toContain('v1.secret.blob')
    }
    const a: any = await (await call('GET', '/api/settings', undefined, as(admin))).json()
    expect(a.settings.ai).toEqual({ configured: true, last4: '1234', readable: true })
    const st: any = await (await call('GET', '/api/settings', undefined, as(staff))).json()
    expect(st.settings.ai).toBeUndefined()
    const stored = (raw.prepare(`SELECT value FROM settings WHERE key='anthropic_key_enc'`).get() as { value: string }).value
    expect(stored).not.toContain('sk-ant')
  })
  it('validates and writes through PUT or PATCH; null reverts to the fallback', async () => {
    const put: any = await (await call('PUT', '/api/settings', { default_country: 'gb', timezone: 'Europe/London', business_name: ' Acme ' }, as(admin))).json()
    expect(put.settings).toMatchObject({ default_country: 'GB', timezone: 'Europe/London', business_name: 'Acme' })
    for (const bad of [{ default_country: 'ZZ' }, { default_country: 'India' }, { timezone: 'Mars/Base' }, { business_name: '  ' }, { allowed_origins: ['not a url'] }, { allowed_origins: ['https://a.example.com/path'] }, { allowed_origins: ['ftp://a.example.com'] }, { working_hours: { mon: { open: '18:00', close: '09:00' } } }, { anthropic_key: 'short' }]) {
      const r = await call('PATCH', '/api/settings', bad, as(admin))
      expect(r.status, JSON.stringify(bad)).toBe(400)
    }
    const back: any = await (await call('PATCH', '/api/settings', { default_country: null }, as(admin))).json()
    expect(back.settings.default_country).toBeNull()
    const wh: any = await (await call('PATCH', '/api/settings', { working_hours: { mon: { open: '09:00', close: '18:00' }, sun: null } }, as(admin))).json()
    expect(wh.settings.working_hours.mon.open).toBe('09:00')
  })
  it('clearing the Anthropic key removes the row', async () => {
    await call('PATCH', '/api/settings', { anthropic_key: 'sk-ant-test-abcdefgh1234' }, as(admin))
    await call('PATCH', '/api/settings', { anthropic_key: null }, as(admin))
    expect(n(`SELECT COUNT(*) n FROM settings WHERE key='anthropic_key_enc'`)).toBe(0)
  })
})

describe('allowed origins and intake CORS', () => {
  const lead = (origin: string) => worker.fetch(new Request(`${ORIGIN}/api/leads`, { method: 'POST', headers: { 'content-type': 'application/json', Origin: origin }, body: JSON.stringify({ name: 'Test Lead', phone: '+15550000001', source: 'contact_form' }) }), env, ctx)
  it('reads the setting first, then ALLOWED_ORIGINS', async () => {
    env.ALLOWED_ORIGINS = 'https://env.example.com'
    expect((await lead('https://env.example.com')).status).toBe(200)
    expect((await lead('https://site.example.com')).status).toBe(403)
    const r: any = await (await call('PATCH', '/api/settings', { allowed_origins: ['https://site.example.com/', 'https://site.example.com'] }, as(admin))).json()
    expect(r.settings.allowed_origins).toEqual(['https://site.example.com'])
    expect(r.sources.allowed_origins).toBe('setting')
    expect((await lead('https://site.example.com')).status).toBe(200)
    expect((await lead('https://env.example.com')).status).toBe(403) // the setting replaces the env list
    await call('PATCH', '/api/settings', { allowed_origins: null }, as(admin))
    expect((await lead('https://env.example.com')).status).toBe(200)
  })
})

describe('staff admin', () => {
  it('admin adds staff; the temp password works once and forces a change', async () => {
    const r = await call('POST', '/api/staff', { name: 'New Person', email: 'New@Example.com', role: 'staff' }, as(admin))
    const b: any = await r.json()
    expect(r.status).toBe(201)
    expect(b.temp_password).toHaveLength(12)
    expect(JSON.stringify(b.staff)).not.toContain('pw_hash')
    const l = await login('new@example.com', b.temp_password)
    expect(l.res.status).toBe(200)
    expect(l.body.staff.must_change_pw).toBe(true)
    expect((await call('GET', '/api/settings', undefined, as(l))).status).toBe(403) // gate: change password first
    const pw = await call('POST', '/api/auth/password', { current_password: b.temp_password, new_password: 'a brand new password' }, as(l))
    expect(pw.status).toBe(200)
    expect((await call('GET', '/api/settings', undefined, as(l))).status).toBe(200)
    expect((await call('POST', '/api/staff', { name: 'Dup', email: 'new@example.com' }, as(admin))).status).toBe(409)
    expect((await call('POST', '/api/staff', { name: '', email: 'x@example.com' }, as(admin))).status).toBe(400)
    expect((await call('POST', '/api/staff', { name: 'Bad Role', email: 'y@example.com', role: 'owner' }, as(admin))).status).toBe(400)
  })
  it('temp passwords use the unambiguous alphabet', () => {
    for (let i = 0; i < 50; i++) expect(tempPassword()).toMatch(/^[abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}$/)
  })
  it('staff cannot reach any staff route', async () => {
    expect((await call('GET', '/api/staff', undefined, as(staff))).status).toBe(403)
    expect((await call('POST', '/api/staff', { name: 'X', email: 'x@example.com' }, as(staff))).status).toBe(403)
    expect((await call('PATCH', `/api/staff/${admin.id}`, { role: 'staff' }, as(staff))).status).toBe(403)
    expect((await call('POST', `/api/staff/${admin.id}/reset-password`, undefined, as(staff))).status).toBe(403)
  })
  it('last-admin guard: cannot deactivate or demote the last active admin', async () => {
    expect((await call('PATCH', `/api/staff/${admin.id}`, { active: false }, as(admin))).status).toBe(409)
    expect((await call('PATCH', `/api/staff/${admin.id}`, { role: 'staff' }, as(admin))).status).toBe(409)
    expect(n(`SELECT COUNT(*) n FROM staff WHERE role='admin' AND active=1`)).toBe(1)
    // a second admin lifts the guard; the new last one is protected again
    expect((await call('PATCH', `/api/staff/${staff.id}`, { role: 'admin' }, as(admin))).status).toBe(200)
    expect((await call('PATCH', `/api/staff/${admin.id}`, { role: 'staff' }, as(admin))).status).toBe(200)
    const again = await call('PATCH', `/api/staff/${staff.id}`, { active: false }, { bearer: 'adminkey' })
    expect(again.status).toBe(409)
    expect(((await again.json()) as any).error).toBe('last_admin')
    expect((await call('PATCH', `/api/staff/${staff.id}`, { name: 'Renamed' }, { bearer: 'adminkey' })).status).toBe(200)
  })
  it('deactivate revokes sessions and blocks login; reactivate restores it', async () => {
    expect((await call('PATCH', `/api/staff/${staff.id}`, { active: false }, as(admin))).status).toBe(200)
    expect(n(`SELECT COUNT(*) n FROM sessions WHERE staff_id=${staff.id}`)).toBe(0)
    expect((await call('GET', '/api/stages', undefined, as(staff))).status).toBe(401)
    expect((await login('staff@example.com')).res.status).toBe(401)
    expect((await call('PATCH', `/api/staff/${staff.id}`, { active: true }, as(admin))).status).toBe(200)
    expect((await login('staff@example.com')).res.status).toBe(200)
  })
  it('reset revokes that user\'s sessions, sets must_change_pw and invalidates the old password', async () => {
    const second = await login('staff@example.com')
    const r = await call('POST', `/api/staff/${staff.id}/reset-password`, undefined, as(admin))
    const b: any = await r.json()
    expect(r.status).toBe(200)
    expect(n(`SELECT COUNT(*) n FROM sessions WHERE staff_id=${staff.id}`)).toBe(0)
    expect((await call('GET', '/api/stages', undefined, as(staff))).status).toBe(401)
    expect((await call('GET', '/api/stages', undefined, as(second))).status).toBe(401)
    expect((await login('staff@example.com')).res.status).toBe(401)
    const l = await login('staff@example.com', b.temp_password)
    expect(l.body.staff.must_change_pw).toBe(true)
    expect(n(`SELECT COUNT(*) n FROM sessions WHERE staff_id=${admin.id}`)).toBe(1) // the admin is untouched
  })
  it('a session admin cannot reset themself; ADMIN_KEY can reset anyone (locked-out recovery)', async () => {
    expect((await call('POST', `/api/staff/${admin.id}/reset-password`, undefined, as(admin))).status).toBe(400)
    const r = await call('POST', `/api/staff/${admin.id}/reset-password`, undefined, { bearer: 'adminkey' })
    expect(r.status).toBe(200)
    expect((await call('POST', '/api/staff/9999/reset-password', undefined, { bearer: 'adminkey' })).status).toBe(404)
  })
})

describe('pipeline lists', () => {
  const leadWith = (status: string) => {
    raw.prepare(`INSERT OR IGNORE INTO contacts (id,wa_id,phone,name) VALUES (1,'15550000001','15550000001','Test Lead')`).run()
    raw.prepare(`INSERT INTO leads (contact_id,source,status) VALUES (1,'call',?)`).run(status)
  }
  it('lists are readable by staff and exposed to the app (archived hidden by default)', async () => {
    const st: any = await (await call('GET', '/api/stages', undefined, as(staff))).json()
    expect(st.stages.map((s: any) => s.key)).toEqual(['new', 'contacted', 'qualified', 'won', 'lost'])
    expect((await call('GET', '/api/sources', undefined, as(staff))).status).toBe(200)
    expect(((await (await call('GET', '/api/tags', undefined, as(staff))).json()) as any).colors).toContain('coral')
  })
  it('stages: add, rename in place, reorder, archive', async () => {
    const add: any = await (await call('POST', '/api/stages', { label: 'Site visit', kind: 'open' }, as(admin))).json()
    expect(add.key).toBe('site_visit')
    expect((await call('PATCH', '/api/stages/site_visit', { label: 'Visit booked' }, as(admin))).status).toBe(200)
    const order = ['site_visit', 'new', 'contacted', 'qualified', 'won', 'lost']
    const re: any = await (await call('POST', '/api/stages/reorder', { keys: order }, as(admin))).json()
    expect(re.stages.map((s: any) => s.key)).toEqual(order)
    expect(re.stages[0].label).toBe('Visit booked')
    expect((await call('POST', '/api/stages/reorder', { keys: ['new'] }, as(admin))).status).toBe(400)
    expect((await call('PATCH', '/api/stages/site_visit', { archived: true }, as(admin))).status).toBe(200)
    expect(((await (await call('GET', '/api/stages', undefined, as(staff))).json()) as any).stages.map((s: any) => s.key)).not.toContain('site_visit')
    expect(((await (await call('GET', '/api/stages?all=1', undefined, as(staff))).json()) as any).stages.map((s: any) => s.key)).toContain('site_visit')
    expect((await call('POST', '/api/stages', { label: 'Site visit' }, as(admin))).status).toBe(201) // key gets a suffix
    expect(n(`SELECT COUNT(*) n FROM stages WHERE key='site_visit_2'`)).toBe(1)
  })
  it('stage delete with leads is refused unless a move target is given; no lead is orphaned', async () => {
    await call('POST', '/api/stages', { label: 'Trial', kind: 'open' }, as(admin))
    leadWith('trial'); leadWith('trial')
    const r = await call('DELETE', '/api/stages/trial', undefined, as(admin))
    expect(r.status).toBe(409)
    expect(await r.json()).toMatchObject({ error: 'stage_has_leads', lead_count: 2 })
    expect((await call('PATCH', '/api/stages/trial', { archived: true }, as(admin))).status).toBe(409)
    expect((await call('DELETE', '/api/stages/trial?move_to=trial', undefined, as(admin))).status).toBe(400)
    expect((await call('DELETE', '/api/stages/trial?move_to=nope', undefined, as(admin))).status).toBe(400)
    expect(n(`SELECT COUNT(*) n FROM stages WHERE key='trial'`)).toBe(1)
    const ok: any = await (await call('DELETE', '/api/stages/trial?move_to=contacted', undefined, as(admin))).json()
    expect(ok.moved).toBe(2)
    expect(n(`SELECT COUNT(*) n FROM leads WHERE status='contacted'`)).toBe(2)
    expect(n(`SELECT COUNT(*) n FROM leads WHERE status NOT IN (SELECT key FROM stages)`)).toBe(0)
    await call('POST', '/api/stages', { label: 'Empty', kind: 'open' }, as(admin))
    expect((await call('DELETE', '/api/stages/empty', undefined, as(admin))).status).toBe(200)
  })
  it('protects the "new" stage and the last stage of each kind', async () => {
    expect((await call('DELETE', '/api/stages/new', undefined, as(admin))).status).toBe(409)
    expect((await call('PATCH', '/api/stages/new', { archived: true }, as(admin))).status).toBe(409)
    expect((await call('PATCH', '/api/stages/new', { kind: 'won' }, as(admin))).status).toBe(409)
    expect((await call('PATCH', '/api/stages/new', { label: 'Fresh' }, as(admin))).status).toBe(200)
    expect((await call('DELETE', '/api/stages/won', undefined, as(admin))).status).toBe(409)
    expect((await call('PATCH', '/api/stages/lost', { kind: 'open' }, as(admin))).status).toBe(409)
  })
  it('sources: add and archive custom ones; system ones are locked', async () => {
    const a: any = await (await call('POST', '/api/sources', { label: 'Walk in' }, as(admin))).json()
    expect(a.key).toBe('walk_in')
    expect((await call('PATCH', '/api/sources/walk_in', { label: 'Walk-in', archived: true }, as(admin))).status).toBe(200)
    expect(((await (await call('GET', '/api/sources', undefined, as(staff))).json()) as any).sources.map((s: any) => s.key)).not.toContain('walk_in')
    expect((await call('PATCH', '/api/sources/call', { archived: true }, as(admin))).status).toBe(409)
    expect((await call('PATCH', '/api/sources/missing', { label: 'x' }, as(admin))).status).toBe(404)
  })
  it('tags: add, recolour, rename, delete; fixed palette; unique labels', async () => {
    expect((await call('POST', '/api/tags', { label: 'VIP', color: 'coral' }, as(admin))).status).toBe(201)
    expect((await call('POST', '/api/tags', { label: 'vip' }, as(admin))).status).toBe(409)
    expect((await call('POST', '/api/tags', { label: 'Odd', color: '#ff0000' }, as(admin))).status).toBe(400)
    const id = (raw.prepare(`SELECT id FROM tags WHERE label='VIP'`).get() as { id: number }).id
    expect((await call('PATCH', `/api/tags/${id}`, { color: 'blue', label: 'Very important' }, as(admin))).status).toBe(200)
    expect((await call('DELETE', `/api/tags/${id}`, undefined, as(admin))).status).toBe(200)
    expect(n('SELECT COUNT(*) n FROM tags')).toBe(0)
  })
  it('writes need admin', async () => {
    for (const [m, p] of [['POST', '/api/stages'], ['POST', '/api/sources'], ['POST', '/api/tags'], ['PATCH', '/api/stages/new'], ['DELETE', '/api/stages/lost']] as const) {
      expect((await call(m, p, { label: 'X' }, as(staff))).status, `${m} ${p}`).toBe(403)
    }
  })
})

describe('auth gate on the settings routes', () => {
  it('cookie-only writes without CSRF are 403, anonymous is 401, ADMIN_KEY works without CSRF', async () => {
    const cookieOnly = { cookie: admin.cookie }
    for (const [m, p, b] of [
      ['PATCH', '/api/settings', { business_name: 'x' }], ['POST', '/api/staff', { name: 'A', email: 'a@example.com' }],
      ['PATCH', `/api/staff/${staff.id}`, { name: 'x' }], ['POST', `/api/staff/${staff.id}/reset-password`, undefined],
      ['POST', '/api/stages', { label: 'x' }], ['POST', '/api/sources', { label: 'x' }], ['POST', '/api/tags', { label: 'x' }],
      ['PUT', '/api/admin/adaptor', {}],
    ] as const) {
      expect((await call(m, p, b, cookieOnly)).status, `${m} ${p} csrf`).toBe(403)
      expect((await call(m, p, b, {})).status, `${m} ${p} anon`).toBe(401)
      expect((await call(m, p, b, { cookie: admin.cookie, csrf: admin.csrf, origin: 'https://evil.example.com' })).status, `${m} ${p} origin`).toBe(403)
    }
    for (const p of ['/api/settings', '/api/staff', '/api/stages', '/api/sources', '/api/tags']) expect((await call('GET', p, undefined, { bearer: 'adminkey' })).status, p).toBe(200)
    expect((await call('POST', '/api/tags', { label: 'Via key' }, { bearer: 'adminkey', origin: null })).status).toBe(201)
    expect((await call('GET', '/api/settings', undefined, { bearer: 'wrong' })).status).toBe(401)
  })
  it('profile: any staff can change their own name', async () => {
    const r: any = await (await call('PATCH', '/api/auth/me', { name: 'New Name' }, as(staff))).json()
    expect(r.staff.name).toBe('New Name')
    expect((await call('PATCH', '/api/auth/me', { name: ' ' }, as(staff))).status).toBe(400)
    expect((await call('PATCH', '/api/auth/me', { name: 'x' }, { cookie: staff.cookie })).status).toBe(403)
  })
})

describe('adaptor base URL is deployment-controlled', () => {
  const base = { api_key: 'k_test_1234', phone_number_id: '1', waba_id: '2', webhook_secret: 'whsec_TEST_x' }
  const put = (config: Record<string, string>) => call('PUT', '/api/admin/adaptor', { kind: 'whabuzz', config }, as(admin))
  afterEach(() => vi.unstubAllGlobals())

  it('a base_url in the PUT body is ignored: not used for the check, not saved', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => { urls.push(String(url)); return new Response(JSON.stringify({ connection_state: 'connected' }), { status: 200 }) })
    const r = await put({ ...base, base_url: 'https://api-whabuzz.evil.example/v1' })
    expect(r.status).toBe(200)
    expect(urls.length).toBeGreaterThan(0)
    for (const u of urls) expect(u.startsWith('https://api.whabuzz.com/v1/')).toBe(true)
    const stored = (raw.prepare('SELECT config_enc FROM adaptor_config WHERE id=1').get() as { config_enc: string }).config_enc
    const cfg = await decryptJson<Record<string, string>>(SECRET, stored)
    expect(cfg.base_url).toBeUndefined()
    expect(JSON.stringify(await (await call('GET', '/api/admin/adaptor', undefined, as(admin))).json())).not.toContain('base_url')
  })
  it('a legacy stored base_url is stripped on read and never used', async () => {
    const enc = await encryptJson(SECRET, { ...base, base_url: 'https://api-whabuzz.evil.example/v1' })
    raw.prepare(`INSERT INTO adaptor_config (id,kind,config_enc) VALUES (1,'whabuzz',?)`).run(enc)
    const urls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => { urls.push(String(url)); return new Response(JSON.stringify({ connection_state: 'connected' }), { status: 200 }) })
    const r: any = await (await call('GET', '/api/admin/adaptor', undefined, as(admin))).json()
    expect(r.config.base_url).toBeUndefined()
    expect(urls.every((u) => u.startsWith('https://api.whabuzz.com/v1/'))).toBe(true)
  })
  it('WHABUZZ_BASE_URL is honoured only for https whabuzz.com hosts', () => {
    expect(resolveBaseUrl(undefined)).toBe('https://api.whabuzz.com/v1')
    expect(resolveBaseUrl('https://staging.whabuzz.com/v1/')).toBe('https://staging.whabuzz.com/v1')
    for (const bad of ['https://api-whabuzz.evil.example/v1', 'https://whabuzz.com.evil.example', 'http://api.whabuzz.com/v1', 'https://evilwhabuzz.com/v1', 'https://u:p@api.whabuzz.com', 'nope'])
      expect(() => resolveBaseUrl(bad), bad).toThrow(/WHABUZZ_BASE_URL/)
    expect(() => new WhaBuzzAdaptor({ ...base }, undefined, 'https://evil.example')).toThrow(/WHABUZZ_BASE_URL must be/)
  })
  it('a bad WHABUZZ_BASE_URL fails the save with a clear error before any request is sent', async () => {
    env.WHABUZZ_BASE_URL = 'https://evil.example/v1'
    let called = false
    vi.stubGlobal('fetch', async () => { called = true; return new Response('{}', { status: 200 }) })
    const r = await put(base)
    expect(r.status).toBe(500)
    expect(JSON.stringify(await r.json())).toContain('WHABUZZ_BASE_URL')
    expect(called).toBe(false)
  })
  it('required fields are still validated', async () => {
    expect(((await (await put({ ...base, api_key: '' })).json()) as any).error).toBe('config.api_key required')
  })
})

describe('setup returns fresh settings after a warm cache', () => {
  it('201 payload carries the submitted values and a vapid_public', async () => {
    const f = fakeD1(); raw = f.raw
    env = { DB: f.d1, SESSION_SECRET: SECRET, INSTANCE_NAME: 'inst', ALLOWED_ORIGINS: '' } as unknown as Env
    const warm = await worker.fetch(new Request(`${ORIGIN}/api/leads`, { method: 'OPTIONS', headers: { Origin: ORIGIN } }), env, ctx)
    expect([204, 403]).toContain(warm.status)
    expect((await getSettings(env)).business_name).toBe('inst') // cache is warm with the defaults
    const r = await call('POST', '/api/setup', { setup_key: SECRET, business_name: 'Acme Gyms', timezone: 'Asia/Kolkata', default_country: 'IN', admin: { name: 'Ada', email: 'ada@example.com', password: PASS } })
    expect(r.status).toBe(201)
    const b: any = await r.json()
    expect(b.business_name).toBe('Acme Gyms')
    expect(b.timezone).toBe('Asia/Kolkata')
    expect(b.default_country).toBe('IN')
    expect(typeof b.vapid_public).toBe('string')
    expect(b.vapid_public.length).toBeGreaterThan(20)
  })
})
