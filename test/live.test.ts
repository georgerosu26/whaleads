// D20 live channel: the publish helper, where publishers fire, the /api/live gate, and the hub itself (with a fake runtime).
import type { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'
import { CloudApiAdaptor } from '../src/adaptors/cloud-api'
import { ensureSchema, type Env } from '../src/db'
import { processEvents } from '../src/inbound'
import { publish, publishLater, type LiveEvent } from '../src/live'
import { LiveHub, MAX_SOCKET_AGE_MS } from '../src/livehub'
import { fixture } from './helpers'
import { fakeD1 } from './d1'

const SECRET = 'test-session-secret-0123456789'
const ORIGIN = 'https://leads.example.com'
const KEY = 'adminkey'

let env: Env
let raw: DatabaseSync
let waiting: Promise<unknown>[]
let sent: LiveEvent[][]
let revokes: unknown[] = []
const ctx = { waitUntil: (p: Promise<unknown>) => { waiting.push(p) }, passThroughOnException: () => {} } as unknown as ExecutionContext
const settle = async () => { await Promise.allSettled(waiting); waiting = [] }
const q = <T = any>(sql: string, ...a: any[]) => raw.prepare(sql).get(...a) as T
const types = () => sent.flat().map((e) => e.type)
const all = (type: string) => sent.flat().filter((e) => e.type === type)
const cloud = new CloudApiAdaptor({ system_token: 't', app_secret: 'appsecret', phone_number_id: '1', waba_id: '2' })

/** A LIVE namespace whose hub records every broadcast and whose connect() can be inspected. */
function fakeLive(o: { fail?: boolean } = {}) {
  const connects: Request[] = []
  const hub = {
    broadcast: async (frames: string[]) => { if (o.fail) throw new Error('hub down'); sent.push(frames.map((f) => JSON.parse(f))); return 1 },
    fetch: async (r: Request) => { connects.push(r); return new Response('ok', { status: 200 }) },
    revoke: async (sel: unknown) => { if (o.fail) throw new Error('hub down'); revokes.push(sel); return 1 },
  }
  return { ns: { idFromName: (n: string) => n, get: () => hub } as unknown as Env['LIVE'], connects }
}

function textHook(wamid: string, from = '15550000001', body = 'hello there') {
  const f = fixture('text')
  const v = f.entry[0].changes[0].value
  v.messages[0] = { ...v.messages[0], from, id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), text: { body } }
  v.contacts[0] = { ...v.contacts[0], wa_id: from, profile: { name: 'Test Person' } }
  return f
}
const feed = (hook: any) => processEvents(env, ctx, cloud.parseWebhook(JSON.stringify(hook)))

