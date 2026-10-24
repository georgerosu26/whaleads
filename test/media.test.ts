import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'
import { CloudApiAdaptor } from '../src/adaptors/cloud-api'
import { WhaBuzzAdaptor } from '../src/adaptors/whabuzz'
import type { MediaFetch, MetaAdaptor } from '../src/adaptors/types'
import { saveConfig } from '../src/adaptors'
import { ensureSchema, type Env } from '../src/db'
import { processEvents } from '../src/inbound'
import { MAX_ATTEMPTS, MAX_INBOUND_BYTES, parseRange, retryPending, safeFilename, scheduled, sendMediaFile, serveMedia, storeMedia } from '../src/media'
import { fillQuickReply } from '../ui/src/lib/quickReplies'
import { fixture } from './helpers'
import { fakeD1 } from './d1'
import { fakeR2 } from './r2'

const SECRET = 'test-session-secret-0123456789'
const ORIGIN = 'https://leads.example.com'
const KEY = 'adminkey'
const WB = { kind: 'whabuzz' as const, config: { api_key: 'k', phone_number_id: '1000000000000001', waba_id: '2', webhook_secret: 'whsec_TEST_x' } }

let env: Env
let raw: DatabaseSync
let r2: ReturnType<typeof fakeR2>
let waiting: Promise<unknown>[]
const ctx = { waitUntil: (p: Promise<unknown>) => { waiting.push(p) }, passThroughOnException: () => {} } as unknown as ExecutionContext
const settle = () => Promise.allSettled(waiting)
const q = <T = any>(sql: string, ...a: any[]) => raw.prepare(sql).get(...a) as T
const rows = <T = any>(sql: string, ...a: any[]) => raw.prepare(sql).all(...a) as T[]
const cloud = new CloudApiAdaptor({ system_token: 't', app_secret: 'appsecret', phone_number_id: '1', waba_id: '2' })

type Opts = { cookie?: string; csrf?: string; bearer?: string | null }
function req(method: string, path: string, body?: unknown, o: Opts = { bearer: KEY }) {
  const headers: Record<string, string> = {}
  if (o.cookie) headers.Cookie = o.cookie
  if (o.csrf) headers['X-CSRF-Token'] = o.csrf
  if (o.bearer) headers.Authorization = `Bearer ${o.bearer}`
  if (method !== 'GET') headers.Origin = ORIGIN
  let init: BodyInit | undefined
  if (body && typeof body === 'object' && 'multipart' in (body as any)) {
    const m = (body as any).multipart as { buf: ArrayBuffer; ct: string }
    headers['content-type'] = m.ct; headers['content-length'] = String(m.buf.byteLength); init = m.buf
  } else if (body !== undefined) { headers['content-type'] = 'application/json'; init = JSON.stringify(body) }
  return new Request(`${ORIGIN}${path}`, { method, headers, body: init })
}
// Workers always carry a Content-Length on a buffered upload; serialise the form so the test request does too.
async function call(method: string, path: string, body?: unknown, o?: Opts) {
  if (body instanceof FormData) {
    const r = new Response(body)
    body = { multipart: { buf: await r.arrayBuffer(), ct: r.headers.get('content-type')! } }
  }
  return worker.fetch(req(method, path, body, o), env, ctx)
}

async function sessionFor() {
  const res = await worker.fetch(new Request(`${ORIGIN}/api/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ setup_key: SECRET, business_name: 'Example Co', default_country: 'US', timezone: 'UTC', admin: { name: 'Test Admin', email: 'admin@example.com', password: 'correct horse battery' } }),
  }), env, ctx)
  const body: any = await res.json()
  return { cookie: (res.headers.get('set-cookie') ?? '').split(';')[0]!, csrf: body.csrf as string }
}

const now = () => Math.floor(Date.now() / 1000)
function seedContact(id = 1, o: { inbound?: number | null } = {}) {
  raw.prepare(`INSERT OR IGNORE INTO contacts (id,wa_id,phone,name) VALUES (?,?,?,?)`).run(id, `1555000${String(id).padStart(4, '0')}`, `1555000${String(id).padStart(4, '0')}`, `Person ${id}`)
  const inbound = o.inbound === undefined ? now() - 60 : o.inbound
  raw.prepare(`INSERT OR IGNORE INTO conversations (contact_id,last_message_at,last_inbound_at,last_preview,unread_count) VALUES (?,?,?,?,0)`).run(id, inbound ?? 0, inbound, 'hi')
}

/** A message + media row, as the pipeline leaves them. */
function seedMedia(o: { status?: string; attempts?: number; mime?: string | null; mediaId?: string | null; size?: number | null; key?: string | null; filename?: string | null } = {}) {
  seedContact(1)
  const r = raw.prepare(`INSERT INTO messages (contact_id,direction,wamid,type,media_id,status,timestamp) VALUES (1,'in',?,?,?,'received',?)`)
    .run(`wamid.${Math.random()}`, 'image', o.mediaId ?? 'meta-1', now())
  const id = Number(r.lastInsertRowid)
  raw.prepare(`INSERT INTO media (message_id,media_id,r2_key,mime,filename,size,status,attempts) VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, o.mediaId === undefined ? 'meta-1' : o.mediaId, o.key ?? null, o.mime ?? null, o.filename ?? null, o.size ?? null, o.status ?? 'pending', o.attempts ?? 0)
  return id
}

const stream = (chunks: Uint8Array[]) => new ReadableStream<Uint8Array>({ start(c) { chunks.forEach((x) => c.enqueue(x)); c.close() } })
const fakeAdaptor = (fetchMedia: (id: string) => Promise<MediaFetch>) => ({ fetchMedia } as unknown as MetaAdaptor)
const okFetch = (bytes: Uint8Array, mime = 'image/jpeg') => fakeAdaptor(async () => ({ ok: true, bytes: stream([bytes]), mime }))
const failFetch = (msg = 'boom') => fakeAdaptor(async () => ({ ok: false, status: 400, error: { source: 'network', error: msg, message: msg } }))
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])

