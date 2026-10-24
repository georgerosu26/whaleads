// the flows API through the real worker: auth matrix, CSRF, validation shape, publish derivation, pause / archive /
// delete semantics, dry-run isolation, run listing and cancel.
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'
import { ensureSchema, type Env } from '../src/db'
import { putSetting } from '../src/settings'
import { encryptJson } from '../src/crypto'
import { hashPassword } from '../src/password'
import { dispatchLeadCreated, tick } from '../src/flows'
import { startRun } from '../src/flows/engine'
import { fakeD1 } from './d1'
import { addFlow, edge, graph, node, trigger } from './flows.helpers'

const SECRET = 'test-session-secret-0123456789'
const ORIGIN = 'https://leads.example.com'
const PASS = 'correct horse battery'
let env: Env
let raw: DatabaseSync
let waiting: Promise<unknown>[]
let frames: any[]
let fetchCalls: number
const ctx = { waitUntil: (p: Promise<unknown>) => { waiting.push(p) }, passThroughOnException: () => {} } as unknown as ExecutionContext
const settle = async () => { while (waiting.length) { const w = waiting; waiting = []; await Promise.allSettled(w) } }

type Opts = { cookie?: string; csrf?: string; bearer?: string; origin?: string | null }
const call = async (method: string, path: string, body?: unknown, o: Opts = {}) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (o.cookie) headers.Cookie = o.cookie
  if (o.csrf) headers['X-CSRF-Token'] = o.csrf
  if (o.bearer) headers.Authorization = `Bearer ${o.bearer}`
  if (o.origin !== null && method !== 'GET') headers.Origin = o.origin ?? ORIGIN
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx)
  await settle()
  return res
}
type Sess = { cookie: string; csrf: string }
async function seed(email: string, role: 'admin' | 'staff'): Promise<Sess> {
  raw.prepare(`INSERT INTO staff (email,name,role,pw_hash) VALUES (?,?,?,?)`).run(email, `Test ${role}`, role, await hashPassword(PASS, 1000))
  const res = await call('POST', '/api/auth/login', { email, password: PASS })
  const body: any = await res.json()
  return { cookie: (res.headers.get('set-cookie') ?? '').split(';')[0], csrf: body.csrf }
}
const as = (s: Sess): Opts => ({ cookie: s.cookie, csrf: s.csrf })
let admin: Sess, staff: Sess
const KEY: Opts = { bearer: 'adminkey' }

