import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'
import { CloudApiAdaptor } from '../src/adaptors/cloud-api'
import { WhaBuzzAdaptor } from '../src/adaptors/whabuzz'
import { saveConfig } from '../src/adaptors'
import { WINDOW_SECONDS, previewOf, windowState } from '../src/conversations'
import { ensureSchema, type Env } from '../src/db'
import { processEvents } from '../src/inbound'
import { envelope, fixture } from './helpers'
import { fakeD1 } from './d1'

const SECRET = 'test-session-secret-0123456789'
const ORIGIN = 'https://leads.example.com'
const KEY = 'adminkey'

let env: Env
let raw: DatabaseSync
let waiting: Promise<unknown>[]
const ctx = { waitUntil: (p: Promise<unknown>) => { waiting.push(p) }, passThroughOnException: () => {} } as unknown as ExecutionContext
const settle = () => Promise.allSettled(waiting)

type Opts = { cookie?: string; csrf?: string; bearer?: string | null }
const call = (method: string, path: string, body?: unknown, o: Opts = { bearer: KEY }) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (o.cookie) headers.Cookie = o.cookie
  if (o.csrf) headers['X-CSRF-Token'] = o.csrf
  if (o.bearer) headers.Authorization = `Bearer ${o.bearer}`
  if (method !== 'GET') headers.Origin = ORIGIN
  return worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx)
}
const get = async (path: string, o?: Opts) => (await call('GET', path, undefined, o)).json() as Promise<any>
const q = <T = any>(sql: string, ...a: any[]) => raw.prepare(sql).get(...a) as T
const rows = <T = any>(sql: string, ...a: any[]) => raw.prepare(sql).all(...a) as T[]
const cloud = new CloudApiAdaptor({ system_token: 't', app_secret: 'appsecret', phone_number_id: '1', waba_id: '2' })
const wb = new WhaBuzzAdaptor({ api_key: 'k', phone_number_id: '1000000000000001', waba_id: '2', webhook_secret: 's' })
const WB = { kind: 'whabuzz' as const, config: { api_key: 'k', phone_number_id: '1000000000000001', waba_id: '2', webhook_secret: 'whsec_TEST_x' } }

/** A text webhook body with its own wamid / timestamp, from a given number. */
function textHook(wamid: string, ts: number, from = '15550000001', body = 'hello there') {
  const f = fixture('text')
  const v = f.entry[0].changes[0].value
  v.messages[0] = { ...v.messages[0], from, id: wamid, timestamp: String(ts), text: { body } }
  v.contacts[0] = { ...v.contacts[0], wa_id: from, profile: { name: 'Test Person' } }
  return f
}
const feed = (hook: any) => processEvents(env, ctx, cloud.parseWebhook(JSON.stringify(hook)))