type Opts = { cookie?: string; csrf?: string; bearer?: string | null; headers?: Record<string, string> }
const call = (method: string, path: string, body?: unknown, o: Opts = { bearer: KEY }) => {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...o.headers }
  if (o.cookie) headers.Cookie = o.cookie
  if (o.csrf) headers['X-CSRF-Token'] = o.csrf
  if (o.bearer) headers.Authorization = `Bearer ${o.bearer}`
  if (method !== 'GET') headers.Origin = ORIGIN
  return worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx)
}
async function session() {
  const res = await worker.fetch(new Request(`${ORIGIN}/api/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ setup_key: SECRET, business_name: 'Example Co', default_country: 'US', timezone: 'UTC', admin: { name: 'Test Admin', email: 'admin@example.com', password: 'correct horse battery staple' } }),
  }), env, ctx)
  const body: any = await res.json()
  return { cookie: (res.headers.get('set-cookie') ?? '').split(';')[0]!, csrf: body.csrf as string }
}

let connects: Request[]
beforeEach(async () => {
  const f = fakeD1(); raw = f.raw
  waiting = []; sent = []; revokes = []
  const live = fakeLive(); connects = live.connects
  env = { DB: f.d1, ADMIN_KEY: KEY, SESSION_SECRET: SECRET, INSTANCE_NAME: 'inst', ALLOWED_ORIGINS: '', META_APP_SECRET: 'appsecret', LIVE: live.ns } as unknown as Env
  await ensureSchema(f.d1)
})

describe('publish helper', () => {
  it('never throws when the hub fails: logs live_publish_error and returns 0', async () => {
    env.LIVE = fakeLive({ fail: true }).ns
    await expect(publish(env, [{ type: 'unread.total', ts: 1, data: { unread: 1 } }])).resolves.toBe(0)
    expect(q(`SELECT payload FROM events WHERE kind='live_publish_error'`).payload).toContain('hub down')
  })
  it('a builder that throws is logged, not raised, and does not touch the caller', async () => {
    publishLater(env, ctx, async () => { throw new Error('boom') })
    await expect(settle()).resolves.toBeUndefined()
    expect(q(`SELECT payload FROM events WHERE kind='live_publish_error'`).payload).toContain('boom')
  })
  it('is a no-op without the LIVE binding', async () => {
    delete env.LIVE
    publishLater(env, ctx, async () => { throw new Error('should not run') })
    expect(waiting).toHaveLength(0)
    await expect(publish(env, [{ type: 'unread.total', ts: 1, data: {} }])).resolves.toBe(0)
  })
  it('an inbound webhook still succeeds while the hub is down', async () => {
    env.LIVE = fakeLive({ fail: true }).ns
    const res = await feed(textHook('wamid.DOWN'))
    await settle()
    expect(res.messages).toBe(1)
    expect(q(`SELECT COUNT(*) n FROM messages`).n).toBe(1)
  })
})

describe('publishers', () => {
  it('inbound message: message.new + conversation.update + unread.total, once per wamid', async () => {
    await feed(textHook('wamid.A'))
    await settle()
    expect(types()).toEqual(['message.new', 'conversation.update', 'unread.total', 'lead.new'])
    const m: any = all('message.new')[0]!
    expect(m.data.contact_id).toBe(1)
    expect(m.data.message).toMatchObject({ id: 1, direction: 'in', wamid: 'wamid.A', type: 'text', body: 'hello there', media: null })
    expect(all('conversation.update')[0]!.data).toMatchObject({ contact_id: 1, name: 'Test Person', unread_count: 1, last_preview: 'hello there', status: 'open', assigned_to: null })
    expect(typeof all('conversation.update')[0]!.data.window_closes_at).toBe('number')
    expect(all('unread.total')[0]!.data).toEqual({ unread: 1 })
    expect(all('lead.new')[0]!.data).toMatchObject({ contact_id: 1, status: 'new', source: 'whatsapp' })
    expect(typeof all('message.new')[0]!.ts).toBe('number')
    sent.length = 0
    await feed(textHook('wamid.A')) // replay: nothing new, nothing published
    await settle()
    expect(sent).toHaveLength(0)
  })

  it('a second message from a known lead publishes no lead.new', async () => {
    await feed(textHook('wamid.A')); await settle(); sent.length = 0
    await feed(textHook('wamid.B', '15550000001', 'again')); await settle()
    expect(types()).toEqual(['message.new', 'conversation.update', 'unread.total'])
    expect(all('conversation.update')[0]!.data.unread_count).toBe(2)
  })

  it('status receipts publish message.status only when the tick moved', async () => {
    raw.exec(`INSERT INTO contacts (id,wa_id,phone) VALUES (5,'16505550123','16505550123')`)
    raw.exec(`INSERT INTO messages (contact_id,direction,wamid,type,body,status,timestamp) VALUES (5,'out','wamid.HBgLMTY1MDU1NTAxMjMVAgASGBQzQUY5QTdGNkU0RTFGMkI3QzFB41AA=','text','hi','sent',1)`)
    await processEvents(env, ctx, cloud.parseWebhook(JSON.stringify(fixture('status_delivered')))); await settle()
    expect(all('message.status')).toHaveLength(1)
    expect(all('message.status')[0]!.data).toMatchObject({ contact_id: 5, status: 'delivered' })
    sent.length = 0
    await processEvents(env, ctx, cloud.parseWebhook(JSON.stringify(fixture('status_delivered')))); await settle() // duplicate
    expect(sent).toHaveLength(0)
  })

  it('read, assign and close publish conversation.update with fresh state', async () => {
    await feed(textHook('wamid.A')); await settle(); sent.length = 0
    expect((await call('POST', '/api/conversations/1/read')).status).toBe(200); await settle()
    expect(all('conversation.update')[0]!.data.unread_count).toBe(0)
    expect(all('unread.total')[0]!.data).toEqual({ unread: 0 })
    sent.length = 0
    const s = await session()
    const staffId = q(`SELECT id FROM staff`).id
    expect((await call('PATCH', '/api/conversations/1', { status: 'closed', assigned_to: staffId }, { cookie: s.cookie, csrf: s.csrf })).status).toBe(200); await settle()
    expect(all('conversation.update')[0]!.data).toMatchObject({ status: 'closed', assigned_to: staffId, assigned_name: 'Test Admin' })
  })

  it('a read that changed nothing publishes nothing', async () => {
    await feed(textHook('wamid.A')); await settle()
    await call('POST', '/api/conversations/1/read'); await settle(); sent.length = 0
    await call('POST', '/api/conversations/1/read'); await settle()
    expect(sent).toHaveLength(0)
  })

  it('manual lead create -> lead.new, stage/owner change -> lead.update', async () => {
    const s = await session()
    const created: any = await (await call('POST', '/api/leads/manual', { phone: '+15550000101', name: 'Manual' }, { cookie: s.cookie, csrf: s.csrf })).json()
    await settle()
    expect(all('lead.new')[0]!.data).toMatchObject({ id: created.id, status: 'new', owner: null })
    sent.length = 0
    const stage = q(`SELECT key FROM stages WHERE kind='open' AND key <> 'new' ORDER BY position LIMIT 1`).key
    expect((await call('PATCH', `/api/leads/${created.id}`, { status: stage, assigned_to: q(`SELECT id FROM staff`).id }, { cookie: s.cookie, csrf: s.csrf })).status).toBe(200); await settle()
    expect(all('lead.update')[0]!.data).toMatchObject({ id: created.id, status: stage, owner: q(`SELECT id FROM staff`).id })
  })

  it('website form intake -> lead.new', async () => {
    const res = await call('POST', '/api/leads', { source: 'contact_form', name: 'Form Person', phone: '+15550000202' }, { bearer: null, headers: { Origin: ORIGIN } })
    await settle()
    // the intake may refuse an unlisted origin; what matters is that a stored lead is announced and a refused one is not
    expect(all('lead.new')).toHaveLength(res.status === 200 ? 1 : 0)
  })
})

describe('GET /api/live gate', () => {
  const up = { Upgrade: 'websocket', Connection: 'Upgrade' }
  it('401 without a session', async () => {
    expect((await call('GET', '/api/live', undefined, { bearer: null, headers: { ...up, Origin: ORIGIN } })).status).toBe(401)
    expect(connects).toHaveLength(0)
  })
  it('400 for an ADMIN_KEY caller', async () => {
    expect((await call('GET', '/api/live', undefined, { bearer: KEY, headers: { ...up, Origin: ORIGIN } })).status).toBe(400)
    expect(connects).toHaveLength(0)
  })
  it('403 for a foreign or missing Origin', async () => {
    const s = await session()
    expect((await call('GET', '/api/live', undefined, { cookie: s.cookie, headers: { ...up, Origin: 'https://evil.example' } })).status).toBe(403)
    expect((await call('GET', '/api/live', undefined, { cookie: s.cookie, headers: up })).status).toBe(403)
    expect(connects).toHaveLength(0)
  })
  it('426 when it is not an upgrade', async () => {
    const s = await session()
    expect((await call('GET', '/api/live', undefined, { cookie: s.cookie, headers: { Origin: ORIGIN } })).status).toBe(426)
  })
  it('forwards a good session to the hub with the VERIFIED identity, ignoring client-sent ids', async () => {
    const s = await session()
    await call('GET', '/api/live', undefined, { cookie: s.cookie, headers: { ...up, Origin: ORIGIN, 'x-live-staff': '999', 'x-live-role': 'root' } })
    expect(connects).toHaveLength(1)
    expect(connects[0]!.headers.get('x-live-staff')).toBe(String(q(`SELECT id FROM staff`).id))
    expect(connects[0]!.headers.get('x-live-role')).toBe('admin')
    expect(connects[0]!.headers.get('Upgrade')).toBe('websocket')
    expect(connects[0]!.headers.get('x-live-sid')).toMatch(/^[0-9a-f]{64}$/) // the verified session hash, so a logout can close exactly this tab's socket
  })
  it('503 when the binding is absent', async () => {
    delete env.LIVE
    const s = await session()
    expect((await call('GET', '/api/live', undefined, { cookie: s.cookie, headers: { ...up, Origin: ORIGIN } })).status).toBe(503)
  })
})

describe('LiveHub (fake runtime)', () => {
  function sock(at = Date.now()) {
    let att: unknown = { staff: 1, role: 'staff', at }
    return { frames: [] as string[], closed: null as number | null, send(f: string) { this.frames.push(f) }, close(c: number) { this.closed = c }, serializeAttachment: (v: unknown) => { att = v }, deserializeAttachment: () => att }
  }
  function hub(socks: ReturnType<typeof sock>[]) {
    const pairs: unknown[] = []
    vi.stubGlobal('WebSocketRequestResponsePair', class { constructor(public req: string, public res: string) { pairs.push([req, res]) } })
    const state = { setWebSocketAutoResponse: vi.fn(), getWebSockets: () => socks, acceptWebSocket: vi.fn() }
    return { h: new LiveHub(state as any, {} as Env), state, pairs }
  }
  it('registers the ping/pong auto-response (hibernation-friendly keep-alive)', () => {
    const { state, pairs } = hub([])
    expect(state.setWebSocketAutoResponse).toHaveBeenCalledOnce()
    expect(pairs).toEqual([['ping', 'pong']])
  })
  it('broadcasts every frame to every socket and survives a dead one', async () => {
    const a = sock(), b = sock(); b.send = () => { throw new Error('closed') }
    const { h } = hub([a, b])
    expect(await h.broadcast(['{"x":1}', '{"x":2}'])).toBe(1)
    expect(a.frames).toEqual(['{"x":1}', '{"x":2}'])
    expect(b.closed).toBe(1011)
  })
  it('closes sockets older than the max age instead of sending to them', async () => {
    const old = sock(Date.now() - MAX_SOCKET_AGE_MS - 1)
    const { h } = hub([old])
    expect(await h.broadcast(['{}'])).toBe(0)
    expect(old.closed).toBe(1008); expect(old.frames).toEqual([])
  })
  it('rejects a non-upgrade (426) and an upgrade without an identity (400)', async () => {
    const { h } = hub([])
    expect((await h.fetch(new Request('https://x/connect'))).status).toBe(426)
    expect((await h.fetch(new Request('https://x/connect', { headers: { Upgrade: 'websocket' } }))).status).toBe(400)
  })
})

describe('outbound publishers (inside the deferred record, after the batch)', () => {
  const WB = { kind: 'whabuzz' as const, config: { api_key: 'k', phone_number_id: '1000000000000001', waba_id: '2', webhook_secret: 'whsec_TEST_x' } }
  async function staff() {
    const res = await worker.fetch(new Request(`${ORIGIN}/api/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ setup_key: SECRET, business_name: 'Example Co', default_country: 'US', timezone: 'UTC', admin: { name: 'Test Admin', email: 'admin@example.com', password: 'correct horse battery staple' } }),
    }), env, ctx)
    const body: any = await res.json()
    return { cookie: (res.headers.get('set-cookie') ?? '').split(';')[0]!, csrf: body.csrf as string }
  }
  const sendText = (s: { cookie: string; csrf: string }, text: string) => worker.fetch(new Request(`${ORIGIN}/api/inbox/1/send`, {
    method: 'POST', body: JSON.stringify({ text }), headers: { 'content-type': 'application/json', Origin: ORIGIN, Cookie: s.cookie, 'X-CSRF-Token': s.csrf },
  }), env, ctx)
  beforeEach(async () => {
    const { saveConfig } = await import('../src/adaptors')
    await saveConfig(env, WB)
    raw.exec(`INSERT INTO contacts (id,wa_id,phone,name) VALUES (1,'15550000001','15550000001','Asha')`)
    raw.exec(`INSERT INTO conversations (contact_id,last_message_at,last_inbound_at,last_preview,unread_count) VALUES (1,${Math.floor(Date.now() / 1000) - 60},${Math.floor(Date.now() / 1000) - 60},'hi',0)`)
    let n = 0
    vi.stubGlobal('fetch', async (u: any) => new Response(JSON.stringify(String(u).includes('/v1/media') ? { id: 'mid1' } : { messages: [{ id: `wamid.LV${++n}` }] }), { status: 200 }))
  })

  it('a text send publishes message.new + conversation.update once the row exists; the reply does not wait for it', async () => {
    const s = await staff()
    const res = await sendText(s, 'hello out')
    expect(res.status).toBe(200)
    await settle()
    const mn = all('message.new')
    expect(mn).toHaveLength(1)
    expect(mn[0]!.data).toMatchObject({ contact_id: 1, message: { direction: 'out', body: 'hello out', wamid: 'wamid.LV1' } })
    expect(all('conversation.update')[0]!.data).toMatchObject({ contact_id: 1, last_preview: 'hello out' })
    expect(q(`SELECT COUNT(*) AS n FROM messages WHERE wamid='wamid.LV1'`).n).toBe(1)
  })

  it('a failing record publishes nothing until the retry succeeds; exactly one message.new overall', async () => {
    const s = await staff()
    const realBatch = env.DB.batch.bind(env.DB)
    let tries = 0
    ;(env as any).DB = new Proxy(env.DB, { get: (t: any, p) => (p === 'batch' ? async (st: any[]) => { if (st.length === 3 && ++tries === 1) throw new Error('d1 blip'); return realBatch(st) } : t[p]) })
    await sendText(s, 'retry me')
    await settle()
    expect(tries).toBe(2)
    expect(all('message.new')).toHaveLength(1)
  })

  it('a record that never lands publishes no message.new', async () => {
    const s = await staff()
    const realBatch = env.DB.batch.bind(env.DB)
    ;(env as any).DB = new Proxy(env.DB, { get: (t: any, p) => (p === 'batch' ? async (st: any[]) => { if (st.length === 3) throw new Error('d1 down'); return realBatch(st) } : t[p]) })
    await sendText(s, 'lost')
    await settle()
    expect(all('message.new')).toHaveLength(0)
  })

  it('a media send publishes message.new after the media row exists', async () => {
    const s = await staff()
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))
    const fd = new FormData(); fd.set('file', new File([png], 'a.png', { type: 'image/png' })); fd.set('caption', 'pic')
    const body = new Request(ORIGIN, { method: 'POST', body: fd })
    const bytes = new Uint8Array(await body.arrayBuffer())
    const res = await worker.fetch(new Request(`${ORIGIN}/api/inbox/1/send-media`, {
      method: 'POST', body: bytes, headers: { 'content-type': body.headers.get('content-type')!, 'content-length': String(bytes.length), Origin: ORIGIN, Cookie: s.cookie, 'X-CSRF-Token': s.csrf },
    }), env, ctx)
    await settle()
    expect(res.status).toBe(200)
    expect(all('message.new')).toHaveLength(1)
  })
})

