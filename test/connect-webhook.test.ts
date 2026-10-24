// the unsigned verify-ping allowance on POST /api/whabuzz/webhook (and its alias /webhooks/whabuzz).
// Rule: ONLY a `webhook.verify` body is accepted unsigned, and ONLY while no WhaBuzz webhook secret is saved OR a connect
// is pending. Every other event is 401 in every state.
import type { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import worker from '../src/index'
import { saveConfig } from '../src/adaptors'
import { ensureSchema, type Env } from '../src/db'
import { encryptJson } from '../src/crypto'
import { sha256Hex } from '../src/auth'
import { CONNECT_INFO } from '../src/routes/connect'
import { envelope, fixture, sign, ctx } from './helpers'
import { fakeD1 } from './d1'

const SECRET = 'test-session-secret-0123456789'
const PN = '1000000000000001'
const WBCFG = { kind: 'whabuzz' as const, config: { api_key: 'wb_live_k', phone_number_id: PN, waba_id: '2', webhook_secret: 'whsec_TEST_x' } }
const PATHS = ['/api/whabuzz/webhook', '/webhooks/whabuzz']
const ping = JSON.stringify({ type: 'webhook.verify', challenge: 'challenge-demo-abc123', endpoint_id: 'we_1', created_at: new Date().toISOString() })
const inbound = JSON.stringify(envelope('message.inbound', fixture('text')))

let raw: DatabaseSync
let env: Env
const post = (path: string, body: string, headers: Record<string, string> = {}) => worker.fetch(new Request(`https://leads.example.com${path}`, { method: 'POST', headers, body }), env, ctx)
const count = (sql: string) => (raw.prepare(sql).get() as { n: number }).n
async function setPending(exp: number) {
  const v = await encryptJson(SECRET, { state_hash: await sha256Hex('s'), verifier: 'v'.repeat(43), sid: 'sid', exp }, CONNECT_INFO)
  raw.prepare(`INSERT OR REPLACE INTO settings (key,value) VALUES ('connect_pending', ?)`).run(JSON.stringify(v))
}

beforeEach(async () => {
  const f = fakeD1(); raw = f.raw
  env = { DB: f.d1, INSTANCE_NAME: 't', ALLOWED_ORIGINS: '', ADMIN_KEY: 'a', SESSION_SECRET: SECRET } as unknown as Env
  await ensureSchema(f.d1)
})

describe('unsigned webhook.verify ping', () => {
  for (const path of PATHS) {
    it(`${path}: accepted and echoed while no WhaBuzz secret is saved`, async () => {
      const r = await post(path, ping)
      expect(r.status).toBe(200)
      expect(r.headers.get('content-type')).toContain('text/plain')
      expect(await r.text()).toBe('challenge-demo-abc123')
    })

    it(`${path}: accepted while a connect is pending even if a secret is saved; refused once the pending connect expired`, async () => {
      await saveConfig(env, WBCFG)
      expect((await post(path, ping)).status).toBe(401) // secret saved, nothing pending
      await setPending(Math.floor(Date.now() / 1000) + 300)
      const r = await post(path, ping)
      expect(r.status).toBe(200)
      expect(await r.text()).toBe('challenge-demo-abc123')
      await setPending(Math.floor(Date.now() / 1000) - 5)
      expect((await post(path, ping)).status).toBe(401)
    })

    it(`${path}: refused when a secret is saved and no connect is pending; a signed ping still works`, async () => {
      await saveConfig(env, WBCFG)
      expect((await post(path, ping)).status).toBe(401)
      expect((await post(path, ping, { 'X-WhaBuzz-Signature': 't=1,v1=00' })).status).toBe(401)
      const ok = await post(path, ping, { 'X-WhaBuzz-Signature': sign(['whsec_TEST_x'], ping, Math.floor(Date.now() / 1000)) })
      expect(ok.status).toBe(200)
    })

    it(`${path}: an unsigned non-verify event is 401 in every state and stores nothing`, async () => {
      const bodies = [inbound, JSON.stringify({ type: 'message.status', data: {} }), '{}', '[]', 'not json', JSON.stringify({ type: 'webhook.verify.extra', challenge: 'abc' }), JSON.stringify({ type: 'webhook.verify' }), JSON.stringify({ type: 'webhook.verify', challenge: 42 }), JSON.stringify([{ type: 'webhook.verify', challenge: 'abc' }]), JSON.stringify({ type: 'webhook.verify', challenge: 'has space' })]
      const states: [string, () => Promise<void>][] = [
        ['no adaptor, nothing pending', async () => {}],
        ['no adaptor, connect pending', async () => { await setPending(Math.floor(Date.now() / 1000) + 300) }],
        ['secret saved, nothing pending', async () => { raw.exec(`DELETE FROM settings WHERE key='connect_pending'`); await saveConfig(env, WBCFG) }],
        ['secret saved, connect pending', async () => { await setPending(Math.floor(Date.now() / 1000) + 300) }],
      ]
      for (const [name, setup] of states) {
        await setup()
        for (const b of bodies) expect((await post(path, b)).status, `${name}: ${b.slice(0, 40)}`).toBe(401)
        expect(count('SELECT COUNT(*) n FROM messages')).toBe(0)
      }
    })
  }

  for (const path of PATHS) {
    it(`${path}: undecryptable config counts as "secret present": ping refused without a pending connect, echoed with one`, async () => {
      await saveConfig(env, WBCFG)
      raw.exec(`UPDATE adaptor_config SET config_enc='garbage' WHERE id=1`)
      const r = await post(path, ping)
      expect(r.status).toBe(503) // the signed pipeline reports the unreadable config; never an unsigned echo
      expect(await r.text()).not.toContain('challenge-demo-abc123')
      await setPending(Math.floor(Date.now() / 1000) + 300)
      const ok = await post(path, ping)
      expect(ok.status).toBe(200)
      expect(await ok.text()).toBe('challenge-demo-abc123')
      expect((await post(path, inbound)).status).not.toBe(200) // a non-verify event is never accepted unsigned
    })
  }

  it('GET and other methods on the alias are 405', async () => {
    expect((await worker.fetch(new Request('https://leads.example.com/api/whabuzz/webhook'), env, ctx)).status).toBe(405)
  })

  it('a signed real event is processed on the new path', async () => {
    await saveConfig(env, WBCFG)
    const body = JSON.stringify(envelope('message.inbound', fixture('text'), 0, { phone_number_id: PN }))
    const r = await post('/api/whabuzz/webhook', body, { 'X-WhaBuzz-Signature': sign(['whsec_TEST_x'], body, Math.floor(Date.now() / 1000)) })
    expect(r.status).toBe(200)
  })
})