beforeEach(async () => {
  const f = fakeD1(); raw = f.raw
  r2 = fakeR2()
  waiting = []
  env = { DB: f.d1, MEDIA: r2.bucket, ADMIN_KEY: KEY, SESSION_SECRET: SECRET, INSTANCE_NAME: 'inst', ALLOWED_ORIGINS: '', META_APP_SECRET: 'appsecret' } as unknown as Env
  await ensureSchema(f.d1)
})
afterEach(() => vi.restoreAllMocks())

describe('inbound: media row in the same batch', () => {
  it('creates a pending row with mime and filename from the Meta object, once per wamid', async () => {
    env.MEDIA = undefined // keep the row pending; storing is covered below
    const img = fixture('image')
    const events = cloud.parseWebhook(JSON.stringify(img))
    await processEvents(env, ctx, events)
    await processEvents(env, ctx, events) // replay
    const m = q(`SELECT d.*, m.type FROM media d JOIN messages m ON m.id=d.message_id`)
    expect(m).toMatchObject({ media_id: '1000000000000003', mime: 'image/jpeg', status: 'pending', attempts: 0, type: 'image', filename: null })
    expect(q(`SELECT COUNT(*) n FROM media`).n).toBe(1)
    expect(q(`SELECT COUNT(*) n FROM messages`).n).toBe(1)
    await settle()
  })
  it('text messages get no media row', async () => {
    await processEvents(env, ctx, cloud.parseWebhook(JSON.stringify(fixture('text'))))
    expect(q(`SELECT COUNT(*) n FROM media`).n).toBe(0)
  })
})

describe('storeMedia', () => {
  it('copies to R2 and marks stored with size and mime', async () => {
    const id = seedMedia()
    expect(await storeMedia(env, id, okFetch(PNG, 'image/png; charset=x'))).toBe('stored')
    expect(q(`SELECT * FROM media WHERE message_id=?`, id)).toMatchObject({ status: 'stored', r2_key: `m/${id}`, size: PNG.byteLength, mime: 'image/png' })
    expect(q(`SELECT stored_at FROM media WHERE message_id=?`, id).stored_at).toBeGreaterThan(0)
    expect([...r2.store.get(`m/${id}`)!.bytes]).toEqual([...PNG])
    expect(r2.store.get(`m/${id}`)!.contentType).toBe('image/png')
  })
  it('over 25 MB is too_large and nothing is written', async () => {
    const id = seedMedia()
    const MB = new Uint8Array(1024 * 1024)
    const chunks = Array.from({ length: 26 }, () => MB)
    expect(MAX_INBOUND_BYTES).toBe(25 * 1024 * 1024)
    expect(await storeMedia(env, id, fakeAdaptor(async () => ({ ok: true, bytes: stream(chunks), mime: 'video/mp4' })))).toBe('too_large')
    expect(q(`SELECT status FROM media`).status).toBe('too_large')
    expect(r2.store.size).toBe(0)
  })
  it('exactly 25 MB is stored', async () => {
    const id = seedMedia()
    const MB = new Uint8Array(1024 * 1024)
    expect(await storeMedia(env, id, fakeAdaptor(async () => ({ ok: true, bytes: stream(Array.from({ length: 25 }, () => MB)), mime: 'video/mp4' })))).toBe('stored')
  })
  it('a failure keeps it pending with attempts+1 and the error; the fifth failure marks it failed', async () => {
    const id = seedMedia()
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      expect(await storeMedia(env, id, failFetch(`err ${i}`))).toBe('retry')
      expect(q(`SELECT status,attempts,last_error FROM media`)).toEqual({ status: 'pending', attempts: i, last_error: `err ${i}` })
    }
    expect(await storeMedia(env, id, failFetch('last'))).toBe('failed')
    expect(q(`SELECT status,attempts FROM media`)).toEqual({ status: 'failed', attempts: MAX_ATTEMPTS })
    expect(await storeMedia(env, id, okFetch(PNG))).toBe('noop') // terminal: never touched again
    expect(r2.store.size).toBe(0)
  })
  it('an adaptor that throws counts as a failure', async () => {
    const id = seedMedia()
    expect(await storeMedia(env, id, fakeAdaptor(async () => { throw new Error('socket') }))).toBe('retry')
    expect(q(`SELECT attempts,last_error e FROM media`)).toMatchObject({ attempts: 1 })
  })
  it('does nothing without the R2 binding', async () => {
    const id = seedMedia()
    env.MEDIA = undefined
    expect(await storeMedia(env, id, okFetch(PNG))).toBe('skipped')
    expect(q(`SELECT status,attempts FROM media`)).toEqual({ status: 'pending', attempts: 0 })
  })
  it('is idempotent: a second run after success is a no-op', async () => {
    const id = seedMedia()
    await storeMedia(env, id, okFetch(PNG))
    const fetchMedia = vi.fn()
    expect(await storeMedia(env, id, fakeAdaptor(fetchMedia as any))).toBe('noop')
    expect(fetchMedia).not.toHaveBeenCalled()
  })
  it('the webhook pipeline stores after the batch when R2 is bound', async () => {
    await saveConfig(env, WB)
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(PNG, { headers: { 'content-type': 'image/png' } }))
    await processEvents(env, ctx, cloud.parseWebhook(JSON.stringify(fixture('image'))))
    await settle()
    expect(q(`SELECT status,mime FROM media`)).toEqual({ status: 'stored', mime: 'image/png' })
  })
})

