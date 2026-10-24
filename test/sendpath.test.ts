// D19 follow-up: the own-time of a send is dominated by sequential D1 round trips. This counts them (each one is a
// network hop to D1 in production) and, with SENDPATH_LAT_MS set, injects a per-trip delay so the wall time shows it.
// SENDPATH_REPORT=1 prints the step table.
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'
import { saveConfig } from '../src/adaptors'
import { ensureSchema, type Env } from '../src/db'
import { fakeD1 } from './d1'

const SECRET = 'test-session-secret-0123456789'
const ORIGIN = 'https://leads.example.com'
const LAT = Number(process.env.SENDPATH_LAT_MS ?? 0)
const REPORT = !!process.env.SENDPATH_REPORT
const WB = { kind: 'whabuzz' as const, config: { api_key: 'k', phone_number_id: '1000000000000001', waba_id: '2', webhook_secret: 'whsec_TEST_x' } }

type Step = { label: string; at: number; ms: number }
let steps: Step[] = []
let t0 = 0
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const mark = async <T>(label: string, run: () => Promise<T>, delay = LAT): Promise<T> => {
  const at = performance.now() - t0
  if (delay) await sleep(delay)
  try { return await run() } finally { steps.push({ label, at: Math.round(at), ms: Math.round(performance.now() - t0 - at) }) }
}
const lbl = (sql: string) => sql.replace(/\s+/g, ' ').trim().slice(0, 56)

/** Wraps a D1 shim so every round trip is recorded (and optionally delayed). */
function counted(d1: any): D1Database {
  const wrapStmt = (s: any, sql: string): any => new Proxy(s, {
    get(target, p) {
      if (p === 'bind') return (...a: unknown[]) => wrapStmt(target.bind(...a), sql)
      if (p === 'first' || p === 'all' || p === 'run') return (...a: unknown[]) => mark(`${String(p)} ${lbl(sql)}`, () => target[p](...a))
      return target[p]
    },
  })
  return new Proxy(d1, {
    get(target, p) {
      if (p === 'prepare') return (sql: string) => wrapStmt(target.prepare(sql), sql)
      if (p === 'batch') return (stmts: any[]) => mark(`batch[${stmts.length}]`, () => target.batch(stmts))
      return target[p]
    },
  })
}

let env: Env
let raw: DatabaseSync
let waiting: Promise<unknown>[]
const ctx = { waitUntil: (p: Promise<unknown>) => { waiting.push(p) }, passThroughOnException: () => {} } as unknown as ExecutionContext
const rows = <T = any>(sql: string, ...a: any[]) => raw.prepare(sql).all(...a) as T[]