async function sessionFor() {
  const res = await worker.fetch(new Request(`${ORIGIN}/api/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ setup_key: SECRET, business_name: 'Example Co', default_country: 'US', timezone: 'UTC', admin: { name: 'Test Admin', email: 'admin@example.com', password: 'correct horse battery' } }),
  }), env, ctx)
  const body: any = await res.json()
  return { cookie: (res.headers.get('set-cookie') ?? '').split(';')[0], csrf: body.csrf as string }
}

/** Direct seed: contact + conversation (no messages). */
function seed(id: number, o: { name?: string; at: number; unread?: number; status?: 'open' | 'closed'; assigned?: number | null; inbound?: number | null; preview?: string }) {
  raw.prepare(`INSERT INTO contacts (id,wa_id,phone,name) VALUES (?,?,?,?)`).run(id, `1555000${String(id).padStart(4, '0')}`, `1555000${String(id).padStart(4, '0')}`, o.name ?? `Person ${id}`)
  raw.prepare(`INSERT INTO conversations (contact_id,last_message_at,last_inbound_at,last_preview,unread_count,status,assigned_to) VALUES (?,?,?,?,?,?,?)`)
    .run(id, o.at, o.inbound === undefined ? o.at : o.inbound, o.preview ?? `msg ${id}`, o.unread ?? 0, o.status ?? 'open', o.assigned ?? null)
}

beforeEach(async () => {
  const f = fakeD1(); raw = f.raw
  waiting = []
  env = { DB: f.d1, ADMIN_KEY: KEY, SESSION_SECRET: SECRET, INSTANCE_NAME: 'inst', ALLOWED_ORIGINS: '', META_APP_SECRET: 'appsecret' } as unknown as Env
  await ensureSchema(f.d1)
})
afterEach(() => vi.restoreAllMocks())

describe('window maths', () => {
  const T = 1_000_000
  it('open strictly under 24h, closed at exactly 24h', () => {
    expect(windowState(T, T)).toEqual({ window_open: true, window_closes_at: T + WINDOW_SECONDS })
    expect(windowState(T, T + WINDOW_SECONDS - 1).window_open).toBe(true)
    expect(windowState(T, T + WINDOW_SECONDS).window_open).toBe(false)
    expect(windowState(T, T + WINDOW_SECONDS + 1).window_open).toBe(false)
  })
  it('no inbound message means closed with no close time', () => {
    expect(windowState(null, T)).toEqual({ window_open: false, window_closes_at: null })
  })
  it('previews: first 140 chars or [type]', () => {
    expect(previewOf('text', 'x'.repeat(300))).toHaveLength(140)
    expect(previewOf('image', null)).toBe('[image]')
    expect(previewOf('text', '   ')).toBe('[text]')
  })
})

describe('pipeline: conversation upsert', () => {
  it('first inbound creates an unread conversation with window fields and preview', async () => {
    await feed(textHook('wamid.A', 1_760_000_000))
    expect(q(`SELECT * FROM conversations`)).toMatchObject({
      contact_id: 1, last_message_at: 1_760_000_000, last_inbound_at: 1_760_000_000, last_preview: 'hello there', unread_count: 1, status: 'open', assigned_to: null,
    })
  })

  it('each new message increments unread once; media-only gets a [type] preview', async () => {
    await feed(textHook('wamid.A', 1_760_000_000))
    await feed(textHook('wamid.B', 1_760_000_100, '15550000001', 'second'))
    expect(q(`SELECT unread_count n, last_preview p, last_message_at t FROM conversations`)).toEqual({ n: 2, p: 'second', t: 1_760_000_100 })
    const img = fixture('image')
    await processEvents(env, ctx, cloud.parseWebhook(JSON.stringify(img)))
    expect(rows(`SELECT preview FROM (SELECT last_preview AS preview FROM conversations)`).length).toBe(2)
  })

  it('a duplicate webhook (replay, or the other route) does not double unread_count', async () => {
    const hook = textHook('wamid.A', 1_760_000_000)
    await feed(hook)
    await feed(hook) // Meta retry
    await processEvents(env, ctx, wb.parseWebhook(JSON.stringify(envelope('message.inbound', hook)))) // WhaBuzz route, same wamid
    expect(q(`SELECT COUNT(*) n FROM messages`).n).toBe(1)
    expect(q(`SELECT unread_count n FROM conversations`).n).toBe(1)
    expect(q(`SELECT COUNT(*) n FROM leads`).n).toBe(1)
    expect(q(`SELECT COUNT(*) n FROM conversations`).n).toBe(1)
  })

  it('a late older message never rewinds the preview or last_inbound_at', async () => {
    await feed(textHook('wamid.NEW', 1_760_000_500, '15550000001', 'newer'))
    await feed(textHook('wamid.OLD', 1_760_000_100, '15550000001', 'older'))
    expect(q(`SELECT last_preview p, last_message_at t, last_inbound_at i, unread_count n FROM conversations`)).toEqual({ p: 'newer', t: 1_760_000_500, i: 1_760_000_500, n: 2 })
  })

  it('an inbound message reopens a closed conversation and keeps its assignee', async () => {
    await feed(textHook('wamid.A', 1_760_000_000))
    raw.exec(`INSERT INTO staff (id,email,name,role,pw_hash) VALUES (7,'s@example.com','S','staff','x')`)
    raw.exec(`UPDATE conversations SET status='closed', assigned_to=7, unread_count=0`)
    await feed(textHook('wamid.B', 1_760_000_050))
    expect(q(`SELECT status s, assigned_to a, unread_count n FROM conversations`)).toEqual({ s: 'open', a: 7, n: 1 })
  })

  it('statuses leave the conversation alone', async () => {
    await feed(textHook('wamid.A', 1_760_000_000))
    const before = q(`SELECT * FROM conversations`)
    await processEvents(env, ctx, cloud.parseWebhook(JSON.stringify(fixture('status_delivered'))))
    expect(q(`SELECT * FROM conversations`)).toEqual(before)
  })

  it('outbound send updates last_message_at/preview, keeps unread and last_inbound_at, stamps first_response_at once', async () => {
    await feed(textHook('wamid.A', 1_760_000_000))
    await saveConfig(env, WB)
    const inAt = Math.floor(Date.now() / 1000) - 60 // /api/send now enforces the 24h window
    raw.exec(`UPDATE conversations SET last_inbound_at = ${inAt}, last_message_at = ${inAt}`)
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ messages: [{ id: 'wamid.OUT1' }] }), { status: 200 }))
    expect((await call('POST', '/api/send', { contact_id: 1, text: 'thanks, replying now' })).status).toBe(200)
    const c = q(`SELECT * FROM conversations`)
    expect(c).toMatchObject({ last_preview: 'thanks, replying now', unread_count: 1, last_inbound_at: inAt, status: 'open' })
    expect(c.last_message_at).toBeGreaterThanOrEqual(inAt)
    const fr = q(`SELECT first_response_at f FROM leads`).f
    expect(fr).toBeGreaterThan(0)
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ messages: [{ id: 'wamid.OUT2' }] }), { status: 200 }))
    await call('POST', '/api/send', { contact_id: 1, text: 'second' })
    expect(q(`SELECT first_response_at f FROM leads`).f).toBe(fr)
  })

  it('D19: send routes and webhook POSTs carry Server-Timing; the gateway split is passed through and logged', async () => {
    await feed(textHook('wamid.A', 1_760_000_000))
    await saveConfig(env, WB)
    const inAt = Math.floor(Date.now() / 1000) - 60
    raw.exec(`UPDATE conversations SET last_inbound_at = ${inAt}, last_message_at = ${inAt}`)
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ messages: [{ id: 'wamid.T1' }] }), {
      status: 200, headers: { 'Server-Timing': 'wb;dur=12.5, meta;dur=300, auth;dur=3, evil;dur=9, wb2;dur=4' },
    }))
    for (const path of ['/api/send', '/api/inbox/1/send']) {
      const res = await call('POST', path, { contact_id: 1, text: 'timed ' + path })
      expect(res.status).toBe(200)
      const st = res.headers.get('Server-Timing')!
      expect(st).toMatch(/^worker;dur=[0-9.]+, upstream;dur=[0-9.]+, wb;dur=12\.5, meta;dur=300, auth;dur=3$/)
      expect(st).not.toMatch(/evil|wb2/)
      expect(res.headers.get('Access-Control-Expose-Headers')).toMatch(/Server-Timing/)
    }
    await settle()
    const ev = rows<{ payload: string }>(`SELECT payload FROM events WHERE kind='send_timing' ORDER BY id`).map((r) => JSON.parse(r.payload))
    expect(ev).toHaveLength(2)
    expect(ev[0]).toMatchObject({ route: '/api/send', status: 200, timing: { wb: 12.5, meta: 300, auth: 3 } })
    expect(typeof ev[0].timing.worker).toBe('number')
    expect(typeof ev[0].timing.upstream).toBe('number')
    // a gateway without Server-Timing still yields the two own entries, and reads (GET) get none
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ messages: [{ id: 'wamid.T2' }] }), { status: 200 }))
    const plain = await call('POST', '/api/send', { contact_id: 1, text: 'plain' })
    expect(plain.headers.get('Server-Timing')).toMatch(/^worker;dur=[0-9.]+, upstream;dur=[0-9.]+$/)
    expect((await call('GET', '/api/inbox')).headers.get('Server-Timing')).toBeNull()
    // webhook POSTs (even rejected ones) carry the header with upstream 0
    const hook = await worker.fetch(new Request(`${ORIGIN}/webhooks/whabuzz`, { method: 'POST', body: '{}' }), env, ctx)
    expect(hook.headers.get('Server-Timing')).toMatch(/^worker;dur=[0-9.]+, upstream;dur=0$/)
  })

  it('sending to a number we never heard from is refused with 409 and creates nothing', async () => {
    await saveConfig(env, WB)
    const f = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', f)
    expect((await call('POST', '/api/send', { to: '+1 555 000 0009', text: 'hi' })).status).toBe(409)
    expect(f).not.toHaveBeenCalled()
    expect(q(`SELECT COUNT(*) n FROM conversations`).n).toBe(0)
  })
})

describe('auth on every inbox route', () => {
  const routes: [string, string, unknown?][] = [
    ['GET', '/api/inbox'], ['GET', '/api/inbox/unread'], ['GET', '/api/contacts/1/messages'],
    ['POST', '/api/conversations/1/read'], ['PATCH', '/api/conversations/1', { status: 'closed' }],
  ]
  beforeEach(() => seed(1, { at: 100, unread: 1 }))

  for (const [method, path, body] of routes) {
    it(`${method} ${path}: 401 without a session, 200 with ADMIN_KEY`, async () => {
      expect((await call(method, path, body, { bearer: null })).status).toBe(401)
      expect((await call(method, path, body, { bearer: 'wrong' })).status).toBe(401)
      expect((await call(method, path, body)).status).toBe(200)
    })
  }
  for (const [method, path, body] of routes.filter((r) => r[0] !== 'GET')) {
    it(`${method} ${path}: 403 with a session but no CSRF token, 200 with it`, async () => {
      const s = await sessionFor()
      const noCsrf = await call(method, path, body, { cookie: s.cookie, bearer: null })
      expect(noCsrf.status).toBe(403)
      expect(await noCsrf.json()).toMatchObject({ error: 'csrf' })
      expect((await call(method, path, body, { cookie: s.cookie, csrf: s.csrf, bearer: null })).status).toBe(200)
    })
  }
  it('GET routes work with a plain session (no CSRF needed for reads)', async () => {
    const s = await sessionFor()
    expect((await call('GET', '/api/inbox', undefined, { cookie: s.cookie, bearer: null })).status).toBe(200)
  })
  it('unknown contact: 404 on thread, read and patch', async () => {
    expect((await call('GET', '/api/contacts/99/messages')).status).toBe(404)
    expect((await call('POST', '/api/conversations/99/read')).status).toBe(404)
    expect((await call('PATCH', '/api/conversations/99', { status: 'closed' })).status).toBe(404)
  })
})

describe('GET /api/inbox', () => {
  it('empty database: ok with no rows', async () => {
    expect(await get('/api/inbox')).toMatchObject({ ok: true, inbox: [], next_before: null, unread_total: 0 })
  })

  it('unread first, then newest; rows carry the window and the legacy aliases', async () => {
    const now = Math.floor(Date.now() / 1000)
    seed(1, { at: now - 500, unread: 0, name: 'Old Read' })
    seed(2, { at: now - 400, unread: 3, name: 'Unread Older' })
    seed(3, { at: now - 100, unread: 0, name: 'New Read' })
    seed(4, { at: now - 300, unread: 1, name: 'Unread Newer', inbound: now - 90000 })
    const r = await get('/api/inbox')
    expect(r.inbox.map((x: any) => x.contact_id)).toEqual([4, 2, 3, 1])
    expect(r.unread_total).toBe(2)
    expect(r.inbox[0]).toMatchObject({ unread_count: 1, window_open: false, last_body: 'msg 4', last_at: now - 300, status: 'open' })
    expect(r.inbox[1]).toMatchObject({ unread_count: 3, window_open: true })
    expect(r.inbox[1].window_closes_at).toBe(now - 400 + WINDOW_SECONDS)
  })

  it('cursor pagination walks every row once, in order, across the unread boundary', async () => {
    for (let i = 1; i <= 7; i++) seed(i, { at: 1000 + (i % 3) * 10, unread: i % 2 })
    const all = (await get('/api/inbox?limit=100')).inbox.map((x: any) => x.contact_id)
    const seen: number[] = []
    let cursor: string | null = null
    for (let guard = 0; guard < 10; guard++) {
      const r: any = await get(`/api/inbox?limit=3${cursor ? `&before=${cursor}` : ''}`)
      seen.push(...r.inbox.map((x: any) => x.contact_id))
      cursor = r.next_before
      if (!cursor) break
    }
    expect(seen).toEqual(all)
    expect(new Set(seen).size).toBe(7)
  })

  it('filters: unread, open, closed, mine, and name/phone prefix search (wildcards are literal)', async () => {
    raw.exec(`INSERT INTO staff (id,email,name,role,pw_hash) VALUES (7,'s@example.com','Sam','staff','x')`)
    seed(1, { at: 100, unread: 2, name: 'Alice Test' })
    seed(2, { at: 200, status: 'closed', name: 'Bob Test' })
    seed(3, { at: 300, assigned: 7, name: '100% Real' })
    const ids = async (qs: string) => (await get(`/api/inbox?${qs}`)).inbox.map((x: any) => x.contact_id)
    expect(await ids('filter=unread')).toEqual([1])
    expect(await ids('filter=open')).toEqual([1, 3])
    expect(await ids('filter=closed')).toEqual([2])
    expect(await ids('filter=all')).toEqual([1, 3, 2])
    expect(await ids('filter=mine')).toEqual([]) // ADMIN_KEY has no staff id
    expect(await ids('q=ali')).toEqual([1])
    expect(await ids('q=%25')).toEqual([]) // "%" must not match everything
    expect(await ids('q=100%25')).toEqual([3])
    expect(await ids('q=15550000002')).toEqual([2])
    expect(await ids('q=%2B1555000')).toEqual([1, 3, 2]) // "+1555000" -> digits prefix
    expect((await get('/api/inbox')).inbox.find((x: any) => x.contact_id === 3).assigned_name).toBe('Sam')
  })

  it('"mine" is the signed-in staff member', async () => {
    const s = await sessionFor() // staff id 1
    seed(1, { at: 100, assigned: 1 }); seed(2, { at: 200 })
    const r = await get('/api/inbox?filter=mine', { cookie: s.cookie, bearer: null })
    expect(r.inbox.map((x: any) => x.contact_id)).toEqual([1])
  })

  it('rejects an unknown filter and a malformed cursor', async () => {
    expect((await call('GET', '/api/inbox?filter=bogus')).status).toBe(400)
    expect((await call('GET', '/api/inbox?before=garbage')).status).toBe(400)
  })
})

describe('GET /api/contacts/:id/messages', () => {
  it('returns messages oldest first with window status and conversation state', async () => {
    const now = Math.floor(Date.now() / 1000)
    seed(1, { at: now - 60, unread: 2, inbound: now - 60 })
    raw.exec(`INSERT INTO messages (id,contact_id,direction,wamid,type,body,timestamp) VALUES (1,1,'in','w1','text','a',${now - 120}),(2,1,'out','w2','text','b',${now - 90}),(3,1,'in','w3','text','c',${now - 60})`)
    const r = await get('/api/contacts/1/messages')
    expect(r.messages.map((m: any) => m.body)).toEqual(['a', 'b', 'c'])
    expect(r).toMatchObject({ ok: true, window_open: true, has_more: false, next_before: null, conversation: { unread_count: 2, status: 'open' } })
    expect(r.window_closes_at).toBe(now - 60 + WINDOW_SECONDS)
    expect(r.contact).toMatchObject({ id: 1 })
  })

  it('window closed after 24h; no conversation at all is closed too', async () => {
    const now = Math.floor(Date.now() / 1000)
    seed(1, { at: now - WINDOW_SECONDS - 5, inbound: now - WINDOW_SECONDS - 5 })
    expect(await get('/api/contacts/1/messages')).toMatchObject({ window_open: false })
    raw.exec(`INSERT INTO contacts (id,phone) VALUES (2,'15550000002')`)
    expect(await get('/api/contacts/2/messages')).toMatchObject({ window_open: false, window_closes_at: null, conversation: null, messages: [] })
  })

  it('pages of the newest N with a message-id cursor, no gaps or repeats', async () => {
    seed(1, { at: 500 })
    for (let i = 1; i <= 7; i++) raw.exec(`INSERT INTO messages (contact_id,direction,wamid,type,body,timestamp) VALUES (1,'in','w${i}','text','m${i}',${100 + i})`)
    const a = await get('/api/contacts/1/messages?limit=3')
    expect(a.messages.map((m: any) => m.body)).toEqual(['m5', 'm6', 'm7'])
    expect(a.has_more).toBe(true)
    const b = await get(`/api/contacts/1/messages?limit=3&before=${a.next_before}`)
    expect(b.messages.map((m: any) => m.body)).toEqual(['m2', 'm3', 'm4'])
    const c = await get(`/api/contacts/1/messages?limit=3&before=${b.next_before}`)
    expect(c.messages.map((m: any) => m.body)).toEqual(['m1'])
    expect(c.has_more).toBe(false)
    expect((await call('GET', '/api/contacts/1/messages?before=abc')).status).toBe(400)
  })

  it('?after= returns only newer messages, oldest first, with fresh conversation + window state', async () => {
    const now = Math.floor(Date.now() / 1000)
    seed(1, { at: now, inbound: now })
    raw.exec(`INSERT INTO contacts (id,phone) VALUES (2,'15550000002')`)
    for (let i = 1; i <= 4; i++) raw.exec(`INSERT INTO messages (contact_id,direction,wamid,type,body,timestamp) VALUES (1,'in','a${i}','text','m${i}',${now})`)
    raw.exec(`INSERT INTO messages (contact_id,direction,wamid,type,body,timestamp) VALUES (2,'in','other','text','other contact',${now})`)
    const ids = rows<{ id: number; body: string }>(`SELECT id, body FROM messages WHERE contact_id=1 ORDER BY id`)
    const a = await get(`/api/contacts/1/messages?after=${ids[1]!.id}`)
    expect(a.messages.map((m: any) => m.body)).toEqual(['m3', 'm4'])
    expect(a).toMatchObject({ ok: true, has_more: false, next_before: null, window_open: true })
    expect(a.conversation).toMatchObject({ contact_id: 1 })
    // nothing newer: empty list, but state is still returned
    const none = await get(`/api/contacts/1/messages?after=${ids[3]!.id}`)
    expect(none.messages).toEqual([])
    expect(none.conversation).toMatchObject({ contact_id: 1 })
    expect(none.window_closes_at).toBe(now + WINDOW_SECONDS)
    // after=0 is the whole thread; limit applies oldest first
    expect((await get('/api/contacts/1/messages?after=0&limit=2')).messages.map((m: any) => m.body)).toEqual(['m1', 'm2'])
    // outbound statuses ride along for the ticks (recent outbound only)
    raw.exec(`INSERT INTO messages (contact_id,direction,wamid,type,body,status,timestamp) VALUES (1,'out','o1','text','reply','delivered',${now}), (1,'out','old','text','old','read',${now - 2 * 86400})`)
    const st = await get(`/api/contacts/1/messages?after=${ids[3]!.id + 100}`)
    expect(st.statuses).toEqual([{ id: expect.any(Number), status: 'delivered' }])
    expect((await get('/api/contacts/1/messages')).statuses).toBeUndefined()
    // bad input, both cursors, unknown contact
    expect((await call('GET', '/api/contacts/1/messages?after=abc')).status).toBe(400)
    expect((await call('GET', '/api/contacts/1/messages?after=-1')).status).toBe(400)
    expect((await call('GET', '/api/contacts/1/messages?after=1&before=5')).status).toBe(400)
    expect((await call('GET', '/api/contacts/99/messages?after=1')).status).toBe(404)
  })

  it('?after= sits behind the same auth gate', async () => {
    seed(1, { at: 500 })
    expect((await call('GET', '/api/contacts/1/messages?after=0', undefined, { bearer: null })).status).toBe(401)
    expect((await call('GET', '/api/contacts/1/messages?after=0', undefined, { bearer: 'wrong' })).status).toBe(401)
  })

  it('attaches media rows when they exist', async () => {
    seed(1, { at: 500 })
    raw.exec(`INSERT INTO messages (id,contact_id,direction,wamid,type,body,media_id,timestamp) VALUES (1,1,'in','w1','image',NULL,'media-a',100),(2,1,'in','w2','text','plain',NULL,101)`)
    raw.exec(`INSERT INTO media (message_id,media_id,mime,filename,size,status) VALUES (1,'media-a','image/jpeg','a.jpg',1234,'stored')`)
    const r = await get('/api/contacts/1/messages')
    expect(r.messages[0].media).toEqual({ status: 'stored', mime: 'image/jpeg', filename: 'a.jpg', size: 1234 })
    expect(r.messages[1].media).toBeNull()
  })
})

describe('POST /api/conversations/:id/read', () => {
  it('resets unread_count and marks the last inbound wamid read through the adaptor', async () => {
    await feed(textHook('wamid.A', 1_760_000_000))
    await feed(textHook('wamid.B', 1_760_000_100))
    await saveConfig(env, WB)
    const seen: any[] = []
    vi.stubGlobal('fetch', async (url: string, init: any) => { seen.push({ url, body: JSON.parse(init.body) }); return new Response('{}', { status: 200 }) })
    const res = await call('POST', '/api/conversations/1/read')
    expect(await res.json()).toEqual({ ok: true, unread_count: 0, marked: true })
    await settle()
    expect(q(`SELECT unread_count n FROM conversations`).n).toBe(0)
    expect((await get('/api/inbox/unread')).unread).toBe(0)
    expect(seen).toHaveLength(1)
    expect(seen[0].url).toMatch(/\/messages\/read$/)
    expect(seen[0].body).toMatchObject({ message_id: 'wamid.B' })
  })

  it('tolerates an adaptor that rejects, throws, or is not configured', async () => {
    await feed(textHook('wamid.A', 1_760_000_000))
    await saveConfig(env, WB)
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ source: 'meta', error: { message: 'nope' } }), { status: 400 }))
    expect((await call('POST', '/api/conversations/1/read')).status).toBe(200)
    await settle()
    expect(q(`SELECT unread_count n FROM conversations`).n).toBe(0)
    expect(q(`SELECT COUNT(*) n FROM events WHERE kind='mark_read_failed'`).n).toBe(1)

    raw.exec(`UPDATE conversations SET unread_count=3`)
    vi.stubGlobal('fetch', async () => { throw new Error('network down') })
    expect((await call('POST', '/api/conversations/1/read')).status).toBe(200)
    await settle()
    expect(q(`SELECT unread_count n FROM conversations`).n).toBe(0)

    raw.exec(`UPDATE conversations SET unread_count=2; DELETE FROM adaptor_config`)
    expect((await call('POST', '/api/conversations/1/read')).status).toBe(200)
    expect(q(`SELECT unread_count n FROM conversations`).n).toBe(0)
  })

  it('an already-read conversation makes no adaptor call', async () => {
    seed(1, { at: 100, unread: 0 })
    raw.exec(`INSERT INTO messages (contact_id,direction,wamid,type,body,timestamp) VALUES (1,'in','w1','text','a',100)`)
    await saveConfig(env, WB)
    const f = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', f)
    expect(await (await call('POST', '/api/conversations/1/read')).json()).toMatchObject({ ok: true, marked: false })
    await settle()
    expect(f).not.toHaveBeenCalled()
  })
})

describe('PATCH /api/conversations/:id', () => {
  beforeEach(() => {
    raw.exec(`INSERT INTO staff (id,email,name,role,pw_hash,active) VALUES (7,'s@example.com','Sam','staff','x',1),(8,'gone@example.com','Gone','staff','x',0)`)
    seed(1, { at: 100, unread: 1 })
  })

  it('assign, unassign, close and reopen, each recorded in activity', async () => {
    expect(await (await call('PATCH', '/api/conversations/1', { assigned_to: 7 })).json()).toMatchObject({ ok: true, conversation: { assigned_to: 7, assigned_name: 'Sam', status: 'open' } })
    expect(await (await call('PATCH', '/api/conversations/1', { status: 'closed' })).json()).toMatchObject({ conversation: { status: 'closed', assigned_to: 7 } })
    expect(await (await call('PATCH', '/api/conversations/1', { status: 'open', assigned_to: null })).json()).toMatchObject({ conversation: { status: 'open', assigned_to: null } })
    expect(q(`SELECT unread_count n FROM conversations`).n).toBe(1) // untouched
    expect(rows(`SELECT kind, actor FROM activity ORDER BY id`)).toEqual([
      { kind: 'conversation_assigned', actor: 'api' }, { kind: 'conversation_closed', actor: 'api' },
      { kind: 'conversation_reopened', actor: 'api' }, { kind: 'conversation_unassigned', actor: 'api' },
    ])
  })

  it('records the staff member as the actor; a no-op change records nothing', async () => {
    raw.exec(`DELETE FROM staff`) // setup only runs on an empty staff table
    const s = await sessionFor()
    await call('PATCH', '/api/conversations/1', { status: 'open' }, { cookie: s.cookie, csrf: s.csrf, bearer: null })
    expect(q(`SELECT COUNT(*) n FROM activity`).n).toBe(0)
    await call("PATCH", "/api/conversations/1", { status: "closed" }, { cookie: s.cookie, csrf: s.csrf, bearer: null })
    expect(q(`SELECT actor a FROM activity`).a).toBe(`staff:${q('SELECT id FROM staff').id}`)
  })

  it('validates input', async () => {
    for (const body of [{ status: 'archived' }, { assigned_to: 999 }, { assigned_to: 8 }, { assigned_to: 'x' }, {}]) {
      expect((await call('PATCH', '/api/conversations/1', body)).status).toBe(400)
    }
    const bad = await fetchRaw('PATCH', '/api/conversations/1', '{not json')
    expect(bad.status).toBe(400)
    expect(q(`SELECT status s, assigned_to a FROM conversations`)).toEqual({ s: 'open', a: null })
  })
})

const fetchRaw = (method: string, path: string, body: string) =>
  worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers: { Authorization: `Bearer ${KEY}`, Origin: ORIGIN, 'content-type': 'application/json' }, body }), env, ctx)