describe('cron', () => {
  it('retries oldest pending first, at most 10 per run, skips rows at 5 attempts', async () => {
    seedContact(1)
    for (let i = 0; i < 12; i++) {
      const m = raw.prepare(`INSERT INTO messages (contact_id,direction,wamid,type,media_id,timestamp) VALUES (1,'in',?, 'image', ?, ?)`).run(`w${i}`, `x${i}`, now())
      raw.prepare(`INSERT INTO media (message_id,media_id,status,attempts) VALUES (?,?, 'pending', ?)`).run(Number(m.lastInsertRowid), `x${i}`, i === 0 ? 5 : 0)
    }
    const seen: string[] = []
    const t = await retryPending(env, fakeAdaptor(async (id) => { seen.push(id); return { ok: true, bytes: stream([PNG]), mime: 'image/png' } }))
    expect(t.stored).toBe(10)
    expect(seen).not.toContain('x0')
    expect(seen[0]).toBe('x1')
    expect(q(`SELECT COUNT(*) n FROM media WHERE status='pending'`).n).toBe(2)
  })
  it('scheduled() purges expired sessions and stale rate limits and leaves live ones', async () => {
    raw.exec(`INSERT INTO staff (id,email,name,role,pw_hash) VALUES (1,'a@example.com','A','admin','x')`)
    const t = now()
    raw.prepare(`INSERT INTO sessions (id_hash,staff_id,expires_at,last_seen_at) VALUES ('old',1,?,?),('live',1,?,?)`).run(t - 10, t - 100, t + 1000, t)
    raw.prepare(`INSERT INTO rate_limits (key,count,window_start) VALUES ('stale',3,?),('fresh',1,?)`).run(t - 90_000, t)
    await scheduled(env)
    expect(rows(`SELECT id_hash h FROM sessions`).map((r) => r.h)).toEqual(['live'])
    expect(rows(`SELECT key k FROM rate_limits`).map((r) => r.k)).toEqual(['fresh'])
  })
  it('the worker exports a scheduled handler', async () => {
    await (worker as any).scheduled({}, env, ctx)
    await settle()
  })
})

describe('GET /api/media/:id', () => {
  it('requires a session or the admin key', async () => {
    const id = seedMedia({ status: 'stored', key: 'm/1', mime: 'image/png', size: 3 })
    const r = await call('GET', `/api/media/${id}`, undefined, { bearer: null })
    expect(r.status).toBe(401)
    expect((await call('GET', `/api/media/${id}`, undefined, { bearer: 'wrong' })).status).toBe(401)
  })
  it('stored image: inline, sandbox, nosniff, private cache, streamed from R2', async () => {
    const id = seedMedia({ status: 'stored', key: 'm/1', mime: 'image/png', size: PNG.byteLength })
    await r2.bucket.put('m/1', PNG)
    const r = await call('GET', `/api/media/${id}`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('image/png')
    expect(r.headers.get('content-disposition')).toBe('inline')
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
    expect(r.headers.get('content-security-policy')).toBe('sandbox')
    expect(r.headers.get('cache-control')).toBe('private, no-store')
    expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([...PNG])
  })
  it.each(['text/html', 'image/svg+xml', 'application/pdf', 'application/x-msdownload', 'text/javascript'])('%s is an octet-stream attachment', async (mime) => {
    const id = seedMedia({ status: 'stored', key: 'm/1', mime, size: 3, filename: 'evil "name".html' })
    await r2.bucket.put('m/1', new Uint8Array([1, 2, 3]))
    const r = await call('GET', `/api/media/${id}`)
    expect(r.headers.get('content-type')).toBe('application/octet-stream')
    expect(r.headers.get('content-disposition')).toMatch(/^attachment; filename="evil -name-\.html"/)
    expect(r.headers.get('content-security-policy')).toBe('sandbox')
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
  })
  it('honours a byte range (Safari audio/video)', async () => {
    const id = seedMedia({ status: 'stored', key: 'm/1', mime: 'audio/ogg', size: 10 })
    await r2.bucket.put('m/1', new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]))
    const r = await worker.fetch(new Request(`${ORIGIN}/api/media/${id}`, { headers: { Authorization: `Bearer ${KEY}`, Range: 'bytes=2-4' } }), env, ctx)
    expect(r.status).toBe(206)
    expect(r.headers.get('content-range')).toBe('bytes 2-4/10')
    expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([2, 3, 4])
    expect(parseRange('bytes=20-', 10)).toBe('bad')
    expect(parseRange('bytes=-3', 10)).toEqual({ offset: 7, length: 3 })
    expect(parseRange('nonsense', 10)).toBeNull()
  })
  it('too_large and failed are 410 with a reason; unknown is 404', async () => {
    const a = seedMedia({ status: 'too_large' })
    const bRow = raw.prepare(`INSERT INTO messages (contact_id,direction,wamid,type) VALUES (1,'in','w2','image')`).run()
    raw.prepare(`INSERT INTO media (message_id,media_id,status) VALUES (?, 'm2', 'failed')`).run(Number(bRow.lastInsertRowid))
    const ra = await call('GET', `/api/media/${a}`)
    expect(ra.status).toBe(410)
    expect((await ra.json() as any).error).toBe('too_large')
    expect((await call('GET', `/api/media/${bRow.lastInsertRowid}`)).status).toBe(410)
    expect((await call('GET', `/api/media/999`)).status).toBe(404)
  })
  it('pending is proxied live from Meta with the same safe headers, and a store is kicked off', async () => {
    const id = seedMedia({ status: 'pending' })
    const r = await serveMedia(req('GET', `/api/media/${id}`), env, ctx, id, okFetch(PNG, 'text/html'))
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('application/octet-stream')
    expect(r.headers.get('content-disposition')).toMatch(/^attachment/)
    await settle()
  })
  it('without R2, pending is proxied and never stored', async () => {
    const id = seedMedia({ status: 'pending' })
    env.MEDIA = undefined
    const r = await serveMedia(req('GET', `/api/media/${id}`), env, ctx, id, okFetch(PNG, 'image/png'))
    expect(r.headers.get('content-type')).toBe('image/png')
    await settle()
    expect(q(`SELECT status FROM media`).status).toBe('pending')
  })
  it('a Meta failure while proxying is a 502', async () => {
    const id = seedMedia({ status: 'pending' })
    expect((await serveMedia(req('GET', `/x`), env, ctx, id, failFetch())).status).toBe(502)
  })
  it('the thread API exposes media status for the bubble', async () => {
    const id = seedMedia({ status: 'stored', key: 'm/1', mime: 'image/png', size: 9, filename: 'a.png' })
    const t: any = await (await call('GET', `/api/contacts/1/messages`)).json()
    expect(t.messages.find((m: any) => m.id === id).media).toEqual({ status: 'stored', mime: 'image/png', filename: 'a.png', size: 9 })
  })
})