async function login(e: Env) {
  const res = await worker.fetch(new Request(`${ORIGIN}/api/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ setup_key: SECRET, business_name: 'Example Co', default_country: 'US', timezone: 'UTC', admin: { name: 'Test Admin', email: 'admin@example.com', password: 'correct horse battery staple' } }),
  }), e, ctx)
  const body: any = await res.json()
  return { cookie: (res.headers.get('set-cookie') ?? '').split(';')[0]!, csrf: body.csrf as string }
}

beforeEach(async () => {
  const f = fakeD1(); raw = f.raw
  waiting = []
  env = { DB: f.d1, ADMIN_KEY: 'adminkey', SESSION_SECRET: SECRET, INSTANCE_NAME: 'inst', ALLOWED_ORIGINS: '', META_APP_SECRET: 'appsecret' } as unknown as Env
  await ensureSchema(f.d1)
  await saveConfig(env, WB)
  const inAt = Math.floor(Date.now() / 1000) - 60
  raw.exec(`INSERT INTO contacts (id,wa_id,phone,name) VALUES (1,'15550000001','15550000001','Asha')`)
  raw.exec(`INSERT INTO conversations (contact_id,last_message_at,last_inbound_at,last_preview,unread_count) VALUES (1,${inAt},${inAt},'hi',1)`)
  raw.exec(`INSERT INTO leads (contact_id,source) VALUES (1,'pilot_form')`)
  let n = 0
  vi.stubGlobal('fetch', async () => { n++; return mark('UPSTREAM fetch', async () => new Response(JSON.stringify({ messages: [{ id: `wamid.SP${n}` }] }), { status: 200 }), 0) })
})
afterEach(() => vi.restoreAllMocks())

/** One timed send on a warm isolate (a first request pays schema/setup once, as in production). */
async function timedSend(path: string, bodyObj: unknown, staff: { cookie: string; csrf: string }) {
  const go = () => worker.fetch(new Request(`${ORIGIN}${path}`, {
    method: 'POST', body: JSON.stringify(bodyObj),
    headers: { 'content-type': 'application/json', Origin: ORIGIN, Cookie: staff.cookie, 'X-CSRF-Token': staff.csrf },
  }), env, ctx)
  await go(); await Promise.allSettled(waiting); waiting = []
  steps = []; t0 = performance.now()
  const wall0 = performance.now()
  const res = await go()
  const respondedAt = performance.now() - wall0
  const before = steps.filter((s) => s.at <= respondedAt).length // steps started before the response returned
  await Promise.allSettled(waiting)
  if (REPORT) {
    const cols = steps.map((s) => `${String(s.at).padStart(5)}ms  +${String(s.ms).padStart(4)}  ${s.label}`).join('\n')
    console.log(`\n== ${path} (lat ${LAT}ms/trip)  response at ${Math.round(respondedAt)}ms\n${cols}`)
  }
  const trips = steps.filter((s) => !s.label.startsWith('UPSTREAM'))
  return { res, respondedAt, trips, beforeResponse: trips.filter((s) => s.at < respondedAt) , before }
}

const own = (r: { trips: Step[] }) => r.trips.filter((t) => !t.label.includes('INTO events')) // the send_timing log runs after the response

describe('send path D1 round trips', () => {
  it('POST /api/inbox/:id/send: session and target overlap, then one batch (was 4 serial trips, now 2)', async () => {
    const staff = await login(env)
    ;(env as any).DB = counted(env.DB)
    const r = await timedSend('/api/inbox/1/send', { text: 'hello' }, staff)
    expect(r.res.status).toBe(200)
    const t = own(r)
    console.log(`inbox/send: ${t.length} D1 round trips before the response (${t.map((x) => x.label.slice(0, 22)).join(' | ')})`)
    expect(t).toHaveLength(4) // + the send rate-limit hit, which overlaps the session lookup (no extra serial trip)
    expect(t.filter((x) => x.label.startsWith('batch'))).toHaveLength(1)
    const rl = t.find((x) => x.label.includes('rate_limits'))!
    expect(rl.at - t[0]!.at).toBeLessThan(LAT || 25)
    // respond-before-batch: the reply does not wait for the batch (proved deterministically by the gated-batch race test below)
    expect(t[1]!.at - t[0]!.at).toBeLessThan(LAT || 25)
    expect(rows(`SELECT id FROM messages WHERE direction='out'`).length).toBe(2) // warm-up + timed
  })
  it('POST /api/send: contact+window+config version in one query, adaptor from cache, one batch', async () => {
    const staff = await login(env)
    ;(env as any).DB = counted(env.DB)
    const r = await timedSend('/api/send', { contact_id: 1, text: 'hello' }, staff)
    expect(r.res.status).toBe(200)
    expect(own(r)).toHaveLength(4) // session, rate limit (in parallel), target, batch (the batch after the reply)
  })
  it('the reply carries wamid and a null row id; the row, conversation touch and first_response land via waitUntil', async () => {
    const staff = await login(env)
    const res = await worker.fetch(new Request(`${ORIGIN}/api/inbox/1/send`, { method: 'POST', body: JSON.stringify({ text: 'hey' }), headers: { 'content-type': 'application/json', Origin: ORIGIN, Cookie: staff.cookie, 'X-CSRF-Token': staff.csrf } }), env, ctx)
    const b: any = await res.json()
    expect(b).toMatchObject({ ok: true, wamid: expect.stringMatching(/^wamid\.SP/), message: { id: null, status: 'sent', body: 'hey' } })
    await Promise.allSettled(waiting)
    expect(rows(`SELECT wamid,status FROM messages WHERE direction='out'`)).toEqual([{ wamid: b.wamid, status: 'sent' }])
    expect(rows(`SELECT last_preview FROM conversations WHERE contact_id=1`)[0]).toMatchObject({ last_preview: 'hey' })
    expect(rows(`SELECT first_response_at f FROM leads WHERE contact_id=1`)[0]!.f).not.toBeNull()
  })
  it('a delivered status webhook that lands BEFORE the deferred insert is not lost: the row is created as delivered', async () => {
    const staff = await login(env)
    const held: Promise<unknown>[] = []
    const deferCtx = { waitUntil: (p: Promise<unknown>) => { held.push(p) }, passThroughOnException: () => {} } as unknown as ExecutionContext
    // hold the deferred writes back: the insert has not run when the webhook arrives
    const realBatch = env.DB.batch.bind(env.DB)
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    ;(env as any).DB = new Proxy(env.DB, { get: (t: any, p) => (p === 'batch' ? async (st: any[]) => { if (st.length === 3 && gate) await gate; return realBatch(st) } : t[p]) })
    const res = await worker.fetch(new Request(`${ORIGIN}/api/inbox/1/send`, { method: 'POST', body: JSON.stringify({ text: 'race' }), headers: { 'content-type': 'application/json', Origin: ORIGIN, Cookie: staff.cookie, 'X-CSRF-Token': staff.csrf } }), env, deferCtx)
    const { wamid }: any = await res.json()
    expect(rows(`SELECT id FROM messages WHERE wamid=?`, wamid)).toHaveLength(0) // reply sent, nothing stored yet
    // the status webhook (delivered, then read arriving out of order is covered by rank) lands now
    const { processEvents } = await import('../src/inbound')
    await processEvents(env, deferCtx, [{ kind: 'status', wamid, status: 'delivered', timestamp: 123, raw: {} } as any])
    expect(rows(`SELECT status FROM message_statuses WHERE wamid=?`, wamid)).toEqual([{ status: 'delivered' }]) // stored for the unknown wamid
    release(); await Promise.allSettled(held)
    expect(rows(`SELECT status FROM messages WHERE wamid=?`, wamid)).toEqual([{ status: 'delivered' }])
    // a later webhook still moves it forward, and a replay stays a duplicate
    const out = await processEvents(env, deferCtx, [{ kind: 'status', wamid, status: 'read', timestamp: 124, raw: {} } as any, { kind: 'status', wamid, status: 'delivered', timestamp: 123, raw: {} } as any])
    expect(out.duplicates).toBe(1)
    expect(rows(`SELECT status FROM messages WHERE wamid=?`, wamid)).toEqual([{ status: 'read' }])
  })
  it('failed is terminal even when it arrived first; a failed status does not get overwritten by a late delivered', async () => {
    const staff = await login(env)
    raw.prepare(`INSERT INTO message_statuses (wamid,status,timestamp,raw) VALUES ('wamid.SP1','delivered',1,'{}'),('wamid.SP1','failed',2,'{}')`).run()
    await worker.fetch(new Request(`${ORIGIN}/api/inbox/1/send`, { method: 'POST', body: JSON.stringify({ text: 'f' }), headers: { 'content-type': 'application/json', Origin: ORIGIN, Cookie: staff.cookie, 'X-CSRF-Token': staff.csrf } }), env, ctx)
    await Promise.allSettled(waiting)
    expect(rows(`SELECT status FROM messages WHERE wamid='wamid.SP1'`)).toEqual([{ status: 'failed' }])
  })
  it('a failing deferred insert retries once, then logs send_record_error with the wamid', async () => {
    const staff = await login(env)
    const realBatch = env.DB.batch.bind(env.DB)
    let n = 0
    ;(env as any).DB = new Proxy(env.DB, { get: (t: any, p) => (p === 'batch' ? async (st: any[]) => { if (st.length === 3) { n++; throw new Error('d1 down') } return realBatch(st) } : t[p]) })
    const res = await worker.fetch(new Request(`${ORIGIN}/api/inbox/1/send`, { method: 'POST', body: JSON.stringify({ text: 'x' }), headers: { 'content-type': 'application/json', Origin: ORIGIN, Cookie: staff.cookie, 'X-CSRF-Token': staff.csrf } }), env, ctx)
    expect(res.status).toBe(200)
    await Promise.allSettled(waiting)
    expect(n).toBe(2)
    expect(rows(`SELECT payload FROM events WHERE kind='send_record_error'`)).toHaveLength(1)
    const p = JSON.parse(rows(`SELECT payload FROM events WHERE kind='send_record_error'`)[0]!.payload)
    expect(p).toMatchObject({ wamid: expect.stringMatching(/^wamid\.SP/), contact_id: 1, type: 'text', body: 'x', media_id: null, ts: expect.any(Number) })
  })
  it('the cron replays a lost record: message + conversation come back, the event is marked repaired, a second run changes nothing', async () => {
    const staff = await login(env)
    const realBatch = env.DB.batch.bind(env.DB)
    let down = true
    ;(env as any).DB = new Proxy(env.DB, { get: (t: any, p) => (p === 'batch' ? async (st: any[]) => { if (down && st.length === 3) throw new Error('d1 down'); return realBatch(st) } : t[p]) })
    await worker.fetch(new Request(`${ORIGIN}/api/inbox/1/send`, { method: 'POST', body: JSON.stringify({ text: 'lost' }), headers: { 'content-type': 'application/json', Origin: ORIGIN, Cookie: staff.cookie, 'X-CSRF-Token': staff.csrf } }), env, ctx)
    await Promise.allSettled(waiting)
    expect(rows(`SELECT id FROM messages WHERE direction='out'`)).toHaveLength(0)
    down = false
    const { scheduled } = await import('../src/media')
    await scheduled(env)
    expect(rows(`SELECT body,status FROM messages WHERE direction='out'`)).toEqual([{ body: 'lost', status: 'sent' }])
    expect(rows(`SELECT last_preview p FROM conversations WHERE contact_id=1`)[0]!.p).toBe('lost')
    expect(rows(`SELECT kind FROM events WHERE kind LIKE 'send_record_%' AND kind <> 'send_record_repair_run'`)).toEqual([{ kind: 'send_record_repaired' }])
    await scheduled(env)
    expect(rows(`SELECT id FROM messages WHERE direction='out'`)).toHaveLength(1)
  })
  it('a queued (no wamid) send: a retry after a lost acknowledgement does not duplicate the null-wamid row', async () => {
    const { outboundMessageInsert } = await import('../src/conversations')
    const ts = 1_700_000_000
    await env.DB.batch([outboundMessageInsert(env.DB, 1, null, 'text', 'q', null, ts)])
    await env.DB.batch([outboundMessageInsert(env.DB, 1, null, 'text', 'q', null, ts)]) // the retry
    expect(rows(`SELECT id FROM messages WHERE direction='out'`)).toHaveLength(1)
    await env.DB.batch([outboundMessageInsert(env.DB, 1, null, 'text', 'q', null, ts + 1)]) // a genuinely later one is kept
    expect(rows(`SELECT id FROM messages WHERE direction='out'`)).toHaveLength(2)
  })
  it('the cached adaptor follows the stored config: another isolate saving a new key is picked up on the next send', async () => {
    const staff = await login(env)
    const seen: string[] = []
    vi.stubGlobal('fetch', async (_u: string, init: any) => { seen.push(String(init?.headers?.Authorization ?? init?.headers?.authorization)); return new Response(JSON.stringify({ messages: [{ id: 'wamid.X' + seen.length }] }), { status: 200 }) })
    const send = (text: string) => worker.fetch(new Request(`${ORIGIN}/api/inbox/1/send`, { method: 'POST', body: JSON.stringify({ text }), headers: { 'content-type': 'application/json', Origin: ORIGIN, Cookie: staff.cookie, 'X-CSRF-Token': staff.csrf } }), env, ctx)
    expect((await send('one')).status).toBe(200)
    expect((await send('two')).status).toBe(200) // served from the cache
    // a second isolate (same D1, its own memory) saves a different key: simulated by writing the row directly
    const { encryptJson } = await import('../src/crypto')
    const blob = await encryptJson(SECRET, { ...WB.config, api_key: 'rotated-key' })
    raw.prepare(`UPDATE adaptor_config SET config_enc=? WHERE id=1`).run(blob)
    expect((await send('three')).status).toBe(200)
    expect(seen[0]).toContain('k'); expect(seen[1]).toBe(seen[0]); expect(seen[2]).toContain('rotated-key')
    // removing the config surfaces as 503 immediately, not from the cache
    raw.exec(`DELETE FROM adaptor_config`)
    expect((await send('four')).status).toBe(503)
  })
  it('an unauthenticated send never reaches the gateway even though the target read started early', async () => {
    const calls: unknown[] = []
    vi.stubGlobal('fetch', async (...a: unknown[]) => { calls.push(a); return new Response('{}', { status: 200 }) })
    const res = await worker.fetch(new Request(`${ORIGIN}/api/inbox/1/send`, { method: 'POST', body: JSON.stringify({ text: 'x' }), headers: { 'content-type': 'application/json', Origin: ORIGIN, Cookie: 'wl_session=bogus' } }), env, ctx)
    expect(res.status).toBe(401)
    expect(calls).toHaveLength(0)
    expect(rows(`SELECT id FROM messages WHERE direction='out'`)).toHaveLength(0)
  })
})
