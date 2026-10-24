import { execSync } from 'node:child_process'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'
import { CloudApiAdaptor } from '../src/adaptors/cloud-api'
import { ensureSchema, type Env } from '../src/db'
import { processEvents } from '../src/inbound'
import { MAX_FANOUT, b64urlDecode, b64urlEncode, encryptPayload, loadVapid, purgeDeadSubscriptions, vapidHeader } from '../src/push'
import { clearSettingsCache } from '../src/settings'
import { fixture } from './helpers'
import { fakeD1 } from './d1'

const SECRET = 'test-session-secret-0123456789'
const ORIGIN = 'https://leads.example.com'
const KEY = 'adminkey'
let env: Env
let raw: DatabaseSync
let pending: Promise<unknown>[]
const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p) }, passThroughOnException: () => {} } as unknown as ExecutionContext
const settle = async () => { await Promise.all(pending); pending = [] }

type Opts = { cookie?: string; csrf?: string; bearer?: string | null }
const call = (method: string, path: string, body?: unknown, o: Opts = { bearer: KEY }) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (o.cookie) headers.Cookie = o.cookie
  if (o.csrf) headers['X-CSRF-Token'] = o.csrf
  if (o.bearer) headers.Authorization = `Bearer ${o.bearer}`
  if (method !== 'GET') headers.Origin = ORIGIN
  return worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx)
}
const q = <T = any>(sql: string, ...a: any[]) => raw.prepare(sql).get(...a) as T
const cloud = new CloudApiAdaptor({ system_token: 't', app_secret: 'appsecret', phone_number_id: '1', waba_id: '2' })