describe('POST /api/inbox/:id/send', () => {
  let s: { cookie: string; csrf: string }
  beforeEach(async () => { s = await sessionFor(); await saveConfig(env, WB) })
  const sent = () => vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ messages: [{ id: 'wamid.OUT1' }] }), { status: 200 }))

  it('no session is 401; a session without the CSRF token is 403', async () => {
    seedContact(1)
    expect((await call('POST', '/api/inbox/1/send', { text: 'hi' }, { bearer: null })).status).toBe(401)
    expect((await call('POST', '/api/inbox/1/send', { text: 'hi' }, { cookie: s.cookie })).status).toBe(403)
    expect((await call('POST', '/api/inbox/1/media', {}, { cookie: s.cookie, csrf: s.csrf })).status).toBe(404)
    const fd = new FormData(); fd.set('file', new File([PNG], 'a.png', { type: 'image/png' }))
    expect((await call('POST', '/api/inbox/1/send-media', fd, { cookie: s.cookie })).status).toBe(403)
  })
  it('409 window_closed outside 24h (and for a contact who never wrote), nothing is sent', async () => {
    seedContact(1, { inbound: now() - 86_400 - 5 })
    seedContact(2, { inbound: null })
    const f = sent()
    for (const id of [1, 2]) {
      const r = await call('POST', `/api/inbox/${id}/send`, { text: 'hi' }, { cookie: s.cookie, csrf: s.csrf })
      expect(r.status).toBe(409)
      expect((await r.json() as any).error).toBe('window_closed')
    }
    expect(f).not.toHaveBeenCalled()
    expect(q(`SELECT COUNT(*) n FROM messages`).n).toBe(0)
  })
  it('sends text, stores the message, updates the conversation and stamps first_response_at', async () => {
    seedContact(1)
    raw.exec(`INSERT INTO leads (contact_id,source) VALUES (1,'whatsapp')`)
    const f = sent()
    const r = await call('POST', '/api/inbox/1/send', { text: '  Hello there  ' }, { cookie: s.cookie, csrf: s.csrf })
    expect(r.status).toBe(200)
    const b: any = await r.json()
    expect(b).toMatchObject({ ok: true, wamid: 'wamid.OUT1', message: { direction: 'out', body: 'Hello there', type: 'text' } })
    const sentBody = JSON.parse((f.mock.calls[0]![1] as RequestInit).body as string)
    expect(sentBody).toMatchObject({ to: '15550000001', type: 'text', text: { body: 'Hello there' } })
    expect(q(`SELECT direction,status,body FROM messages WHERE wamid='wamid.OUT1'`)).toEqual({ direction: 'out', status: 'sent', body: 'Hello there' })
    expect(q(`SELECT last_preview p FROM conversations`).p).toBe('Hello there')
    expect(q(`SELECT first_response_at f FROM leads`).f).toBeGreaterThan(0)
  })
  it('validates text', async () => {
    seedContact(1)
    expect((await call('POST', '/api/inbox/1/send', { text: '   ' }, { cookie: s.cookie, csrf: s.csrf })).status).toBe(400)
    expect((await call('POST', '/api/inbox/1/send', { text: 'x'.repeat(4097) }, { cookie: s.cookie, csrf: s.csrf })).status).toBe(400)
    expect((await call('POST', '/api/inbox/99/send', { text: 'hi' }, { cookie: s.cookie, csrf: s.csrf })).status).toBe(404)
  })
  it("passes the upstream error through and stores nothing", async () => {
    seedContact(1)
    const err = { code: 131047, message: 'Re-engagement message', error_data: { details: 'x' } }
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ source: 'meta', error: err }), { status: 400 }))
    const r = await call('POST', '/api/inbox/1/send', { text: 'hi' }, { cookie: s.cookie, csrf: s.csrf })
    expect(r.status).toBe(502)
    expect(await r.json()).toMatchObject({ ok: false, source: 'meta', graph: err })
    expect(q(`SELECT COUNT(*) n FROM messages`).n).toBe(0)
  })
})

