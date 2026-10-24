import { MIGRATIONS } from '../src/db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'
import type { Env } from '../src/db'
import { ctx } from './helpers'
import { fakeD1 } from './d1'

let env: Env
let raw: ReturnType<typeof fakeD1>['raw']
const call = (method: string, path: string, body?: unknown, auth = 'adminkey') =>
  worker.fetch(new Request(`https://x${path}`, { method, headers: { Authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx)

const WB = { kind: 'whabuzz', config: { api_key: 'wbk_TEST_12345678', phone_number_id: '1000000000000001', waba_id: '10000000000000002', webhook_secret: 'whsec_TEST_abcdef123456', junk: 'dropped' } }

beforeEach(() => {
  const f = fakeD1(); raw = f.raw
  env = { DB: f.d1, ADMIN_KEY: 'adminkey', SESSION_SECRET: 'sess', INSTANCE_NAME: 't', ALLOWED_ORIGINS: '', } as unknown as Env
})
afterEach(() => vi.unstubAllGlobals())

describe('/api/admin/adaptor', () => {
  it('requires the admin key', async () => {
    expect((await call('GET', '/api/admin/adaptor', undefined, 'nope')).status).toBe(401)
  })
  it('health reports cron_last_at: null before any cron run, the last run after', async () => {
    expect(await (await call('GET', '/api/health')).json()).toMatchObject({ cron_last_at: null })
    const { runCron } = await import('../src/cron')
    await runCron(env, Date.now(), { tick: async () => ({ resumed: 0, completed: 0, awaiting: 0, failed: 0, skipped: 0, stalled: 0, abandoned: 0, dbCalls: 0, more: false }), quarterHour: async () => {}, daily: async () => {} })
    const h: any = await (await call('GET', '/api/health')).json()
    expect(Math.abs(h.cron_last_at - Date.now() / 1000)).toBeLessThan(5)
    expect(raw.prepare(`SELECT COUNT(*) n FROM events WHERE kind LIKE 'cron%'`).get()).toEqual({ n: 0 })
  })
  it('health reports adaptor null with nothing configured, cloud_api with legacy env', async () => {
    expect(await (await call('GET', '/api/health')).json()).toMatchObject({ ok: true, schema_version: MIGRATIONS.length, adaptor: null })
    Object.assign(env, { META_SYSTEM_TOKEN: 't', META_PHONE_NUMBER_ID: '1', META_WABA_ID: '2' })
    expect(await (await call('GET', '/api/health')).json()).toMatchObject({ adaptor: 'cloud_api' })
  })
  it('rejects bad bodies', async () => {
    expect((await call('PUT', '/api/admin/adaptor', { kind: 'x' })).status).toBe(400)
    expect((await call('PUT', '/api/admin/adaptor', { kind: 'whabuzz', config: { api_key: 'a' } })).status).toBe(400)
  })
  it('does not save when status() fails', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ source: 'whabuzz', error: { code: 'unauthorized', message: 'bad key' } }), { status: 401 }))
    const res = await call('PUT', '/api/admin/adaptor', WB)
    expect(res.status).toBe(422)
    expect((raw.prepare('SELECT COUNT(*) n FROM adaptor_config').get() as any).n).toBe(0)
  })
  it('validates via status(), stores encrypted, GET returns masked config + live status', async () => {
    const seen: string[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seen.push(`${init.method ?? 'GET'} ${url} ${(init.headers as any).Authorization}`)
      return new Response(JSON.stringify({ phone_number_id: '1000000000000001', display_phone_number: '+1 555 010 0100', connection_state: 'connected', quality_rating: 'GREEN', messaging_limit_tier: 'TIER_250' }), { status: 200 })
    })
    const put = await call('PUT', '/api/admin/adaptor', WB)
    expect(put.status).toBe(200)
    expect(seen[0]).toBe('GET https://api.whabuzz.com/v1/numbers/1000000000000001 Bearer wbk_TEST_12345678')
    const stored = raw.prepare('SELECT * FROM adaptor_config').get() as any
    expect(stored.kind).toBe('whabuzz')
    expect(stored.config_enc).not.toContain('wbk_live')
    const got: any = await (await call('GET', '/api/admin/adaptor')).json()
    expect(got).toMatchObject({ kind: 'whabuzz', source: 'd1', onboarding: 'connect_button', status: { ok: true, connected: true, quality: 'GREEN', tier: 'TIER_250' } })
    expect(got.config.api_key).toBe('••••5678')
    expect(got.config.webhook_secret).toBe('••••3456')
    expect(got.config.junk).toBeUndefined()
    expect(JSON.stringify(got)).not.toContain('wbk_TEST_12345678')
    expect(await (await call('GET', '/api/health')).json()).toMatchObject({ adaptor: 'whabuzz' })
  })
  it('/api/send goes through the active adaptor and surfaces Meta errors verbatim', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ connection_state: 'connected' }), { status: 200 }))
    await call('PUT', '/api/admin/adaptor', WB)
    const metaErr = { message: '(#131047) Re-engagement message', type: 'OAuthException', code: 131047, fbtrace_id: 'x' }
    let sent: any
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { sent = { url, body: JSON.parse(init.body as string) }; return new Response(JSON.stringify({ source: 'meta', error: metaErr }), { status: 400 }) })
    // /api/send enforces the 24h window, so the number must have written in recently.
    raw.exec(`INSERT INTO contacts (id,wa_id,phone) VALUES (1,'919999000012','919999000012')`)
    raw.exec(`INSERT INTO conversations (contact_id,last_message_at,last_inbound_at) VALUES (1,unixepoch(),unixepoch())`)
    const res = await call('POST', '/api/send', { to: '919999000012', text: 'hi' })
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ ok: false, source: 'meta', graph: metaErr })
    expect(sent.url).toBe('https://api.whabuzz.com/v1/messages')
    expect(sent.body).toMatchObject({ from: '1000000000000001', to: '919999000012', type: 'text' })
  })
})