async function sessionFor() {
  const res = await worker.fetch(new Request(`${ORIGIN}/api/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ setup_key: SECRET, business_name: 'Example Co', default_country: 'US', timezone: 'UTC', admin: { name: 'Test Admin', email: 'admin@example.com', password: 'a-long-test-passphrase-1' } }),
  }), env, ctx)
  const body: any = await res.json()
  return { cookie: (res.headers.get('set-cookie') ?? '').split(';')[0], csrf: body.csrf as string }
}

/** A browser-like subscription: P-256 keypair + auth secret, so the test can decrypt what the Worker sends. */
async function device() {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair
  const pub = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer)
  const auth = crypto.getRandomValues(new Uint8Array(16))
  return { pair, pub, auth, keys: { p256dh: b64urlEncode(pub), auth: b64urlEncode(auth) } }
}
type Device = Awaited<ReturnType<typeof device>>

// Reference decrypt (RFC 8291 section 3.4 / RFC 8188), written independently of src/push.ts.
async function decrypt(d: Device, body: Uint8Array): Promise<string> {
  const salt = body.slice(0, 16); const rs = new DataView(body.buffer, body.byteOffset).getUint32(16); const idlen = body[20]
  expect(rs).toBe(4096)
  const asPub = body.slice(21, 21 + idlen); const ct = body.slice(21 + idlen)
  const hk = async (s: Uint8Array, ikm: Uint8Array, info: Uint8Array, n: number) =>
    new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: s, info }, await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), n * 8))
  const asKey = await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey } as any, d.pair.privateKey, 256))
  const te = new TextEncoder()
  const cat = (...p: Uint8Array[]) => Uint8Array.from(p.flatMap((x) => [...x]))
  const ikm = await hk(d.auth, shared, cat(te.encode('WebPush: info\0'), d.pub, asPub), 32)
  const cek = await hk(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hk(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12)
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']), ct))
  expect(pt[pt.length - 1]).toBe(2) // last-record delimiter
  return new TextDecoder().decode(pt.slice(0, -1))
}

let sent: { url: string; init: RequestInit }[]
let status: (url: string) => number
const realFetch = globalThis.fetch
beforeEach(async () => {
  const f = fakeD1(); raw = f.raw; pending = []; sent = []; status = () => 201
  env = { DB: f.d1, ADMIN_KEY: KEY, SESSION_SECRET: SECRET, INSTANCE_NAME: 'inst', ALLOWED_ORIGINS: '', META_APP_SECRET: 'appsecret' } as unknown as Env
  await ensureSchema(f.d1)
  globalThis.fetch = (async (url: any, init: any) => {
    if (!String(url).startsWith('https://push.example/')) return realFetch(url, init)
    sent.push({ url: String(url), init })
    return new Response(null, { status: status(String(url)) })
  }) as typeof fetch
})
afterEach(() => { globalThis.fetch = realFetch })

let ep = 0
async function addSub(staffId: number, d?: Device) {
  const dev = d ?? (await device())
  const endpoint = `https://push.example/s/${staffId}-${ep++}`
  raw.prepare(`INSERT INTO push_subscriptions (staff_id,endpoint,p256dh,auth) VALUES (?,?,?,?)`).run(staffId, endpoint, dev.keys.p256dh, dev.keys.auth)
  return { endpoint, dev }
}
const addStaff = (name: string, active = 1) => Number(raw.prepare(`INSERT INTO staff (email,name,role,pw_hash,active) VALUES (?,?, 'staff','x',?)`).run(`${name}@example.com`, name, active).lastInsertRowid)
const feed = (h: unknown) => processEvents(env, ctx, cloud.parseWebhook(JSON.stringify(h)))
const msgHook = (file = 'text') => fixture(file)

describe('VAPID + payload encryption', () => {
  it('encrypts a payload the subscriber can decrypt, with the aes128gcm header layout', async () => {
    const d = await device()
    const text = JSON.stringify({ title: 'Acme', body: 'Asha: héllo ✓', url: '/inbox/1', tag: 'conv-1' })
    const body = await encryptPayload(new TextEncoder().encode(text), d.keys.p256dh, d.keys.auth)
    expect(body[20]).toBe(65); expect(body[21]).toBe(4) // key id length, uncompressed point
    expect(await decrypt(d, body)).toBe(text)
    const again = await encryptPayload(new TextEncoder().encode(text), d.keys.p256dh, d.keys.auth)
    expect(b64urlEncode(again.slice(0, 16))).not.toBe(b64urlEncode(body.slice(0, 16))) // fresh salt each time
  })
  it('rejects malformed keys and oversize payloads', async () => {
    const d = await device()
    await expect(encryptPayload(new Uint8Array(4), 'AAAA', d.keys.auth)).rejects.toThrow()
    await expect(encryptPayload(new Uint8Array(5000), d.keys.p256dh, d.keys.auth)).rejects.toThrow()
  })
  it('signs an ES256 JWT that verifies against the stored public key, aud = push service origin', async () => {
    await sessionFor()
    const v = (await loadVapid(env))!
    const h = await vapidHeader(v, 'https://fcm.googleapis.com/fcm/send/abc', 1_800_000_000)
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(h)!
    expect(m[2]).toBe(v.publicKey)
    const [head, claims, sig] = m[1].split('.')
    expect(JSON.parse(atob(head))).toEqual({ typ: 'JWT', alg: 'ES256' })
    expect(JSON.parse(new TextDecoder().decode(b64urlDecode(claims)))).toMatchObject({ aud: 'https://fcm.googleapis.com', exp: 1_800_000_000 + 43200 })
    const pub = await crypto.subtle.importKey('raw', b64urlDecode(v.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, b64urlDecode(sig), new TextEncoder().encode(`${head}.${claims}`))).toBe(true)
    expect(b64urlDecode(sig).length).toBe(64)
  })
})

describe('routes', () => {
  it('401 without credentials, 403 on a session write without CSRF', async () => {
    for (const [m, p] of [['GET', '/api/push/vapid'], ['POST', '/api/push/subscribe'], ['DELETE', '/api/push/subscribe'], ['POST', '/api/push/test']])
      expect((await call(m, p, m === 'GET' ? undefined : {}, { bearer: null })).status, `${m} ${p}`).toBe(401)
    const s = await sessionFor()
    for (const [m, p] of [['POST', '/api/push/subscribe'], ['DELETE', '/api/push/subscribe'], ['POST', '/api/push/unsubscribe'], ['POST', '/api/push/test']])
      expect((await call(m, p, {}, { cookie: s.cookie })).status, `${m} ${p}`).toBe(403)
    expect((await call('GET', '/api/push/vapid', undefined, { cookie: s.cookie })).status).toBe(200)
  })
  it('vapid returns the key created at setup', async () => {
    const s = await sessionFor()
    const r: any = await (await call('GET', '/api/push/vapid', undefined, { cookie: s.cookie })).json()
    expect(r.public_key).toBe(q(`SELECT value FROM settings WHERE key='vapid_public'`).value.replace(/"/g, ''))
  })
  it('subscribe validates, upserts on endpoint (re-owns), caps per person; unsubscribe only removes own', async () => {
    const s = await sessionFor()
    const o = { cookie: s.cookie, csrf: s.csrf }
    const d = await device()
    expect((await call('POST', '/api/push/subscribe', { endpoint: 'http://evil.example/x', keys: d.keys }, o)).status).toBe(400)
    expect((await call('POST', '/api/push/subscribe', { endpoint: 'https://push.example/a', keys: { p256dh: 'x', auth: 'y' } }, o)).status).toBe(400)
    expect((await call('POST', '/api/push/subscribe', { endpoint: 'http://127.0.0.1:9/ok', keys: d.keys }, o)).status).toBe(200) // loopback stub allowed
    const sub = { endpoint: 'https://push.example/a', keys: d.keys }
    expect((await call('POST', '/api/push/subscribe', { subscription: sub }, o)).status).toBe(200)
    expect((await call('POST', '/api/push/subscribe', sub, o)).status).toBe(200) // flat body works too, still one row
    expect(q(`SELECT COUNT(*) n FROM push_subscriptions WHERE endpoint='https://push.example/a'`).n).toBe(1)
    const other = addStaff('bea')
    raw.prepare(`UPDATE push_subscriptions SET staff_id=?, fail_count=3 WHERE endpoint='https://push.example/a'`).run(other)
    await call('POST', '/api/push/subscribe', sub, o)
    expect(q(`SELECT staff_id,fail_count FROM push_subscriptions WHERE endpoint='https://push.example/a'`)).toMatchObject({ staff_id: 1, fail_count: 0 })
    raw.prepare(`UPDATE push_subscriptions SET staff_id=? WHERE endpoint='https://push.example/a'`).run(other)
    await call('DELETE', '/api/push/subscribe', { endpoint: sub.endpoint }, o) // not mine: untouched
    expect(q(`SELECT COUNT(*) n FROM push_subscriptions WHERE endpoint='https://push.example/a'`).n).toBe(1)
    raw.prepare(`UPDATE push_subscriptions SET staff_id=1 WHERE endpoint='https://push.example/a'`).run()
    expect((await call('DELETE', '/api/push/subscribe', { endpoint: sub.endpoint }, o)).status).toBe(200)
    expect(q(`SELECT COUNT(*) n FROM push_subscriptions WHERE endpoint='https://push.example/a'`).n).toBe(0)
    for (let i = 0; i < 9; i++) await call('POST', '/api/push/subscribe', { endpoint: `https://push.example/n${i}`, keys: d.keys }, o) // 1 loopback + 9 = 10
    expect((await call('POST', '/api/push/subscribe', { endpoint: 'https://push.example/over', keys: d.keys }, o)).status).toBe(409)
  })
  it('signing in on a device another person subscribed moves the endpoint to the signed-in person', async () => {
    const s = await sessionFor()
    const bea = addStaff('bea')
    const theirs = await addSub(bea)
    raw.prepare(`UPDATE push_subscriptions SET fail_count=3 WHERE endpoint=?`).run(theirs.endpoint)
    const r = await call('POST', '/api/push/subscribe', { endpoint: theirs.endpoint, keys: theirs.dev.keys }, { cookie: s.cookie, csrf: s.csrf })
    expect(r.status).toBe(200)
    expect(q(`SELECT COUNT(*) n FROM push_subscriptions`).n).toBe(1)
    expect(q(`SELECT staff_id,fail_count FROM push_subscriptions WHERE endpoint='${theirs.endpoint}'`)).toMatchObject({ staff_id: 1, fail_count: 0 })
    expect(q(`SELECT COUNT(*) n FROM push_subscriptions WHERE staff_id=${bea}`).n).toBe(0)
  })
  it('test sends an encrypted notification to the caller only and returns {sent}', async () => {
    const s = await sessionFor()
    const mine = await addSub(1); await addSub(addStaff('bea'))
    const r: any = await (await call('POST', '/api/push/test', undefined, { cookie: s.cookie, csrf: s.csrf })).json()
    expect(r).toMatchObject({ ok: true, sent: 1, devices: 1 })
    expect(sent).toHaveLength(1)
    const h = sent[0].init.headers as Record<string, string>
    expect(h['Content-Encoding']).toBe('aes128gcm'); expect(h.TTL).toBe('86400'); expect(h.Authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/)
    expect(JSON.parse(await decrypt(mine.dev, sent[0].init.body as Uint8Array))).toMatchObject({ title: 'Example Co', tag: 'test' })
  })
  it('the ADMIN_KEY bearer has no device, so subscribe/test answer 400', async () => {
    expect((await call('POST', '/api/push/test')).status).toBe(400)
  })
})

describe('recipients (plan C6 table)', () => {
  async function inbound(wa = '15550001111') {
    const h = msgHook(); h.entry[0].changes[0].value.messages[0].from = wa
    await feed(h); await settle()
  }
  const hosts = () => sent.map((x) => x.url)
  it('unassigned conversation: every ACTIVE staff, never inactive', async () => {
    await sessionFor()
    const a = await addSub(1); const b = await addSub(addStaff('bea')); await addSub(addStaff('gone', 0))
    await inbound()
    expect(hosts().sort()).toEqual([a.endpoint, b.endpoint].sort())
  })
  it('assigned conversation: only the assignee', async () => {
    await sessionFor()
    const bea = addStaff('bea'); await addSub(1); const b = await addSub(bea)
    const h = msgHook(); h.entry[0].changes[0].value.messages[0].from = '15550001111'
    await feed(h); await settle(); sent = []
    raw.prepare(`UPDATE conversations SET assigned_to=?`).run(bea)
    const h2 = msgHook(); h2.entry[0].changes[0].value.messages[0].from = '15550001111'; h2.entry[0].changes[0].value.messages[0].id = 'wamid.second'
    await feed(h2); await settle()
    expect(hosts()).toEqual([b.endpoint])
    const p = JSON.parse(await decrypt(b.dev, sent[0].init.body as Uint8Array))
    expect(p.url).toMatch(/^\/inbox\/\d+$/); expect(p.tag).toMatch(/^conv-\d+$/)
  })
  it('assignee inactive: falls back to every active staff', async () => {
    await sessionFor()
    const gone = addStaff('gone', 0); await addSub(gone); const a = await addSub(1)
    const h = msgHook(); await feed(h); await settle(); sent = []
    raw.prepare(`UPDATE conversations SET assigned_to=?`).run(gone)
    const h2 = msgHook(); h2.entry[0].changes[0].value.messages[0].id = 'wamid.third'
    await feed(h2); await settle()
    expect(hosts()).toEqual([a.endpoint])
  })
  it('a brand-new lead pushes the lead (url /leads/<id>) to all active staff, once', async () => {
    await sessionFor()
    const a = await addSub(1); await addSub(addStaff('gone', 0))
    await feed(msgHook()); await settle()
    expect(sent).toHaveLength(1)
    const lead = q(`SELECT id FROM leads`)
    expect(JSON.parse(await decrypt(a.dev, sent[0].init.body as Uint8Array))).toMatchObject({ url: `/leads/${lead.id}`, tag: `lead-${lead.id}` })
  })
  it('public form intake pushes the new lead', async () => {
    await sessionFor()
    raw.prepare(`INSERT INTO settings (key,value) VALUES ('allowed_origins', ?)`).run(JSON.stringify([ORIGIN])); clearSettingsCache(env.DB)
    const a = await addSub(1)
    const r = await call('POST', '/api/leads', { phone: '+15550000102', name: 'Form Person', message: 'hi', source: 'contact_form' }, { bearer: null })
    expect(r.status).toBe(200); await settle()
    expect(sent).toHaveLength(1)
    expect(JSON.parse(await decrypt(a.dev, sent[0].init.body as Uint8Array)).body).toBe('Form Person · contact_form')
  })
  it('a replayed wamid does not push twice', async () => {
    await sessionFor(); await addSub(1)
    await feed(msgHook()); await feed(msgHook()); await settle()
    expect(sent).toHaveLength(1)
  })
  it(`caps a send at ${MAX_FANOUT} subscriptions and logs the truncation`, async () => {
    await sessionFor()
    const d = await device()
    for (let i = 0; i < 45; i++) await addSub(1, d)
    await feed(msgHook()); await settle()
    expect(sent).toHaveLength(MAX_FANOUT)
    expect(q(`SELECT COUNT(*) n FROM events WHERE kind='push_truncated'`).n).toBe(1)
  })
  it('beyond the cap the healthiest, most recently working devices are chosen, not the oldest', async () => {
    await sessionFor()
    const d = await device()
    const subs: string[] = []
    for (let i = 0; i < 45; i++) subs.push((await addSub(1, d)).endpoint)
    // 45 rows, 40 slots. ids 4-6 are failing; ids 9-10 are the oldest never-ok rows; ids 1-3 are the oldest rows but recently ok
    raw.prepare(`UPDATE push_subscriptions SET last_ok_at=2000000000 WHERE id<=3`).run()
    raw.prepare(`UPDATE push_subscriptions SET fail_count=2 WHERE id BETWEEN 4 AND 6`).run()
    raw.prepare(`UPDATE push_subscriptions SET created_at=1000 WHERE id IN (9,10)`).run()
    await feed(msgHook()); await settle()
    const hit = new Set(sent.map((x) => x.url))
    expect(hit.size).toBe(MAX_FANOUT)
    for (const i of [0, 1, 2]) expect(hit.has(subs[i])).toBe(true) // old rows that still work are kept
    for (const id of [4, 5, 6, 9, 10]) expect(hit.has(subs[id - 1])).toBe(false) // failing first, then stalest
    expect(hit.has(subs[44])).toBe(true) // newest row is included
  })
})

describe('subscription health', () => {
  const lead = async () => { await feed(msgHook()); await settle() }
  it('410 and 404 delete the subscription; 201 resets failures', async () => {
    await sessionFor()
    const gone = await addSub(1); const missing = await addSub(1); const ok = await addSub(1)
    raw.prepare(`UPDATE push_subscriptions SET fail_count=2 WHERE endpoint=?`).run(ok.endpoint)
    status = (u) => (u === gone.endpoint ? 410 : u === missing.endpoint ? 404 : 201)
    await lead()
    expect(raw.prepare(`SELECT endpoint FROM push_subscriptions`).all().map((r: any) => r.endpoint)).toEqual([ok.endpoint])
    expect(q(`SELECT fail_count,last_ok_at FROM push_subscriptions`)).toMatchObject({ fail_count: 0 })
    expect(q(`SELECT last_ok_at FROM push_subscriptions`).last_ok_at).not.toBeNull()
  })
  it('a push service that never answers is aborted after the timeout and counted as a failure', async () => {
    await sessionFor(); await addSub(1); const ok = await addSub(1)
    const realTimeout = AbortSignal.timeout.bind(AbortSignal)
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => realTimeout(30))
    const base = globalThis.fetch
    globalThis.fetch = (async (url: any, init: any) => {
      if (!String(url).endsWith(ok.endpoint.split('/').pop()!)) {
        sent.push({ url: String(url), init })
        return new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(init.signal.reason)))
      }
      return base(url, init)
    }) as typeof fetch
    await lead()
    expect(spy).toHaveBeenCalledWith(10_000)
    spy.mockRestore()
    expect(q(`SELECT fail_count FROM push_subscriptions WHERE id=1`).fail_count).toBe(1)
    expect(q(`SELECT fail_count,last_ok_at FROM push_subscriptions WHERE id=2`)).toMatchObject({ fail_count: 0 })
  })
  it('other failures count up and the fifth consecutive one deletes', async () => {
    await sessionFor()
    await addSub(1)
    status = () => 500
    for (let i = 1; i <= 4; i++) {
      const h = msgHook(); h.entry[0].changes[0].value.messages[0].id = `wamid.f${i}`
      await feed(h); await settle()
      expect(q(`SELECT fail_count FROM push_subscriptions`).fail_count).toBe(i)
    }
    const h = msgHook(); h.entry[0].changes[0].value.messages[0].id = 'wamid.f5'
    await feed(h); await settle()
    expect(q(`SELECT COUNT(*) n FROM push_subscriptions`).n).toBe(0)
  })
  it('a success between failures resets the streak', async () => {
    await sessionFor(); await addSub(1)
    status = () => 500; await lead()
    expect(q(`SELECT fail_count FROM push_subscriptions`).fail_count).toBe(1)
    status = () => 201
    const h = msgHook(); h.entry[0].changes[0].value.messages[0].id = 'wamid.ok'; await feed(h); await settle()
    expect(q(`SELECT fail_count FROM push_subscriptions`).fail_count).toBe(0)
  })
  it('cron purges rows at the failure limit, idempotently', async () => {
    await sessionFor()
    await addSub(1); await addSub(1)
    raw.prepare(`UPDATE push_subscriptions SET fail_count=5 WHERE id=1`).run()
    expect(await purgeDeadSubscriptions(env)).toBe(1)
    expect(await purgeDeadSubscriptions(env)).toBe(0)
    expect(q(`SELECT COUNT(*) n FROM push_subscriptions`).n).toBe(1)
  })
})

describe('push never breaks the pipeline', () => {
  it('network failures and a missing VAPID key leave the webhook result and the rows intact', async () => {
    await sessionFor(); await addSub(1)
    globalThis.fetch = (async () => { throw new Error('push service down') }) as typeof fetch
    const res = await feed(msgHook())
    expect(res).toMatchObject({ messages: 1 })
    await expect(settle()).resolves.toBeUndefined()
    expect(q(`SELECT COUNT(*) n FROM messages`).n).toBe(1); expect(q(`SELECT COUNT(*) n FROM leads`).n).toBe(1)
    expect(q(`SELECT fail_count FROM push_subscriptions`).fail_count).toBe(1)
    raw.prepare(`DELETE FROM settings WHERE key='vapid_private_enc'`).run()
    const h = msgHook(); h.entry[0].changes[0].value.messages[0].id = 'wamid.nokey'
    expect(await feed(h)).toMatchObject({ messages: 1 }); await expect(settle()).resolves.toBeUndefined()
  })
  it('a throwing DB inside the push task is swallowed under waitUntil', async () => {
    await sessionFor(); await addSub(1)
    const real = env.DB.prepare.bind(env.DB)
    env.DB = { ...env.DB, prepare: (sql: string) => { if (/FROM push_subscriptions p JOIN staff/.test(sql)) throw new Error('db down'); return real(sql) }, batch: env.DB.batch.bind(env.DB) } as unknown as D1Database
    const res = await feed(msgHook())
    expect(res).toMatchObject({ messages: 1 })
    await expect(settle()).resolves.toBeUndefined()
  })
})

describe('D17: no WhatsApp staff alerts', () => {
  it('the retired alert names appear nowhere in src, test or wrangler.jsonc', () => {
    // build the pattern at runtime so this file does not match itself
    const names = [['ALERT', 'TO'].join('_'), ['lead', 'alert'].join('_'), ['alert', 'Inbound'].join('')].join('|')
    const out = execSync(`grep -rEl "${names}" src test wrangler.jsonc || true`, { cwd: new URL('..', import.meta.url).pathname }).toString().split('\n').filter(Boolean)
    expect(out).toEqual([])
  })
})