describe('POST /api/inbox/:id/send-media', () => {
  let s: { cookie: string; csrf: string }
  beforeEach(async () => { s = await sessionFor(); await saveConfig(env, WB); seedContact(1) })
  const post = (file: File | null, caption?: string, id = 1) => {
    const fd = new FormData()
    if (file) fd.set('file', file)
    if (caption !== undefined) fd.set('caption', caption)
    return call('POST', `/api/inbox/${id}/send-media`, fd, { cookie: s.cookie, csrf: s.csrf })
  }
  const upstream = () => vi.spyOn(globalThis, 'fetch').mockImplementation(async (u) =>
    String(u).endsWith('/media') ? new Response(JSON.stringify({ id: 'meta-up-1' })) : new Response(JSON.stringify({ messages: [{ id: 'wamid.OUTM' }] })))

  it('uploads then sends, stores the message, the media row and the R2 object', async () => {
    const f = upstream()
    const r = await post(new File([PNG], 'photo one.png', { type: 'image/png' }), ' look at this ')
    expect(r.status).toBe(200)
    await settle() // the row + R2 copy are written after the reply
    const urls = f.mock.calls.map((c) => String(c[0]))
    expect(urls).toEqual(['https://api.whabuzz.com/v1/media', 'https://api.whabuzz.com/v1/messages'])
    expect(JSON.parse((f.mock.calls[1]![1] as RequestInit).body as string)).toMatchObject({ type: 'image', image: { id: 'meta-up-1', caption: 'look at this' } })
    const m = q(`SELECT * FROM messages WHERE wamid='wamid.OUTM'`)
    expect(m).toMatchObject({ direction: 'out', type: 'image', body: 'look at this', media_id: 'meta-up-1', status: 'sent' })
    expect(q(`SELECT * FROM media WHERE message_id=?`, m.id)).toMatchObject({ status: 'stored', r2_key: expect.stringMatching(/^o\//), mime: 'image/png', filename: 'photo one.png', size: PNG.byteLength })
    expect([...r2.store.get(q(`SELECT r2_key k FROM media WHERE message_id=?`, m.id).k)!.bytes]).toEqual([...PNG])
    expect(q(`SELECT last_preview p FROM conversations`).p).toBe('look at this')
    // and it can be served back
    expect((await call('GET', `/api/media/${m.id}`)).status).toBe(200)
  })
  it('the media row is committed only after the R2 put: a poll during a held put sees no row, afterwards stored and servable', async () => {
    upstream()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const realPut = r2.bucket.put.bind(r2.bucket)
    ;(r2.bucket as any).put = async (...a: any[]) => { await gate; return (realPut as any)(...a) }
    const r = await post(new File([PNG], 'p.png', { type: 'image/png' }), 'cap')
    expect(r.status).toBe(200)
    expect((await r.json() as any).message.id).toBeNull()
    await new Promise((x) => setTimeout(x, 20))
    const poll: any = await (await call('GET', '/api/contacts/1/messages?after=0', undefined, { cookie: s.cookie, csrf: s.csrf })).json()
    expect(poll.messages.filter((m: any) => m.direction === 'out')).toEqual([]) // no row, so the local preview bubble stays
    expect(q(`SELECT COUNT(*) n FROM media`).n).toBe(0)
    release(); await settle()
    const poll2: any = await (await call('GET', '/api/contacts/1/messages?after=0', undefined, { cookie: s.cookie, csrf: s.csrf })).json()
    const out = poll2.messages.find((m: any) => m.direction === 'out')
    expect(out.media.status).toBe('stored')
    expect((await call('GET', `/api/media/${out.id}`)).status).toBe(200)
  })
  it('a failing R2 put records the media as failed (only on the phone) and still stores the message', async () => {
    upstream()
    ;(r2.bucket as any).put = async () => { throw new Error('r2 down') }
    await post(new File([PNG], 'p.png', { type: 'image/png' }), 'cap'); await settle()
    expect(q(`SELECT status,r2_key,last_error FROM media`)).toMatchObject({ status: 'failed', r2_key: null, last_error: expect.stringContaining('r2 down') })
    expect(q(`SELECT COUNT(*) n FROM messages WHERE direction='out'`).n).toBe(1)
  })
  it('a deferred media record that failed twice is repaired by the cron: message, conversation and a pending media row', async () => {
    upstream()
    const realBatch = env.DB.batch.bind(env.DB)
    ;(env as any).DB = new Proxy(env.DB, { get: (t: any, p) => (p === 'batch' ? async (st: any[]) => { if (st.length === 4) throw new Error('d1 down'); return realBatch(st) } : t[p]) })
    await post(new File([PNG], 'p.png', { type: 'image/png' }), 'cap'); await settle()
    expect(q(`SELECT COUNT(*) n FROM messages WHERE direction='out'`).n).toBe(0)
    const ev = q(`SELECT payload FROM events WHERE kind='send_record_error'`)
    expect(JSON.parse(ev.payload)).toMatchObject({ wamid: 'wamid.OUTM', contact_id: 1, type: 'image', body: 'cap', media_id: 'meta-up-1', media: { filename: 'p.png' } })
    const real = realBatch; ;(env as any).DB = new Proxy(env.DB, { get: (t: any, p) => (p === 'batch' ? real : t[p]) })
    await scheduled(env)
    expect(q(`SELECT m.status,m.media_id,m.body FROM messages m JOIN media x ON x.message_id=m.id WHERE m.wamid='wamid.OUTM'`)).toMatchObject({ status: 'sent', media_id: 'meta-up-1', body: 'cap' })
    expect(q(`SELECT media_id,filename FROM media`)).toMatchObject({ media_id: 'meta-up-1', filename: 'p.png' }) // inserted pending; the same cron run may already have copied it from Meta
    expect(q(`SELECT last_preview p FROM conversations`).p).toBe('cap')
    expect(q(`SELECT COUNT(*) n FROM events WHERE kind='send_record_error'`).n).toBe(0)
    expect(q(`SELECT COUNT(*) n FROM events WHERE kind='send_record_repaired'`).n).toBe(1)
    await scheduled(env) // idempotent
    expect(q(`SELECT COUNT(*) n FROM messages WHERE direction='out'`).n).toBe(1)
  })
  it('a document sends its filename; audio drops the caption', async () => {
    const f = upstream()
    await post(new File([new TextEncoder().encode('%PDF-1.4 x')], 'quote.pdf', { type: 'application/pdf' }), 'cap')
    expect(JSON.parse((f.mock.calls[1]![1] as RequestInit).body as string).document).toEqual({ id: 'meta-up-1', caption: 'cap', filename: 'quote.pdf' })
    f.mockClear()
    await post(new File([new Uint8Array([1, 2, 3])], 'v.ogg', { type: 'audio/ogg' }), 'ignored')
    expect(JSON.parse((f.mock.calls[1]![1] as RequestInit).body as string).audio).toEqual({ id: 'meta-up-1' })
  })
  it('without R2 the message is sent and the media row says it is only on the phone', async () => {
    env.MEDIA = undefined
    upstream()
    expect((await post(new File([PNG], 'a.png', { type: 'image/png' }))).status).toBe(200)
    expect(q(`SELECT status,r2_key,last_error e FROM media`)).toEqual({ status: 'failed', r2_key: null, e: 'r2_unbound' })
  })
  it('rejects unsupported types, wrong magic bytes, empty, oversize; sends nothing', async () => {
    const f = upstream()
    expect((await post(new File(['<html>'], 'a.html', { type: 'text/html' }))).status).toBe(415)
    expect((await post(new File(['<svg/>'], 'a.svg', { type: 'image/svg+xml' }))).status).toBe(415)
    expect((await post(new File([new Uint8Array([1, 2, 3, 4])], 'fake.png', { type: 'image/png' }))).status).toBe(415)
    expect((await post(new File([], 'e.png', { type: 'image/png' }))).status).toBe(400)
    expect((await post(null)).status).toBe(400)
    const big = new Uint8Array(5 * 1024 * 1024 + 1); big.set(PNG)
    const r = await post(new File([big], 'big.png', { type: 'image/png' }))
    expect(r.status).toBe(413)
    expect((await r.json() as any).error).toBe('file_too_large')
    expect((await post(new File([PNG], 'a.png', { type: 'image/png' }), 'c'.repeat(1025))).status).toBe(400)
    expect(f).not.toHaveBeenCalled()
  })
  it('a document may be up to 16 MB, not more', async () => {
    upstream()
    const ok = new Uint8Array(16 * 1024 * 1024); ok.set([0x25, 0x50, 0x44, 0x46])
    expect((await post(new File([ok], 'a.pdf', { type: 'application/pdf' }))).status).toBe(200)
    const over = new Uint8Array(16 * 1024 * 1024 + 1); over.set([0x25, 0x50, 0x44, 0x46])
    expect((await post(new File([over], 'b.pdf', { type: 'application/pdf' }))).status).toBe(413)
  })
  it('409 window_closed, before anything is uploaded', async () => {
    raw.exec(`UPDATE conversations SET last_inbound_at = ${now() - 90_000}`)
    const f = upstream()
    expect((await post(new File([PNG], 'a.png', { type: 'image/png' }))).status).toBe(409)
    expect(f).not.toHaveBeenCalled()
  })
  it('an upload failure is reported with the stage and Meta error untouched', async () => {
    const err = { message: 'Unsupported media', code: 131053 }
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ source: 'meta', error: err }), { status: 400 }))
    const r = await post(new File([PNG], 'a.png', { type: 'image/png' }))
    expect(r.status).toBe(502)
    expect(await r.json()).toMatchObject({ source: 'meta', graph: err, stage: 'upload' })
    expect(q(`SELECT COUNT(*) n FROM messages`).n).toBe(0)
  })
})

