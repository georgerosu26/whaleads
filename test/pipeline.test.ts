import { beforeEach, describe, expect, it } from 'vitest'
import { CloudApiAdaptor } from '../src/adaptors/cloud-api'
import { WhaBuzzAdaptor } from '../src/adaptors/whabuzz'
import { ensureSchema, type Env } from '../src/db'
import { processEvents } from '../src/inbound'
import { handleWebhook } from '../src/webhook'
import { ctx, envelope, fixture, metaSig, sign } from './helpers'
import { fakeD1 } from './d1'

let raw: ReturnType<typeof fakeD1>['raw']
let env: Env

beforeEach(async () => {
  const f = fakeD1()
  raw = f.raw
  env = { DB: f.d1, INSTANCE_NAME: 't', ALLOWED_ORIGINS: '', META_APP_SECRET: 'appsecret', META_SYSTEM_TOKEN: 'tok', META_PHONE_NUMBER_ID: '1', META_WABA_ID: '2' } as unknown as Env
  await ensureSchema(f.d1)
})

const count = (sql: string) => (raw.prepare(sql).get() as { n: number }).n
const cloud = new CloudApiAdaptor({ system_token: 't', app_secret: 'appsecret', phone_number_id: '1', waba_id: '2' })
const wb = new WhaBuzzAdaptor({ api_key: 'k', phone_number_id: '1000000000000001', waba_id: '2', webhook_secret: 's' })

describe('shared inbound pipeline: wamid dedupe', () => {
  it('same message on both routes is stored once', async () => {
    const body = fixture('text')
    const a = await processEvents(env, ctx, cloud.parseWebhook(JSON.stringify(body)))
    const b = await processEvents(env, ctx, wb.parseWebhook(JSON.stringify(envelope('message.inbound', body))))
    expect(a).toMatchObject({ messages: 1, duplicates: 0 })
    expect(b).toMatchObject({ messages: 0, duplicates: 1 })
    expect(count('SELECT COUNT(*) n FROM messages')).toBe(1)
    expect(count('SELECT COUNT(*) n FROM contacts')).toBe(1)
    expect(count('SELECT COUNT(*) n FROM leads')).toBe(1)
  })
  it('same status on both routes is stored once; (wamid,status) pairs differ', async () => {
    const body = fixture('statuses_multi')
    await processEvents(env, ctx, cloud.parseWebhook(JSON.stringify(body)))
    expect(count('SELECT COUNT(*) n FROM message_statuses')).toBe(3)
    const again = await processEvents(env, ctx, wb.parseWebhook(JSON.stringify(envelope('message.status', body, 0))))
    expect(again).toMatchObject({ statuses: 0, duplicates: 1 })
    expect(count('SELECT COUNT(*) n FROM message_statuses')).toBe(3)
  })
  it('status never regresses (read stays read after a late delivered)', async () => {
    const d = fixture('status_delivered')
    const wamid = d.entry[0].changes[0].value.statuses[0].id
    raw.prepare(`INSERT INTO contacts (wa_id,phone) VALUES ('16505550123','16505550123')`).run()
    raw.prepare(`INSERT INTO messages (contact_id,direction,wamid,type,status) VALUES (1,'out',?,'text','read')`).run(wamid)
    await processEvents(env, ctx, cloud.parseWebhook(JSON.stringify(d)))
    expect((raw.prepare('SELECT status FROM messages').get() as any).status).toBe('read')
    raw.prepare(`UPDATE messages SET status='sent'`).run()
    const d2 = fixture('status_delivered'); d2.entry[0].changes[0].value.statuses[0].status = 'read'
    await processEvents(env, ctx, cloud.parseWebhook(JSON.stringify(d2)))
    expect((raw.prepare('SELECT status FROM messages').get() as any).status).toBe('read')
  })
  it('the DB itself rejects a duplicate wamid / (wamid,status)', () => {
    raw.prepare(`INSERT INTO contacts (wa_id) VALUES ('1')`).run()
    raw.prepare(`INSERT INTO messages (contact_id,direction,wamid) VALUES (1,'in','w1')`).run()
    expect(() => raw.prepare(`INSERT INTO messages (contact_id,direction,wamid) VALUES (1,'in','w1')`).run()).toThrow()
    raw.prepare(`INSERT INTO message_statuses (wamid,status) VALUES ('w1','sent')`).run()
    expect(() => raw.prepare(`INSERT INTO message_statuses (wamid,status) VALUES ('w1','sent')`).run()).toThrow()
    raw.prepare(`INSERT INTO message_statuses (wamid,status) VALUES ('w1','read')`).run()
  })
})

describe('webhook routes end to end', () => {
  it('/webhooks/meta: good signature stores, bad signature 401', async () => {
    const body = JSON.stringify(fixture('text'))
    const ok = await handleWebhook('cloud_api', new Request('https://x/webhooks/meta', { method: 'POST', headers: { 'X-Hub-Signature-256': metaSig('appsecret', body) }, body }), env, ctx)
    expect(ok.status).toBe(200)
    expect(count('SELECT COUNT(*) n FROM messages')).toBe(1)
    const bad = await handleWebhook('cloud_api', new Request('https://x/webhooks/meta', { method: 'POST', headers: { 'X-Hub-Signature-256': 'sha256=00' }, body }), env, ctx)
    expect(bad.status).toBe(401)
  })
  it('/webhooks/whabuzz: 401 until configured (an unsigned event is never accepted)', async () => {
    const res = await handleWebhook('whabuzz', new Request('https://x/webhooks/whabuzz', { method: 'POST', body: '{}' }), env, ctx)
    expect(res.status).toBe(401)
  })
  it('/webhooks/whabuzz with a D1-stored config verifies, stores, and dedupes against /meta', async () => {
    const { saveConfig } = await import('../src/adaptors')
    env.SESSION_SECRET = 'session-secret'
    await saveConfig(env, { kind: 'whabuzz', config: { api_key: 'k', phone_number_id: '1', waba_id: '2', webhook_secret: 'whsec_TEST_x' } })
    const body = fixture('text')
    const metaBody = JSON.stringify(body)
    // old Meta app route still works while whabuzz is the stored adaptor (legacy env creds)
    const m = await handleWebhook('cloud_api', new Request('https://x/webhooks/meta', { method: 'POST', headers: { 'X-Hub-Signature-256': metaSig('appsecret', metaBody) }, body: metaBody }), env, ctx)
    expect(m.status).toBe(200)
    const env2 = JSON.stringify(envelope('message.inbound', body))
    const t = Math.floor(Date.now() / 1000)
    const w = await handleWebhook('whabuzz', new Request('https://x/webhooks/whabuzz', { method: 'POST', headers: { 'X-WhaBuzz-Signature': sign(['whsec_TEST_x'], env2, t) }, body: env2 }), env, ctx)
    expect(w.status).toBe(200)
    expect(count('SELECT COUNT(*) n FROM messages')).toBe(1)
    const stale = await handleWebhook('whabuzz', new Request('https://x/webhooks/whabuzz', { method: 'POST', headers: { 'X-WhaBuzz-Signature': sign(['whsec_TEST_x'], env2, t - 400) }, body: env2 }), env, ctx)
    expect(stale.status).toBe(401)
  })
})
