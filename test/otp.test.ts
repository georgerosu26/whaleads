// POST /api/send-otp: bearer only, limits, no contact for unknown numbers, the code never stored or logged.
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'
import { saveConfig } from '../src/adaptors'
import { ensureSchema, type Env } from '../src/db'
import { fakeD1 } from './d1'

const SECRET = 'test-session-secret-0123456789'
const ORIGIN = 'https://leads.example.com'
const WB = { kind: 'whabuzz' as const, config: { api_key: 'k', phone_number_id: '1000000000000001', waba_id: '2', webhook_secret: 'whsec_TEST_x' } }
const CODE = '482913'

let env: Env
let raw: DatabaseSync
let calls: { url: string; body: any }[]
const ctx = { waitUntil: (_p: Promise<unknown>) => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
const rows = <T = any>(sql: string, ...a: any[]) => raw.prepare(sql).all(...a) as T[]
const sends = () => calls.filter((x) => x.url.endsWith('/messages'))

function seedAuthTemplate() {
  raw.prepare(`INSERT INTO templates (id,name,language,category,status,components,header_format,body_params_count,header_params_count,synced_at) VALUES ('ta','login_code','en','AUTHENTICATION','APPROVED',?,'NONE',1,0,1)`)
    .run(JSON.stringify([{ type: 'BODY', text: '{{1}} is your verification code.' }, { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE' }] }]))
}
function seedUtility() {
  raw.prepare(`INSERT INTO templates (id,name,language,category,status,components,header_format,body_params_count,header_params_count,synced_at) VALUES ('tu','order_update','en','UTILITY','APPROVED',?,'NONE',0,0,1)`)
    .run(JSON.stringify([{ type: 'BODY', text: 'Shipped.' }]))
}
const bearer = (body: unknown, key = 'adminkey') => worker.fetch(new Request(`${ORIGIN}/api/send-otp`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }), env, ctx)
const J = async (r: Response) => (await r.json()) as any
const to = (n = '15551230001') => ({ to: n, template_id: 'ta', code: CODE })
const seedContact = () => raw.prepare(`INSERT INTO contacts (id,wa_id,phone,name) VALUES (1,'15551230001','15551230001','Asha')`).run()

beforeEach(async () => {
  const f = fakeD1(); raw = f.raw
  env = { DB: f.d1, ADMIN_KEY: 'adminkey', SESSION_SECRET: SECRET, INSTANCE_NAME: 'inst', ALLOWED_ORIGINS: '', META_APP_SECRET: 'appsecret' } as unknown as Env
  await ensureSchema(f.d1)
  await saveConfig(env, WB)
  calls = []
  vi.stubGlobal('fetch', async (url: string, init: any = {}) => {
    calls.push({ url: String(url), body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body })
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.OTP1' }] }), { status: 200 })
  })
  seedAuthTemplate()
})
afterEach(() => vi.unstubAllGlobals())

describe('POST /api/send-otp', () => {
  it('sends the code as body param + url button 0 and returns the wamid', async () => {
    const res = await bearer(to())
    expect(res.status).toBe(200)
    expect(await J(res)).toMatchObject({ ok: true, wamid: 'wamid.OTP1' })
    expect(sends()[0]!.body.template).toEqual({
      name: 'login_code', language: { code: 'en' },
      components: [
        { type: 'body', parameters: [{ type: 'text', text: CODE }] },
        { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: CODE }] },
      ],
    })
  })
  it('needs the ADMIN_KEY bearer: no auth and a wrong key are 401, a signed-in admin session is 403', async () => {
    expect((await worker.fetch(new Request(`${ORIGIN}/api/send-otp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(to()) }), env, ctx)).status).toBe(401)
    expect((await bearer(to(), 'nope')).status).toBe(401)
    const setup = await worker.fetch(new Request(`${ORIGIN}/api/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ setup_key: SECRET, business_name: 'Example Co', default_country: 'US', timezone: 'UTC', admin: { name: 'A', email: 'a@example.com', password: 'correct horse battery' } }),
    }), env, ctx)
    const { csrf } = await J(setup)
    const cookie = (setup.headers.get('set-cookie') ?? '').split(';')[0]!
    const res = await worker.fetch(new Request(`${ORIGIN}/api/send-otp`, { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': csrf, Origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(to()) }), env, ctx)
    expect(res.status).toBe(403)
    expect(sends()).toHaveLength(0)
  })
  it('the 6th request to one destination in 10 minutes is 429 and says which limit', async () => {
    for (let i = 0; i < 5; i++) expect((await bearer(to())).status).toBe(200)
    const res = await bearer(to())
    expect(res.status).toBe(429)
    expect(await J(res)).toMatchObject({ error: 'rate_limited', limit: 'destination' })
    expect((await bearer(to('15551230002'))).status).toBe(200) // another number is unaffected
  })
  it('an unknown number creates no contact, lead or conversation', async () => {
    expect((await bearer(to())).status).toBe(200)
    expect(rows('SELECT id FROM contacts')).toHaveLength(0)
    expect(rows('SELECT id FROM leads')).toHaveLength(0)
    expect(rows('SELECT contact_id FROM conversations')).toHaveLength(0)
  })
  it('a known contact gets a "[one-time code]" row with origin otp; the code is nowhere in the database', async () => {
    seedContact()
    expect((await bearer({ contact_id: 1, template_id: 'ta', code: CODE })).status).toBe(200)
    const m = rows<any>('SELECT type, body, origin FROM messages WHERE contact_id=1')
    expect(m).toHaveLength(1)
    expect(m[0]).toMatchObject({ type: 'template', body: '[one-time code]', origin: 'otp' })
    const dump = JSON.stringify([rows('SELECT * FROM messages'), rows('SELECT * FROM events'), rows('SELECT * FROM conversations')])
    expect(dump).not.toContain(CODE)
  })
  it('matches an existing contact by number and still creates nothing new', async () => {
    seedContact()
    await bearer(to())
    expect(rows('SELECT id FROM messages WHERE contact_id=1')).toHaveLength(1)
    expect(rows('SELECT id FROM contacts')).toHaveLength(1)
  })
  it('validates input', async () => {
    expect((await J(await bearer({ ...to(), code: '12 34' }))).error).toBe('invalid_code')
    expect((await J(await bearer({ template_id: 'ta', code: CODE }))).error).toBe('destination_required')
    expect((await J(await bearer(to('abc')))).error).toBe('invalid_to')
    expect((await bearer({ contact_id: 99, template_id: 'ta', code: CODE })).status).toBe(404)
  })
  it('refuses a template that is not an approved authentication template', async () => {
    seedUtility()
    expect((await bearer({ ...to(), template_id: 'tu' })).status).toBe(422)
    expect((await bearer({ ...to(), template_id: 'missing' })).status).toBe(404)
    raw.prepare(`UPDATE templates SET status='PENDING' WHERE id='ta'`).run()
    expect((await bearer(to())).status).toBe(422)
    expect(sends()).toHaveLength(0)
  })
  it('accepts name + language instead of an id', async () => {
    expect((await bearer({ to: '15551230001', name: 'login_code', language: 'en', code: CODE })).status).toBe(200)
  })
  it('a gateway error comes back as an error and nothing is recorded', async () => {
    seedContact()
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { message: 'bad' } }), { status: 400 }))
    const res = await bearer({ contact_id: 1, template_id: 'ta', code: CODE })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(rows('SELECT id FROM messages')).toHaveLength(0)
  })
  it('the deployment-wide cap is 30 per minute', async () => {
    const codes: number[] = []
    for (let i = 0; i < 31; i++) codes.push((await bearer(to(`1555123${1000 + i}`))).status)
    expect(codes.slice(0, 30).every((s) => s === 200)).toBe(true)
    expect(codes[30]).toBe(429)
  })
})