describe('media review fixes', () => {
  let s: { cookie: string; csrf: string }
  beforeEach(async () => { s = await sessionFor(); await saveConfig(env, WB); seedContact(1) })
  const o = () => ({ cookie: s.cookie, csrf: s.csrf })

  it('a queued (202) media send still gets its message row, media row and R2 object, and says queued', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (u) =>
      String(u).endsWith('/media') ? new Response(JSON.stringify({ id: 'up-9' })) : new Response(JSON.stringify({ status: 'queued', id: 'qmsg_abc' }), { status: 202 }))
    const fd = new FormData(); fd.set('file', new File([PNG], 'a.png', { type: 'image/png' }))
    const r = await call('POST', '/api/inbox/1/send-media', fd, o())
    expect(r.status).toBe(200)
    const b: any = await r.json()
    expect(b).toMatchObject({ ok: true, wamid: null, status: 'queued', queued_id: 'qmsg_abc', message: { id: null, media: { status: 'stored' } } })
    await Promise.allSettled(waiting) // the row, media row and R2 copy are written after the reply
    b.message.id = q(`SELECT id FROM messages WHERE direction='out' ORDER BY id DESC LIMIT 1`).id
    const mrow = q(`SELECT status,r2_key FROM media WHERE message_id=?`, b.message.id)
    expect(mrow).toMatchObject({ status: 'stored', r2_key: expect.stringMatching(/^o\/[0-9a-f-]{36}$/) })
    expect(r2.store.has(mrow.r2_key)).toBe(true)
    expect((await call('GET', `/api/media/${b.message.id}`)).status).toBe(200)
  })
  it('a queued text send returns the row id and status queued', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ status: 'queued', id: 'qmsg_t' }), { status: 202 }))
    const b: any = await (await call('POST', '/api/inbox/1/send', { text: 'hi' }, o())).json()
    expect(b).toMatchObject({ status: 'queued', queued_id: 'qmsg_t', wamid: null, message: { id: null } })
    await Promise.allSettled(waiting) // the row, media row and R2 copy are written after the reply
    expect(q(`SELECT body,status FROM messages WHERE direction='out' ORDER BY id DESC LIMIT 1`)).toEqual({ body: 'hi', status: 'sent' })
  })
  it('a chunked upload with no Content-Length is 411', async () => {
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('x')); c.close() } })
    const r = await worker.fetch(new Request(`${ORIGIN}/api/inbox/1/send-media`, {
      method: 'POST', body: stream, duplex: 'half', headers: { Cookie: s.cookie, 'X-CSRF-Token': s.csrf, Origin: ORIGIN, 'content-type': 'multipart/form-data; boundary=x' },
    } as any), env, ctx)
    expect(r.status).toBe(411)
  })
  it('a no-adaptor cron run leaves attempts unchanged', async () => {
    const id = seedMedia()
    raw.exec(`DELETE FROM adaptor_config`)
    expect(await storeMedia(env, id)).toBe('retry')
    expect(q(`SELECT status,attempts,last_error e FROM media`)).toMatchObject({ status: 'pending', attempts: 0 })
  })
  it('5xx twice then success stores the file; attempts never counted', async () => {
    const id = seedMedia()
    const down = fakeAdaptor(async () => ({ ok: false, status: 503, error: { source: 'whabuzz', error: {}, message: 'unavailable' } }))
    expect(await storeMedia(env, id, down)).toBe('retry')
    expect(await storeMedia(env, id, down)).toBe('retry')
    expect(q(`SELECT attempts a FROM media`).a).toBe(0)
    expect(await storeMedia(env, id, okFetch(PNG, 'image/png'))).toBe('stored')
  })
  it('401 and a network error are transient; a 404 from the provider counts', async () => {
    const id = seedMedia()
    const mk = (status: number) => fakeAdaptor(async () => ({ ok: false, status, error: { source: 'meta', error: {}, message: 'x' } }))
    await storeMedia(env, id, mk(401)); await storeMedia(env, id, mk(0))
    expect(q(`SELECT attempts a FROM media`).a).toBe(0)
    await storeMedia(env, id, mk(404))
    expect(q(`SELECT attempts a FROM media`).a).toBe(1)
  })
  it('the cron backs off by attempt count (15m, 1h, 6h, 24h after creation)', async () => {
    const id = seedMedia({ attempts: 2 })
    const ok = okFetch(PNG, 'image/png')
    expect((await retryPending(env, ok)).stored).toBe(0) // created just now, needs 4500 s
    raw.exec(`UPDATE media SET created_at = unixepoch() - 4600 WHERE message_id=${id}`)
    expect((await retryPending(env, ok)).stored).toBe(1)
  })
  it('legacy POST /api/send is 409 window_closed outside 24h, and for a number we never heard from; ADMIN_KEY still works inside', async () => {
    raw.exec(`UPDATE conversations SET last_inbound_at = ${now() - 90_000}`)
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ messages: [{ id: 'wamid.L1' }] })))
    const a = await call('POST', '/api/send', { contact_id: 1, text: 'hi' })
    expect(a.status).toBe(409)
    expect(((await a.json()) as any).error).toBe('window_closed')
    expect((await call('POST', '/api/send', { to: '+1 555 000 0099', text: 'hi' })).status).toBe(409)
    expect(q(`SELECT COUNT(*) n FROM contacts`).n).toBe(1)
    expect(f).not.toHaveBeenCalled()
    raw.exec(`UPDATE conversations SET last_inbound_at = ${now() - 60}`)
    expect((await call('POST', '/api/send', { contact_id: 1, text: 'hi' })).status).toBe(200)
  })
})