const q = <T = any>(sql: string, ...a: any[]) => raw.prepare(sql).all(...a) as T[]
const count = (t: string) => (raw.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n

const note = (text = 'ran') => node('n', 'action', { actionType: 'note', text })
const simple = (kind = 'lead_created', extra: Record<string, unknown> = {}) =>
  graph([node('t', 'trigger', { kind, ...extra }), note()], [edge('t', 'out', 'n')])
async function mk(name: string, g = simple(), o: Opts = KEY): Promise<number> {
  const res = await call('POST', '/api/flows', { name, graph: g }, o)
  expect(res.status).toBe(201)
  return ((await res.json()) as any).flow.id
}
const pub = (id: number, o: Opts = KEY) => call('POST', `/api/flows/${id}/publish`, undefined, o)

beforeEach(async () => {
  const f = fakeD1(); raw = f.raw
  env = { DB: f.d1, ADMIN_KEY: 'adminkey', SESSION_SECRET: SECRET, INSTANCE_NAME: 'inst', ALLOWED_ORIGINS: '' } as unknown as Env
  waiting = []; frames = []; fetchCalls = 0
  env.LIVE = { idFromName: (n: string) => n, get: () => ({ broadcast: async (fs: string[]) => { frames.push(...fs.map((x) => JSON.parse(x))); return 1 } }) } as any
  await ensureSchema(env.DB)
  raw.exec(`INSERT INTO contacts (id,wa_id,phone,name) VALUES (1,'15550000001','15550000001','Asha Rao')`)
  raw.exec(`INSERT INTO leads (id,contact_id,source,status) VALUES (1,1,'whatsapp','new')`)
  vi.stubGlobal('fetch', async () => { fetchCalls++; return new Response('{}', { status: 200 }) })
  admin = await seed('admin@example.com', 'admin'); staff = await seed('staff@example.com', 'staff')
})
afterEach(() => vi.unstubAllGlobals())

describe('auth matrix', () => {
  const writes: [string, string, unknown][] = [
    ['POST', '/api/flows', { name: 'x' }],
    ['PUT', '/api/flows/1', { name: 'y' }],
    ['DELETE', '/api/flows/1', undefined],
    ['POST', '/api/flows/1/publish', undefined],
    ['POST', '/api/flows/1/pause', undefined],
    ['POST', '/api/flows/1/archive', undefined],
    ['POST', '/api/flows/1/duplicate', undefined],
    ['POST', '/api/flow-runs/1/cancel', undefined],
  ]
  const reads: [string, string, unknown][] = [
    ['GET', '/api/flows', undefined],
    ['GET', '/api/flows/1', undefined],
    ['GET', '/api/flows/1/runs', undefined],
    ['GET', '/api/leads/1/flow-runs', undefined],
    ['GET', '/api/flow-runs/1', undefined],
    ['POST', '/api/flows/1/dry-run', { lead_id: 1 }],
  ]
  beforeEach(() => { addFlow(raw, simple(), { id: 1 }); raw.exec(`UPDATE flows SET status='draft', version=0, published_graph=NULL WHERE id=1`) })

  it('no credentials: 401 on everything', async () => {
    for (const [m, p, b] of [...writes, ...reads]) expect((await call(m, p, b, { origin: ORIGIN })).status, `${m} ${p}`).toBe(401)
  })
  it('staff: reads and dry-run pass, every write is 403', async () => {
    for (const [m, p, b] of reads) { const r = await call(m, p, b, as(staff)); expect([200, 404].includes(r.status), `${m} ${p} ${r.status} ${await r.text()}`).toBe(true) }
    for (const [m, p, b] of writes) expect((await call(m, p, b, as(staff))).status, `${m} ${p}`).toBe(403)
    expect(q(`SELECT name FROM flows`).map((r) => r.name)).toEqual(['flow-1']) // nothing was written
  })
  it('admin session passes every write (no 401/403)', async () => {
    for (const [m, p, b] of writes) expect([401, 403].includes((await call(m, p, b, as(admin))).status), `${m} ${p}`).toBe(false)
  })
  it('CSRF: a session without the token or with a foreign Origin is 403, even for admin', async () => {
    for (const [m, p, b] of [...writes, ['POST', '/api/flows/1/dry-run', { lead_id: 1 }] as [string, string, unknown]]) {
      expect((await call(m, p, b, { cookie: admin.cookie })).status, `no token ${m} ${p}`).toBe(403)
      expect((await call(m, p, b, { ...as(admin), origin: 'https://evil.example' })).status, `bad origin ${m} ${p}`).toBe(403)
    }
    expect(count('flows')).toBe(1)
  })
  it('the ADMIN_KEY bearer acts as admin without CSRF', async () => {
    expect((await call('POST', '/api/flows', { name: 'viakey' }, KEY)).status).toBe(201)
  })
  it('ids that are not positive whole numbers are a 400, not a fall-through 404', async () => {
    for (const p of ['/api/flows/abc', '/api/flows/0', '/api/flows/-1', '/api/flows/1.5', '/api/flows/abc/runs', '/api/leads/x/flow-runs', '/api/flow-runs/0', '/api/flows/99999999999999999999'])
      expect(await (await call('GET', p, undefined, as(staff))).json(), p).toMatchObject({ ok: false, field: 'id' })
    expect((await call('POST', '/api/flows/abc/publish', undefined, KEY)).status).toBe(400)
    expect((await call('POST', '/api/flow-runs/abc/cancel', undefined, KEY)).status).toBe(400)
  })
  it('flow writes are limited to 60 a minute per staff member; reads and other staff are not', async () => {
    let last = 0
    for (let i = 0; i < 61; i++) last = (await call('POST', '/api/flows/1/pause', undefined, as(admin))).status
    expect(last).toBe(429)
    expect((await call('GET', '/api/flows', undefined, as(admin))).status).toBe(200)
    expect((await call('POST', '/api/flows/1/pause', undefined, KEY)).status).not.toBe(429)
  })
})

describe('create / update / read', () => {
  it('create: empty graph with one trigger, draft, shadow on; warns that the trigger kind is not chosen', async () => {
    const res = await call('POST', '/api/flows', { name: '  Welcome  ', description: 'd' }, as(admin))
    const b: any = await res.json()
    expect(res.status).toBe(201)
    expect(b.flow).toMatchObject({ name: 'Welcome', status: 'draft', shadow: true, reentry: 'once', version: 0, trigger_kind: null, published_graph: null })
    expect(b.flow.graph.nodes.map((n: any) => n.type)).toEqual(['trigger'])
    expect(b.warnings.map((w: any) => w.msg).join()).toMatch(/trigger kind/)
    expect(q('SELECT created_by FROM flows')[0].created_by).not.toBeNull()
  })
  it('validation: 400 shape for bad fields, 409 name_taken, 422 per-node errors for an unstorable graph', async () => {
    expect(await (await call('POST', '/api/flows', { name: '' }, KEY)).json()).toMatchObject({ ok: false, field: 'name' })
    expect((await call('POST', '/api/flows', { name: 'a', shadow: 'yes' }, KEY)).status).toBe(400)
    expect((await call('POST', '/api/flows', { name: 'a', priority: 0 }, KEY)).status).toBe(400)
    expect((await call('POST', '/api/flows', { name: 'a', graph: 'nope' }, KEY)).status).toBe(400)
    await mk('dup')
    expect(await (await call('POST', '/api/flows', { name: 'dup' }, KEY)).json()).toMatchObject({ ok: false, error: 'name_taken', field: 'name' })
    const g = graph([trigger('lead_created'), node('x', 'bogus' as any)], [edge('t', 'out', 'ghost')])
    const res = await call('POST', '/api/flows', { name: 'bad', graph: g }, KEY)
    const b: any = await res.json()
    expect(res.status).toBe(422)
    expect(b).toMatchObject({ ok: false, error: 'invalid_graph' })
    expect(b.errors.some((e: any) => e.node === 'x' && /unknown node type/.test(e.msg))).toBe(true)
    expect(b.errors.every((e: any) => 'msg' in e && !('soft' in e))).toBe(true)
    expect(q('SELECT 1 FROM flows WHERE name=?', 'bad')).toHaveLength(0)
  })
  it('a half-built draft (loose node, empty message) saves with warnings; publish refuses it', async () => {
    const g = graph([trigger('lead_created'), node('m', 'message', { text: '' }), node('z', 'action', { actionType: 'note', text: 'x' })], [edge('t', 'out', 'm')])
    const res = await call('POST', '/api/flows', { name: 'wip', graph: g }, KEY)
    const b: any = await res.json()
    expect(res.status).toBe(201)
    expect(b.warnings.map((w: any) => w.msg)).toEqual(expect.arrayContaining(['message text is empty', 'not connected to the trigger']))
    const p = await pub(b.flow.id)
    expect(p.status).toBe(422)
    expect(((await p.json()) as any).errors.length).toBeGreaterThanOrEqual(2)
  })
  it('PUT edits the draft only; an active flow keeps running its published graph until republished', async () => {
    const id = await mk('live')
    await pub(id)
    const g2 = graph([trigger('lead_created'), note('changed')], [edge('t', 'out', 'n')])
    const res = await call('PUT', `/api/flows/${id}`, { graph: g2, name: 'live2', priority: 5, reentry: 'each_event' }, KEY)
    const b: any = await res.json()
    expect(res.status).toBe(200)
    expect(b.flow).toMatchObject({ name: 'live2', status: 'active', version: 1, priority: 5, reentry: 'each_event', unpublished_changes: true })
    expect(JSON.stringify(b.flow.published_graph)).not.toContain('changed')
    expect(JSON.stringify(b.flow.graph)).toContain('changed')
    expect((await call('PUT', `/api/flows/${id}`, {}, KEY)).status).toBe(400)
    expect((await call('PUT', '/api/flows/999', { name: 'x' }, KEY)).status).toBe(404)
    await mk('other')
    expect(((await (await call('PUT', `/api/flows/${id}`, { name: 'other' }, KEY)).json()) as any).error).toBe('name_taken')
    expect((await call('PUT', `/api/flows/${id}`, { graph: { nodes: 'x', connections: [] } }, KEY)).status).toBe(422)
  })
  it('a graph over 64 KB is a 422, a body over 256 KB a 413', async () => {
    const big = graph([trigger('lead_created'), note('x'.repeat(70_000))], [edge('t', 'out', 'n')])
    expect((await call('POST', '/api/flows', { name: 'big', graph: big }, KEY)).status).toBe(422)
    const req = new Request(`${ORIGIN}/api/flows`, { method: 'POST', headers: { Authorization: 'Bearer adminkey', 'content-length': String(300_000), 'content-type': 'application/json' }, body: '{}' })
    expect((await worker.fetch(req, env, ctx)).status).toBe(413)
  })
  it('GET /api/flows lists with run counts by outcome and a status filter; GET :id returns both graphs', async () => {
    const a = await mk('a'); const b = await mk('b')
    await pub(a)
    const run = await startRun(env, { id: a, name: 'a', status: 'active', shadow: 0, reentry: 'once', version: 1, graph: '', published_graph: q('SELECT published_graph g FROM flows WHERE id=?', a)[0].g }, { id: 1, contact_id: 1 }, { kind: 'lead_created', key: 1 })
    expect(run.started).toBe(true)
    const list: any = await (await call('GET', '/api/flows', undefined, as(staff))).json()
    const fa = list.flows.find((f: any) => f.id === a)
    expect(fa).toMatchObject({ status: 'active', runs_7d: 1, failed_7d: 0, active_runs: 0 })
    expect(fa.outcomes_7d).toMatchObject({ completed: 1, failed: 0 })
    expect(list.flows.find((f: any) => f.id === b)).toMatchObject({ status: 'draft', runs_7d: 0 })
    expect(list.flows.every((f: any) => !('graph' in f))).toBe(true)
    expect(((await (await call('GET', '/api/flows?status=draft', undefined, as(staff))).json()) as any).flows.map((f: any) => f.id)).toEqual([b])
    expect((await call('GET', '/api/flows?status=zzz', undefined, as(staff))).status).toBe(400)
    const one: any = await (await call('GET', `/api/flows/${a}`, undefined, as(staff))).json()
    expect(one.flow.published_graph.nodes).toHaveLength(2)
    expect(one.flow.graph.nodes).toHaveLength(2)
  })
  it('duplicate makes an unpublished shadow copy with a fresh name', async () => {
    const id = await mk('orig'); await pub(id)
    const d: any = await (await call('POST', `/api/flows/${id}/duplicate`, undefined, KEY)).json()
    expect(d.flow).toMatchObject({ name: 'orig copy', status: 'draft', version: 0, shadow: true, published_graph: null })
    expect(((await (await call('POST', `/api/flows/${id}/duplicate`, undefined, KEY)).json()) as any).flow.name).toBe('orig copy 2')
  })
})

describe('publish', () => {
  it('derives trigger_kind from the trigger node for every kind, sets active, bumps the version', async () => {
    for (const [i, kind] of (['lead_created', 'message_received', 'stage_changed'] as const).entries()) {
      const id = await mk(`k${i}`, simple(kind, kind === 'message_received' ? { match: 'keyword', keywords: ['price'] } : {}))
      const res = await pub(id)
      const b: any = await res.json()
      expect(res.status, kind).toBe(200)
      expect(b.flow).toMatchObject({ status: 'active', trigger_kind: kind, version: 1 })
      expect(b.flow.published_graph.nodes.find((n: any) => n.type === 'trigger').data.kind).toBe(kind)
      expect(b.flow.published_at).toBeGreaterThan(0)
      expect(b.warnings.map((w: any) => w.msg).join()).toMatch(/shadow mode is on/)
    }
    const id = await mk('v', simple('lead_created')); await pub(id)
    expect(((await (await pub(id)).json()) as any).flow.version).toBe(2)
  })
  it('re-entry comes from the trigger node when it sets one, else from the flow', async () => {
    const a = await mk('re1', simple('lead_created', { reentry: 'each_event' })); await pub(a)
    const b = await mk('re2', simple('lead_created')); await call('PUT', `/api/flows/${b}`, { reentry: 'each_event' }, KEY); await pub(b)
    const c = await mk('re3', simple('lead_created')); await pub(c)
    expect(q('SELECT id,reentry FROM flows ORDER BY id').map((r) => r.reentry)).toEqual(['each_event', 'each_event', 'once'])
  })
  it('a published flow actually starts runs from its derived kind (end to end through the trigger hook)', async () => {
    const id = await mk('go', simple('lead_created')); await call('PUT', `/api/flows/${id}`, { shadow: false }, KEY); await pub(id)
    expect(await dispatchLeadCreated(env, 1)).toBe(1)
    expect(q('SELECT flow_id,status,shadow FROM flow_runs')).toEqual([{ flow_id: id, status: 'completed', shadow: 0 }])
  })
  it('publish validation: 422 with per-node errors, nothing published', async () => {
    const g = graph([trigger('lead_created'), node('m', 'message', { text: '' })], [edge('t', 'out', 'm'), edge('m', 'out', 'ghost')])
    const id = await mk('p1', graph([trigger('lead_created'), note()], [edge('t', 'out', 'n')]))
    await call('PUT', `/api/flows/${id}`, { graph: graph([node('t', 'trigger', {}), note()], [edge('t', 'out', 'n')]) }, KEY)
    const res = await pub(id)
    const b: any = await res.json()
    expect(res.status).toBe(422)
    expect(b.errors.some((e: any) => e.node === 't' && /trigger kind/.test(e.msg))).toBe(true)
    expect(q('SELECT status,version,published_graph FROM flows WHERE id=?', id)[0]).toEqual({ status: 'draft', version: 0, published_graph: null })
    void g
  })
  it('publish needs an approved, sendable template with the right number of values', async () => {
    raw.prepare(`INSERT INTO templates (id,name,language,status,components,header_format,body_params_count,header_params_count,synced_at) VALUES ('tp1','order_update','en','PENDING',?,'NONE',2,0,1)`).run(JSON.stringify([{ type: 'BODY', text: 'Hi {{1}} {{2}}' }]))
    const g = (id: string, params: string[]) => graph([trigger('lead_created'), node('s', 'template', { templateId: id, bodyParams: params })], [edge('t', 'out', 's')])
    const a = await mk('t-a', g('tp1', ['a', 'b']))
    expect(((await (await pub(a)).json()) as any).errors[0]).toMatchObject({ node: 's', msg: expect.stringMatching(/pending/) })
    raw.exec(`UPDATE templates SET status='APPROVED'`)
    const wrong = await mk('t-b', g('tp1', ['a']))
    expect(((await (await pub(wrong)).json()) as any).errors[0].msg).toMatch(/needs 2 body values/)
    expect((await pub(a)).status).toBe(200)
    const missing = await mk('t-c', g('nope', ['a', 'b']))
    expect(((await (await pub(missing)).json()) as any).errors[0].msg).toMatch(/no longer exists/)
    // the same template on two nodes: the SECOND node's value count is checked too
    const two = graph([trigger('lead_created'), node('s', 'template', { templateId: 'tp1', bodyParams: ['a', 'b'] }), node('s2', 'template', { templateId: 'tp1', bodyParams: ['a'] })], [edge('t', 'out', 's'), edge('s', 'out', 's2')])
    const r2 = await pub(await mk('t-d', two))
    expect(r2.status).toBe(422)
    expect(((await r2.json()) as any).errors).toEqual([{ node: 's2', msg: expect.stringMatching(/needs 2 body values, the node has 1/) }])
  })
  it('an AI node needs the Anthropic key at publish', async () => {
    const g = graph([trigger('lead_created'), node('a', 'ai', { prompt: 'hi' })], [edge('t', 'out', 'a')])
    const id = await mk('ai', g)
    const res = await pub(id)
    expect(res.status).toBe(422)
    expect(((await res.json()) as any).errors[0]).toMatchObject({ node: 'a', msg: expect.stringMatching(/Anthropic key/) })
    await putSetting(env, 'anthropic_key_enc', await encryptJson(SECRET, { key: 'sk-ant-test-abcdefgh1234' }, 'whaleads/ai/v1'), null)
    // the key's encryption info string is the settings module's own; fall back to the settings route when it differs
    if ((await pub(id)).status !== 200) {
      await call('PATCH', '/api/settings', { anthropic_key: 'sk-ant-test-abcdefgh1234' }, as(admin))
      expect((await pub(id)).status).toBe(200)
    }
  })
  it('http_request targets pass the guard statically; templated hosts wait for run time; condition regex shapes are checked', async () => {
    const one = (data: Record<string, unknown>) => graph([trigger('lead_created'), node('h', 'http_request', data)], [edge('t', 'out', 'h')])
    const msgs = async (name: string, g: ReturnType<typeof graph>) => { const r = await pub(await mk(name, g)); return r.status === 200 ? [] : ((await r.json()) as any).errors.map((e: any) => e.msg as string) }
    expect((await msgs('h1', one({ url: 'http://169.254.169.254/latest' }))).join()).toMatch(/not allowed/)
    expect((await msgs('h2', one({ url: 'http://localhost:8787/x' }))).join()).toMatch(/not allowed/)
    expect((await msgs('h3', one({ url: 'ftp://example.com/x' }))).join()).toMatch(/not allowed/)
    expect((await msgs('h4', one({ url: '' }))).join()).toMatch(/enter a URL/)
    expect((await msgs('h5', one({ url: 'https://example.com/hook', method: 'TRACE' }))).join()).toMatch(/method/)
    expect(await msgs('h6', one({ url: 'https://example.com/{{lead.id}}' }))).toEqual([])
    const rx = (v: string) => graph([trigger('lead_created'), node('c', 'condition', { operator: 'regex', value: v }), note()], [edge('t', 'out', 'c'), edge('c', 'yes', 'n')])
    expect((await msgs('r1', rx('(a+)+$'))).join()).toMatch(/regex/)
    expect(await msgs('r2', rx('^order\\s+#\\d+'))).toEqual([])
  })
  it('an unknown delay unit is refused at save', async () => {
    const g = graph([trigger('lead_created'), node('d', 'delay', { duration: 5, unit: 'fortnights' }), note()], [edge('t', 'out', 'd'), edge('d', 'out', 'n')])
    const res = await call('POST', '/api/flows', { name: 'unit', graph: g }, KEY) // a bad unit is a hard error: not even a draft
    expect(res.status).toBe(422)
    expect(((await res.json()) as any).errors[0]).toMatchObject({ node: 'd', msg: expect.stringMatching(/unit must be/) })
  })
  it('publish, pause and archive emit flow.updated on the live channel', async () => {
    const id = await mk('live'); frames.length = 0
    await pub(id); await call('POST', `/api/flows/${id}/pause`, undefined, KEY); await call('POST', `/api/flows/${id}/archive`, undefined, KEY)
    expect(frames.filter((f) => f.type === 'flow.updated').map((f) => [f.data.flow_id, f.data.status])).toEqual([[id, 'active'], [id, 'paused'], [id, 'archived']])
  })
  it('an archived flow cannot be published or edited (409 flow_archived)', async () => {
    const id = await mk('arch'); await call('POST', `/api/flows/${id}/archive`, undefined, KEY)
    expect(((await (await pub(id)).json()) as any).error).toBe('flow_archived')
    expect((await call('PUT', `/api/flows/${id}`, { name: 'z' }, KEY)).status).toBe(409)
  })
})

describe('pause, archive, delete', () => {
  const waitFlow = () => graph([trigger('lead_created'), node('w', 'wait_event', { timeout: 1, timeoutUnit: 'hours' }), note()], [edge('t', 'out', 'w'), edge('w', 'completed', 'n'), edge('w', 'timeout', 'n')])
  async function live(name: string) {
    const id = await mk(name, waitFlow()); await call('PUT', `/api/flows/${id}`, { shadow: false, reentry: 'each_event' }, KEY); await pub(id)
    return id
  }
  it('pause: no new runs start; a parked run holds and resumes after the flow is published again', async () => {
    const id = await live('p')
    expect(await dispatchLeadCreated(env, 1)).toBe(1)
    expect(q('SELECT status FROM flow_runs')[0].status).toBe('awaiting')
    const res = await call('POST', `/api/flows/${id}/pause`, undefined, KEY)
    expect(((await res.json()) as any).flow.status).toBe('paused')
    raw.exec(`INSERT INTO leads (id,contact_id,source,status) VALUES (2,1,'whatsapp','new')`)
    expect(await dispatchLeadCreated(env, 2)).toBe(0) // no new runs while paused
    const later = Math.floor(Date.now() / 1000) + 7200
    expect((await tick(env, { now: later })).resumed).toBe(0) // the awaiting run holds
    expect(q('SELECT status FROM flow_runs')).toEqual([{ status: 'awaiting' }])
    expect((await pub(id)).status).toBe(200)
    expect((await tick(env, { now: later })).resumed).toBe(1) // back to active: the overdue timeout runs
    expect(q('SELECT status FROM flow_runs')).toEqual([{ status: 'completed' }])
    expect(((await (await call('POST', `/api/flows/${id}/pause`, undefined, KEY)).json()) as any).flow.status).toBe('paused')
    expect(((await (await call('POST', `/api/flows/${id}/pause`, undefined, KEY)).json()) as any).error).toBe('not_active')
    expect((await call('POST', '/api/flows/999/pause', undefined, KEY)).status).toBe(404)
  })
  it('pause refuses a draft (409 not_active)', async () => {
    const id = await mk('d')
    expect(((await (await call('POST', `/api/flows/${id}/pause`, undefined, KEY)).json()) as any).error).toBe('not_active')
  })
  it('archive cancels awaiting runs (with a timeline row each), keeps finished runs, and stops new ones', async () => {
    const id = await live('a')
    await dispatchLeadCreated(env, 1)
    raw.exec(`INSERT INTO flow_runs (flow_id,flow_version,lead_id,contact_id,status,trigger,snapshot,context,completed_at) VALUES (${id},1,1,1,'completed','lead_created','{}','{}',1)`)
    const res = await call('POST', `/api/flows/${id}/archive`, undefined, as(admin))
    expect(res.status).toBe(200)
    expect(q('SELECT status,error FROM flow_runs ORDER BY id')).toEqual([{ status: 'cancelled', error: 'flow_archived' }, { status: 'completed', error: null }])
    const act = q(`SELECT actor,data FROM activity WHERE kind='flow_run' AND json_extract(data,'$.status')='cancelled'`)
    expect(act).toHaveLength(1)
    expect(JSON.parse(act[0].data)).toMatchObject({ flow: 'a', status: 'cancelled', shadow: false })
    expect(act[0].actor).toMatch(/^staff:/)
    expect(await dispatchLeadCreated(env, 1)).toBe(0)
    expect(((await (await call('POST', `/api/flows/${id}/archive`, undefined, KEY)).json()) as any).error).toBe('flow_archived')
  })
  it('archive racing a step: a run that parks after the archive is cancelled, not left awaiting forever', async () => {
    const id = await live('race')
    await dispatchLeadCreated(env, 1)
    // simulate the in-flight step: the run is 'running' when the archive lands, then its step commits as awaiting
    raw.exec(`UPDATE flow_runs SET status='running', await_kind=NULL, resume_at=NULL WHERE flow_id=${id}`)
    await call('POST', `/api/flows/${id}/archive`, undefined, KEY)
    expect(q('SELECT status FROM flow_runs')).toEqual([{ status: 'running' }])
    const row = q('SELECT * FROM flow_runs')[0]
    const { executeStep } = await import('../src/flows/engine')
    const flow = JSON.parse(row.snapshot)
    await executeStep(env, row as any, flow, JSON.parse(row.context), [], { exec: 'w' } as any)
    expect(q('SELECT status,error FROM flow_runs')).toEqual([{ status: 'cancelled', error: 'flow_archived' }])
  })
  it('DELETE removes drafts only', async () => {
    const d = await mk('d'); const p = await mk('p'); await pub(p)
    expect((await call('DELETE', `/api/flows/${p}`, undefined, KEY)).status).toBe(409)
    expect(((await (await call('DELETE', `/api/flows/${p}`, undefined, KEY)).json()) as any).error).toBe('not_draft')
    expect((await call('DELETE', `/api/flows/${d}`, undefined, as(admin))).status).toBe(200)
    expect((await call('DELETE', `/api/flows/${d}`, undefined, KEY)).status).toBe(404)
    expect(q('SELECT id FROM flows').map((r) => r.id)).toEqual([p])
    await call('POST', `/api/flows/${p}/archive`, undefined, KEY)
    expect((await call('DELETE', `/api/flows/${p}`, undefined, KEY)).status).toBe(409)
  })
})

describe('dry-run', () => {
  const five = () => graph(
    [node('t', 'trigger', { kind: 'message_received', match: 'any' }), node('m', 'message', { text: 'Hi {{lead.name}}' }), node('a', 'action', { actionType: 'add_tag', tag: 'hot' }),
      node('h', 'http_request', { url: 'https://example.com/hook', method: 'POST', body: '{}' }), node('d', 'delay', { duration: 2, unit: 'days' }), node('w', 'action', { actionType: 'set_stage', stage: 'won' })],
    [edge('t', 'out', 'm'), edge('m', 'out', 'a'), edge('a', 'out', 'h'), edge('h', 'success', 'd'), edge('d', 'out', 'w')],
  )
  const snapshot = () => ['leads', 'contacts', 'messages', 'activity', 'lead_tags', 'flow_runs', 'flows', 'events', 'conversations'].map((t) => { try { return [t, JSON.stringify(q(`SELECT * FROM ${t}`))] } catch { return [t, ''] } })

  it('returns an ordered trace with would-send payloads; writes nothing and calls nothing', async () => {
    const id = await mk('dry', five())
    const before = snapshot()
    fetchCalls = 0
    const res = await call('POST', `/api/flows/${id}/dry-run`, { lead_id: 1 }, as(staff))
    const b: any = await res.json()
    expect(res.status).toBe(200)
    expect(b).toMatchObject({ ok: true, status: 'completed', error: null })
    expect(b.trace.map((t: any) => [t.node, t.port])).toEqual([['t', 'out'], ['m', 'out'], ['a', 'out'], ['h', 'success'], ['d', 'out'], ['w', 'out']])
    expect(b.context.nodes.m.output.would).toEqual({ text: 'Hi Asha Rao' })
    expect(b.context.nodes.h.output.would).toMatchObject({ method: 'POST', url: 'https://example.com/hook' })
    expect(b.context.nodes.d.output).toMatchObject({ skipped: true })
    expect(b.trace.find((t: any) => t.node === 'm').status).toBe('skipped')
    expect(fetchCalls).toBe(0)
    await settle()
    expect(snapshot().filter(([t], i) => t !== 'events' && true).map(([, v]) => v)).toEqual(before.filter(([t]) => t !== 'events').map(([, v]) => v))
    expect(frames.filter((f) => f.type === 'flow.run')).toHaveLength(0)
  })
  it('uses the draft graph, not the published one; the test event text feeds {{user_response}} and a reply feeds a wait', async () => {
    const g = graph([node('t', 'trigger', { kind: 'message_received', match: 'any' }), node('c', 'condition', { operator: 'contains', left: 'user_response', value: 'price' }), node('y', 'action', { actionType: 'note', text: 'yes' }), node('n', 'action', { actionType: 'note', text: 'no' })],
      [edge('t', 'out', 'c'), edge('c', 'yes', 'y'), edge('c', 'no', 'n')])
    const id = await mk('cond', g)
    const run = async (body: unknown) => ((await (await call('POST', `/api/flows/${id}/dry-run`, body, KEY)).json()) as any).trace.map((t: any) => t.node).join('')
    expect(await run({ lead_id: 1, event: { text: 'what is the PRICE' } })).toBe('tcy')
    expect(await run({ lead_id: 1, event: { text: 'hello' } })).toBe('tcn')
    const w = graph([trigger('lead_created'), node('w', 'wait_event', { timeout: 1, timeoutUnit: 'hours' }), node('y', 'action', { actionType: 'note', text: 'got' }), node('n', 'action', { actionType: 'note', text: 'late' })],
      [edge('t', 'out', 'w'), edge('w', 'completed', 'y'), edge('w', 'timeout', 'n')])
    await call('PUT', `/api/flows/${id}`, { graph: w }, KEY)
    expect(await run({ lead_id: 1 })).toBe('twn')
    expect(await run({ lead_id: 1, reply: 'ok thanks' })).toBe('twy')
  })
  it('a loop through a Delay is reported as a loop, not as a missing Delay', async () => {
    const g = graph([trigger('lead_created'), node('d', 'delay', { duration: 5, unit: 'minutes' }), node('a', 'action', { actionType: 'note', text: 'x' })], [edge('t', 'out', 'd'), edge('d', 'out', 'a'), edge('a', 'out', 'd')])
    const id = await mk('loop', g)
    const b: any = await (await call('POST', `/api/flows/${id}/dry-run`, { lead_id: 1 }, KEY)).json()
    expect(b.status).toBe('failed')
    expect(b.error).toBe('loop detected: this flow would run forever (dry-run stops at 50 nodes)')
  })
  it('errors: bad lead_id 400, unknown lead 404, unknown flow 404, invalid draft 422, rate limit 429', async () => {
    const id = await mk('e', five())
    expect((await call('POST', `/api/flows/${id}/dry-run`, {}, KEY)).status).toBe(400)
    expect((await call('POST', `/api/flows/${id}/dry-run`, { lead_id: 99 }, KEY)).status).toBe(404)
    expect((await call('POST', '/api/flows/999/dry-run', { lead_id: 1 }, KEY)).status).toBe(404)
    const broken = await mk('broken', graph([node('t', 'trigger', {})], []))
    const res = await call('POST', `/api/flows/${broken}/dry-run`, { lead_id: 1 }, KEY)
    expect(res.status).toBe(422)
    expect(((await res.json()) as any).errors[0]).toHaveProperty('msg')
    let last = 0
    for (let i = 0; i < 12; i++) last = (await call('POST', `/api/flows/${id}/dry-run`, { lead_id: 1 }, as(staff))).status
    expect(last).toBe(429)
    expect((await call('POST', `/api/flows/${id}/dry-run`, { lead_id: 1 }, as(admin))).status).toBe(200) // per staff member
  })
})

describe('runs and cancel', () => {
  async function seedRuns(flowId: number, n: number, status = 'completed') {
    for (let i = 0; i < n; i++) raw.prepare(`INSERT INTO flow_runs (flow_id,flow_version,lead_id,contact_id,status,trigger,snapshot,context,trace,started_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(flowId, 1, 1, 1, status, 'lead_created', '{"secret":"snap"}', '{}', '[{"node":"t"}]', 1000 + i)
  }
  it('GET /api/flows/:id/runs: newest first, cursor pages, status filter, no snapshot', async () => {
    const id = await mk('r'); await pub(id)
    await seedRuns(id, 7); await seedRuns(id, 2, 'failed')
    const p1: any = await (await call('GET', `/api/flows/${id}/runs?limit=4`, undefined, as(staff))).json()
    expect(p1.runs).toHaveLength(4)
    expect(p1.runs[0]).toMatchObject({ flow_id: id, flow_name: 'r', contact_name: 'Asha Rao', shadow: false })
    expect(p1.runs[0].id).toBeGreaterThan(p1.runs[1].id)
    expect(JSON.stringify(p1)).not.toContain('snap')
    const p2: any = await (await call('GET', `/api/flows/${id}/runs?limit=4&before=${p1.next_before}`, undefined, as(staff))).json()
    const p3: any = await (await call('GET', `/api/flows/${id}/runs?limit=4&before=${p2.next_before}`, undefined, as(staff))).json()
    expect([p2.runs.length, p3.runs.length, p3.next_before]).toEqual([4, 1, null])
    expect(new Set([...p1.runs, ...p2.runs, ...p3.runs].map((r: any) => r.id)).size).toBe(9)
    const f: any = await (await call('GET', `/api/flows/${id}/runs?status=failed`, undefined, as(staff))).json()
    expect(f.runs).toHaveLength(2)
    expect((await call('GET', `/api/flows/${id}/runs?status=zzz`, undefined, as(staff))).status).toBe(400)
    expect((await call('GET', `/api/flows/${id}/runs?before=abc`, undefined, as(staff))).status).toBe(400)
    expect((await call('GET', '/api/flows/999/runs', undefined, as(staff))).status).toBe(404)
  })
  it('GET /api/leads/:id/flow-runs reaches the flows handler (not swallowed by the CRM routes) and scopes to the lead', async () => {
    const id = await mk('lr'); await pub(id)
    raw.exec(`INSERT INTO leads (id,contact_id,source,status) VALUES (2,1,'whatsapp','new')`)
    await seedRuns(id, 3)
    raw.exec(`UPDATE flow_runs SET lead_id=2 WHERE id=3`)
    const r1: any = await (await call('GET', '/api/leads/1/flow-runs', undefined, as(staff))).json()
    const r2: any = await (await call('GET', '/api/leads/2/flow-runs', undefined, as(staff))).json()
    expect([r1.ok, r1.runs.length, r2.runs.length]).toEqual([true, 2, 1])
    expect(r1.runs[0].flow_name).toBe('lr')
    expect((await call('GET', '/api/leads/99/flow-runs', undefined, as(staff))).status).toBe(404)
  })
  it('GET /api/flow-runs/:id returns the trace and context', async () => {
    const id = await mk('rd'); await pub(id); await seedRuns(id, 1)
    const b: any = await (await call('GET', '/api/flow-runs/1', undefined, as(staff))).json()
    expect(b.run).toMatchObject({ id: 1, flow_name: 'rd', trace: [{ node: 't' }], context: {} })
    expect(b.run).not.toHaveProperty('snapshot')
    expect((await call('GET', '/api/flow-runs/99', undefined, as(staff))).status).toBe(404)
  })
  it('cancel: awaiting flips once (CAS), writes a timeline row, and the engine will not resume it', async () => {
    const wf = graph([trigger('lead_created'), node('w', 'wait_event', { timeout: 1, timeoutUnit: 'hours' }), note()], [edge('t', 'out', 'w'), edge('w', 'timeout', 'n')])
    const id = await mk('c', wf); await call('PUT', `/api/flows/${id}`, { shadow: false }, KEY); await pub(id)
    await dispatchLeadCreated(env, 1)
    const rid = q('SELECT id FROM flow_runs')[0].id
    expect((await call('POST', `/api/flow-runs/${rid}/cancel`, undefined, as(staff))).status).toBe(403)
    const res = await call('POST', `/api/flow-runs/${rid}/cancel`, undefined, as(admin))
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).run).toMatchObject({ status: 'cancelled', error: 'cancelled' })
    expect(JSON.parse(q(`SELECT data FROM activity WHERE kind='flow_run' ORDER BY id DESC`)[0].data)).toMatchObject({ status: 'cancelled', run_id: rid })
    expect(((await (await call('POST', `/api/flow-runs/${rid}/cancel`, undefined, KEY)).json()) as any).error).toBe('not_cancellable')
    expect(count('activity') > 0 && q(`SELECT 1 FROM activity WHERE kind='flow_run' AND json_extract(data,'$.status')='cancelled'`)).toHaveLength(1) // the 409 wrote no second row
    expect((await tick(env, { now: Math.floor(Date.now() / 1000) + 7200 })).resumed).toBe(0)
    expect(q('SELECT status FROM flow_runs')).toEqual([{ status: 'cancelled' }])
    expect((await call('POST', '/api/flow-runs/999/cancel', undefined, KEY)).status).toBe(404)
  })
  it('a finished run cannot be cancelled', async () => {
    const id = await mk('f'); await seedRuns(id, 1)
    expect(((await (await call('POST', '/api/flow-runs/1/cancel', undefined, KEY)).json()) as any).error).toBe('not_cancellable')
  })
})