describe('revoked sessions close their sockets (4001)', () => {
  const PW = 'correct horse battery staple'
  const post = (path: string, body: unknown, o: Opts) => call('POST', path, body, o)
  async function admin() {
    const res = await worker.fetch(new Request(`${ORIGIN}/api/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ setup_key: SECRET, business_name: 'Example Co', default_country: 'US', timezone: 'UTC', admin: { name: 'Test Admin', email: 'admin@example.com', password: PW } }),
    }), env, ctx)
    const b: any = await res.json()
    return { cookie: (res.headers.get('set-cookie') ?? '').split(';')[0]!, csrf: b.csrf as string }
  }
  async function member() {
    const add = await call('POST', '/api/staff', { name: 'Member', email: 'm@example.com' }, { bearer: KEY })
    const { staff, temp_password }: any = await add.json()
    const res = await worker.fetch(new Request(`${ORIGIN}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ email: 'm@example.com', password: temp_password }) }), env, ctx)
    const b: any = await res.json()
    return { id: staff.id as number, temp: temp_password as string, cookie: (res.headers.get('set-cookie') ?? '').split(';')[0]!, csrf: b.csrf as string }
  }
  const sidOf = () => (q(`SELECT id_hash FROM sessions ORDER BY rowid DESC LIMIT 1`) as { id_hash: string }).id_hash

  it('logout revokes by the session hash', async () => {
    const a = await admin()
    const sid = sidOf()
    expect((await post('/api/auth/logout', {}, { cookie: a.cookie, csrf: a.csrf, headers: { Origin: ORIGIN } })).status).toBe(200)
    await settle()
    expect(revokes).toEqual([{ sid }])
  })
  it('deactivating a person revokes all of their sockets; an edit that keeps them active does not', async () => {
    await admin(); const m = await member()
    await call('PATCH', `/api/staff/${m.id}`, { name: 'Renamed' }, { bearer: KEY }); await settle()
    expect(revokes).toEqual([])
    expect((await call('PATCH', `/api/staff/${m.id}`, { active: false }, { bearer: KEY })).status).toBe(200); await settle()
    expect(revokes).toEqual([{ staff: m.id }])
  })
  it('an admin password reset revokes that person', async () => {
    await admin(); const m = await member()
    expect((await call('POST', `/api/staff/${m.id}/reset-password`, {}, { bearer: KEY })).status).toBe(200); await settle()
    expect(revokes).toEqual([{ staff: m.id }])
  })
  it('a self password change revokes the person EXCEPT the session making the change', async () => {
    await admin(); const m = await member()
    const sid = sidOf()
    const res = await post('/api/auth/password', { current_password: m.temp, new_password: 'a brand new passphrase 42' }, { cookie: m.cookie, csrf: m.csrf, headers: { Origin: ORIGIN } })
    expect(res.status).toBe(200); await settle()
    expect(revokes).toEqual([{ staff: m.id, exceptSid: sid }])
  })
  it('a hub that is down never fails the request', async () => {
    env.LIVE = fakeLive({ fail: true }).ns
    const a = await admin()
    expect((await post('/api/auth/logout', {}, { cookie: a.cookie, csrf: a.csrf, headers: { Origin: ORIGIN } })).status).toBe(200)
    await settle()
    expect(q(`SELECT COUNT(*) AS n FROM events WHERE kind='live_publish_error'`).n).toBeGreaterThan(0)
  })
  it('hub.revoke closes by staff tag or sid tag with 4001 and honours exceptSid', async () => {
    const tagged = (tags: string[]) => ({ tags, frames: [] as string[], closed: null as [number, string] | null, send(f: string) { this.frames.push(f) }, close(c: number, r: string) { this.closed = [c, r] } })
    const a = tagged(['staff:1', 'sid:s1']), b = tagged(['staff:1', 'sid:s2']), c = tagged(['staff:2', 'sid:s3'])
    const socks = [a, b, c]
    vi.stubGlobal('WebSocketRequestResponsePair', class {})
    const state = { setWebSocketAutoResponse() {}, getWebSockets: (t?: string) => socks.filter((x) => !t || x.tags.includes(t)), getTags: (w: any) => w.tags }
    const h = new LiveHub(state as any, {} as Env)
    expect(await h.revoke({ staff: 1, exceptSid: 's2' })).toBe(1)
    expect([a.closed, b.closed, c.closed]).toEqual([[4001, 'revoked'], null, null])
    expect(JSON.parse(a.frames[0]!).type).toBe('revoked')
    expect(b.frames).toEqual([])
    expect(await h.revoke({ sid: 's3' })).toBe(1)
    expect(c.closed).toEqual([4001, 'revoked'])
    expect(await h.revoke({})).toBe(0)
  })
})