describe('sendMedia on both adaptors', () => {
  const file = { bytes: PNG, mime: 'image/png', kind: 'image' as const, filename: 'a.png', caption: 'hi' }

  it('WhaBuzz: POST /media (multipart) then POST /messages with the returned id', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fetchImpl = (async (u: any, init: RequestInit) => {
      calls.push({ url: String(u), init })
      return String(u).endsWith('/media') ? new Response(JSON.stringify({ id: 'M1' })) : new Response(JSON.stringify({ messages: [{ id: 'wamid.X' }] }))
    }) as typeof fetch
    const a = new WhaBuzzAdaptor(WB.config, fetchImpl)
    const out = await sendMediaFile(a, '15550000001', file)
    expect(out).toMatchObject({ ok: true, wamid: 'wamid.X', mediaId: 'M1' })
    expect(calls.map((c) => c.url)).toEqual(['https://api.whabuzz.com/v1/media', 'https://api.whabuzz.com/v1/messages'])
    expect((calls[0]!.init.body as FormData).get('from')).toBe('1000000000000001')
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({
      from: '1000000000000001', messaging_product: 'whatsapp', to: '15550000001', type: 'image', image: { id: 'M1', caption: 'hi' },
    })
    expect((calls[1]!.init.headers as Record<string, string>).Authorization).toBe('Bearer k')
  })
  it('Cloud API: POST /{phone}/media then /{phone}/messages', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fetchImpl = (async (u: any, init: RequestInit) => {
      calls.push({ url: String(u), init })
      return String(u).endsWith('/media') ? new Response(JSON.stringify({ id: 'M2' })) : new Response(JSON.stringify({ messages: [{ id: 'wamid.Y' }] }))
    }) as typeof fetch
    const a = new CloudApiAdaptor({ system_token: 'tok', app_secret: 's', phone_number_id: '555', waba_id: '9' }, fetchImpl)
    const out = await sendMediaFile(a, '15550000001', { ...file, kind: 'document', mime: 'application/pdf', filename: 'q.pdf' })
    expect(out).toMatchObject({ ok: true, wamid: 'wamid.Y', mediaId: 'M2' })
    expect(calls.map((c) => c.url)).toEqual(['https://graph.facebook.com/v22.0/555/media', 'https://graph.facebook.com/v22.0/555/messages'])
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({
      messaging_product: 'whatsapp', to: '15550000001', type: 'document', document: { id: 'M2', caption: 'hi', filename: 'q.pdf' },
    })
  })
  it('Meta errors pass through verbatim from either step, on both adaptors', async () => {
    const e1 = { message: 'Param not valid', type: 'OAuthException', code: 100, fbtrace_id: 'abc' }
    const graphFail = (async () => new Response(JSON.stringify({ error: e1 }), { status: 400 })) as typeof fetch
    const c = new CloudApiAdaptor({ system_token: 't', app_secret: 's', phone_number_id: '1', waba_id: '2' }, graphFail)
    const up = await sendMediaFile(c, 'x', file)
    expect(up).toMatchObject({ ok: false, stage: 'upload', result: { error: { source: 'meta', error: e1 } } })

    const e2 = { message: 'Recipient not in allowed list', code: 131030 }
    let n = 0
    const wbFetch = (async () => (++n === 1 ? new Response(JSON.stringify({ id: 'M3' })) : new Response(JSON.stringify({ source: 'meta', error: e2 }), { status: 400 }))) as typeof fetch
    const w = new WhaBuzzAdaptor(WB.config, wbFetch)
    const sendFail = await sendMediaFile(w, 'x', file)
    expect(sendFail).toMatchObject({ ok: false, stage: 'send', result: { status: 400, error: { source: 'meta', error: e2 } } })
  })
  it('a 200 upload with no id is an upload failure, not a send of undefined', async () => {
    const a = new WhaBuzzAdaptor(WB.config, (async () => new Response('{}')) as typeof fetch)
    expect(await sendMediaFile(a, 'x', file)).toMatchObject({ ok: false, stage: 'upload' })
  })
})

