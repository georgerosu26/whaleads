import { MIGRATIONS } from '../src/db'
import type { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import worker from '../src/index'
import { saveConfig } from '../src/adaptors'
import { ensureSchema, type Env } from '../src/db'
import { processEvents } from '../src/inbound'
import { WhaBuzzAdaptor } from '../src/adaptors/whabuzz'
import { ctx, envelope, fixture, metaSig, sign } from './helpers'
import { fakeD1 } from './d1'

let raw: DatabaseSync
let env: Env
let d1: D1Database
const PN = '1000000000000001'
const count = (sql: string) => (raw.prepare(sql).get() as { n: number }).n
const wb = new WhaBuzzAdaptor({ api_key: 'k', phone_number_id: PN, waba_id: '2', webhook_secret: 's' })
const WBCFG = { kind: 'whabuzz' as const, config: { api_key: 'k', phone_number_id: PN, waba_id: '2', webhook_secret: 'whsec_TEST_x' } }
const post = (path: string, body: string, headers: Record<string, string> = {}) =>
  worker.fetch(new Request(`https://x${path}`, { method: 'POST', headers, body }), env, ctx)

beforeEach(async () => {
  const f = fakeD1(); raw = f.raw; d1 = f.d1
  env = { DB: d1, INSTANCE_NAME: 't', ALLOWED_ORIGINS: '', ADMIN_KEY: 'a', SESSION_SECRET: 'sess-1',
    META_APP_SECRET: 'appsecret', META_SYSTEM_TOKEN: 'tok', META_PHONE_NUMBER_ID: '1', META_WABA_ID: '2', WEBHOOK_VERIFY_TOKEN: 'vt' } as unknown as Env
  await ensureSchema(d1)
})

describe('P1 WhaBuzz verify ping', () => {
  const ping = JSON.stringify({ type: 'webhook.verify', challenge: 'abc123def456', endpoint_id: 'we_1', created_at: new Date().toISOString() })
  it('signed verify ping -> challenge echoed as text/plain 200', async () => {
    await saveConfig(env, WBCFG)
    const res = await post('/webhooks/whabuzz', ping, { 'X-WhaBuzz-Signature': sign(['whsec_TEST_x'], ping, Math.floor(Date.now() / 1000)) })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/plain')
    expect(await res.text()).toBe('abc123def456')
    expect(count('SELECT COUNT(*) n FROM messages')).toBe(0)
  })
  it('unsigned verify ping -> 401', async () => {
    await saveConfig(env, WBCFG)
    expect((await post('/webhooks/whabuzz', ping)).status).toBe(401)
  })
})

describe('P1 undecryptable config does not take down the legacy Meta route', () => {
  it('meta route keeps working via env, whabuzz route 503, health shows the error', async () => {
    await saveConfig(env, WBCFG)
    env.SESSION_SECRET = 'sess-ROTATED'
    const ch = await worker.fetch(new Request('https://x/webhooks/meta?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=777'), env, ctx)
    expect(ch.status).toBe(200)
    expect(await ch.text()).toBe('777')
    const body = JSON.stringify(fixture('text'))
    const m = await post('/webhooks/meta', body, { 'X-Hub-Signature-256': metaSig('appsecret', body) })
    expect(m.status).toBe(200)
    expect(count('SELECT COUNT(*) n FROM messages')).toBe(1)
    const w = await post('/webhooks/whabuzz', '{}')
    expect(w.status).toBe(503)
    expect(await w.text()).toMatch(/undecryptable/)
    const h: any = await (await worker.fetch(new Request('https://x/api/health'), env, ctx)).json()
    expect(h).toMatchObject({ ok: false, adaptor_error: 'config_undecryptable', schema_version: MIGRATIONS.length })
  })
  it('missing SESSION_SECRET behaves the same', async () => {
    await saveConfig(env, WBCFG)
    delete env.SESSION_SECRET
    const body = JSON.stringify(fixture('text'))
    expect((await post('/webhooks/meta', body, { 'X-Hub-Signature-256': metaSig('appsecret', body) })).status).toBe(200)
    expect((await post('/webhooks/whabuzz', '{}')).status).toBe(503)
  })
})

describe('P2 failed status is terminal', () => {
  const seed = (status: string) => {
    raw.prepare(`INSERT INTO contacts (wa_id,phone) VALUES ('16505550123','16505550123')`).run()
    raw.prepare(`INSERT INTO messages (contact_id,direction,wamid,type,status) VALUES (1,'out','w1','text',?)`).run(status)
  }
  const st = (status: string) => processEvents(env, ctx, [{ kind: 'status', wamid: 'w1', status: status as any, timestamp: 1, recipient: null, error: null, raw: {} } as any])
  const cur = () => (raw.prepare('SELECT status FROM messages').get() as any).status
  it('failed -> sent -> delivered stays failed', async () => {
    seed('sent'); await st('failed'); expect(cur()).toBe('failed')
    await st('sent'); await st('delivered'); expect(cur()).toBe('failed')
  })
  it('delivered -> read -> delivered stays read', async () => {
    seed('sent'); await st('delivered'); await st('read'); await st('delivered'); expect(cur()).toBe('read')
  })
})

describe('P2 dedupe row is atomic with side effects', () => {
  it('a lead insert that throws once leaves nothing behind; the replay of the same wamid completes', async () => {
    const events = wb.parseWebhook(JSON.stringify(envelope('message.inbound', fixture('text'))))
    const real = d1.prepare.bind(d1)
    let thrown = false
    ;(d1 as any).prepare = (sql: string) => {
      if (!thrown && /INSERT INTO leads/.test(sql)) { thrown = true; throw new Error('boom') }
      return real(sql)
    }
    await expect(processEvents(env, ctx, events)).rejects.toThrow('boom')
    expect(count('SELECT COUNT(*) n FROM messages')).toBe(0) // message row did not survive
    const res = await processEvents(env, ctx, events)
    expect(res).toMatchObject({ messages: 1, duplicates: 0 })
    expect(count('SELECT COUNT(*) n FROM messages')).toBe(1)
    expect(count('SELECT COUNT(*) n FROM leads')).toBe(1)
  })
})

describe('P2 WhaBuzz events for another number are dropped', () => {
  it('envelope for a different phone_number_id stores nothing and is counted', async () => {
    await saveConfig(env, WBCFG)
    const other = JSON.stringify(envelope('message.inbound', fixture('text'), 0, { phone_number_id: '999000111' }))
    const res = await post('/webhooks/whabuzz', other, { 'X-WhaBuzz-Signature': sign(['whsec_TEST_x'], other, Math.floor(Date.now() / 1000)) })
    expect(res.status).toBe(200)
    expect(count('SELECT COUNT(*) n FROM messages')).toBe(0)
    expect(count('SELECT COUNT(*) n FROM contacts')).toBe(0)
    expect(count(`SELECT COUNT(*) n FROM events WHERE kind='ignored_other_number'`)).toBe(1)
  })
  it('own number and absent phone_number_id still pass', () => {
    expect(wb.parseWebhook(JSON.stringify(envelope('message.inbound', fixture('text'))))).toHaveLength(1)
    expect(wb.parseWebhook(JSON.stringify(envelope('message.inbound', fixture('text'), 0, { phone_number_id: null })))).toHaveLength(1)
  })
})

describe('v1 -> v2 upgrade on a populated database', () => {
  it('keeps rows, tolerates NULL wamids, adds the unique indexes', async () => {
    // Genuine v1 database: take the v1 DDL (everything except what v2 adds), then populate it.
    const { MIGRATIONS } = await import('../src/db')
    const v1sql = MIGRATIONS[0]
    const g = fakeD1()
    for (const s of v1sql) g.raw.exec(s)
    g.raw.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('schema_version','1')`)
    g.raw.exec(`INSERT INTO contacts (wa_id,phone) VALUES ('1','1'),('2','2')`)
    g.raw.exec(`INSERT INTO messages (contact_id,direction,wamid,type,body) VALUES (1,'out',NULL,'text','a'),(1,'out',NULL,'text','b'),(2,'in','wamid.X','text','c'),(2,'out',NULL,'text','d')`)
    g.raw.exec(`INSERT INTO leads (contact_id,source,message) VALUES (1,'pilot_form','hi')`)
    expect(await ensureSchema(g.d1)).toBe(MIGRATIONS.length)
    const n = (sql: string) => (g.raw.prepare(sql).get() as { n: number }).n
    expect(n('SELECT COUNT(*) n FROM messages')).toBe(4)
    expect(n('SELECT COUNT(*) n FROM messages WHERE wamid IS NULL')).toBe(3)
    expect(n('SELECT COUNT(*) n FROM leads')).toBe(1)
    expect((g.raw.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get() as any).value).toBe(String(MIGRATIONS.length))
    expect(() => g.raw.exec(`INSERT INTO messages (contact_id,direction,wamid) VALUES (2,'in','wamid.X')`)).toThrow() // unique now
    g.raw.exec(`INSERT INTO messages (contact_id,direction,wamid) VALUES (2,'out',NULL)`) // more NULLs still fine
    expect(n(`SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('message_statuses','adaptor_config')`)).toBe(2)
  })
})