describe('quick replies', () => {
  let s: { cookie: string; csrf: string }
  beforeEach(async () => { s = await sessionFor() })
  const o = () => ({ cookie: s.cookie, csrf: s.csrf })

  it('CRUD with unique case-insensitive shortcuts and validation', async () => {
    expect((await call('GET', '/api/quick-replies', undefined, { bearer: null })).status).toBe(401)
    expect(((await (await call('GET', '/api/quick-replies', undefined, o())).json()) as any).quick_replies).toEqual([])
    const c = await call('POST', '/api/quick-replies', { shortcut: '/Hours', body: 'Open 9 to 6, {name}.' }, o())
    expect(c.status).toBe(201)
    const id = ((await c.json()) as any).quick_reply.id
    expect(q(`SELECT shortcut,body,created_by FROM quick_replies`)).toEqual({ shortcut: 'Hours', body: 'Open 9 to 6, {name}.', created_by: 1 })
    expect((await call('POST', '/api/quick-replies', { shortcut: 'hours', body: 'x' }, o())).status).toBe(409)
    expect((await call('POST', '/api/quick-replies', { shortcut: 'has space', body: 'x' }, o())).status).toBe(400)
    expect((await call('POST', '/api/quick-replies', { shortcut: 'ok', body: '  ' }, o())).status).toBe(400)
    const p = await call('PATCH', `/api/quick-replies/${id}`, { body: 'New body' }, o())
    expect(((await p.json()) as any).quick_reply).toEqual({ id, shortcut: 'Hours', body: 'New body' })
    await call('POST', '/api/quick-replies', { shortcut: 'two', body: 'b' }, o())
    expect((await call('PATCH', `/api/quick-replies/${id}`, { shortcut: 'TWO' }, o())).status).toBe(409)
    expect((await call('PATCH', `/api/quick-replies/999`, { body: 'x' }, o())).status).toBe(404)
    expect((await call('DELETE', `/api/quick-replies/${id}`, undefined, o())).status).toBe(200)
    expect((await call('DELETE', `/api/quick-replies/${id}`, undefined, o())).status).toBe(404)
    expect(((await (await call('GET', '/api/quick-replies', undefined, o())).json()) as any).quick_replies.map((x: any) => x.shortcut)).toEqual(['two'])
  })
  it('CSRF is enforced on writes', async () => {
    expect((await call('POST', '/api/quick-replies', { shortcut: 'a', body: 'b' }, { cookie: s.cookie })).status).toBe(403)
  })
  it('placeholder substitution: {name} is the first name, with a neutral fallback; unknown tokens stay', () => {
    expect(fillQuickReply('Hi {name}, thanks!', { name: 'Asha Rao' })).toBe('Hi Asha, thanks!')
    expect(fillQuickReply('Hi {name}', { name: null })).toBe('Hi there')
    expect(fillQuickReply('Hi {NAME} and {name}', { name: '  Li  ' })).toBe('Hi Li and Li')
    expect(fillQuickReply('Hi {name}', { name: '+1 555 000 0001' })).toBe('Hi there')
    expect(fillQuickReply('Use {code} and {{name}}', { name: 'Sam' })).toBe('Use {code} and {Sam}')
  })
})

describe('safeFilename', () => {
  it('strips paths and control characters', () => {
    expect(safeFilename('../../etc/passwd')).toBe('etc-passwd')
    expect(safeFilename('a\u0000b\r\n.png')).toBe('a-b-.png')
    expect(safeFilename('', 'x')).toBe('x')
    expect(safeFilename('Résumé.pdf')).toBe('Résumé.pdf')
  })
})
