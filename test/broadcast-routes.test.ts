// The broadcasts API through the real worker: auth matrix, validation, audience resolution (D25), lifecycle, opt-out toggle,
// pace setting and route limits.
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'
import { ensureSchema, type Env } from '../src/db'
import { hashPassword } from '../src/password'
import { routeLimit } from '../src/routelimits'
import { fakeD1 } from './d1'

const SECRET = 'test-session-secret-0123456789'
const ORIGIN = 'https://leads.example.com'
const PASS = 'correct horse battery'
let env: Env
let raw: DatabaseSync
let waiting: Promise<unknown>[]
const ctx = { waitUntil: (p: Promise<unknown>) => { waiting.push(p) }, passThroughOnException: () => {} } as unknown as ExecutionContext
const settle = async () => { while (waiting.length) { const w = waiting; waiting = []; await Promise.allSettled(w) } }

type Opts = { cookie?: string; csrf?: string; bearer?: string }
const call = async (method: string, path: string, body?: unknown, o: Opts = {}) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (o.cookie) headers.Cookie = o.cookie
  if (o.csrf) headers['X-CSRF-Token'] = o.csrf
  if (o.bearer) headers.Authorization = `Bearer ${o.bearer}`
  if (method !== 'GET') headers.Origin = ORIGIN
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx)
  await settle()
  return res
}
type Sess = { cookie: string; csrf: string }
async function seed(email: string, role: 'admin' | 'staff'): Promise<Sess> {
  raw.prepare(`INSERT INTO staff (email,name,role,pw_hash) VALUES (?,?,?,?)`).run(email, `Test ${role}`, role, await hashPassword(PASS, 1000))
  const res = await call('POST', '/api/auth/login', { email, password: PASS })
  const body: any = await res.json()
  return { cookie: (res.headers.get('set-cookie') ?? '').split(';')[0]!, csrf: body.csrf }
}
const as = (s: Sess): Opts => ({ cookie: s.cookie, csrf: s.csrf })
let admin: Sess, staff: Sess
const KEY: Opts = { bearer: 'adminkey' }
const now = () => Math.floor(Date.now() / 1000)

const PARAMS = { body: [{ kind: 'field', field: 'contact.name', fallback: 'there' }] }
const draft = (o: Record<string, unknown> = {}) => ({ name: 'Diwali', template_id: 't1', params: PARAMS, filter: { tags: [1] }, ...o })
function tpl(id: string, category: string, status = 'APPROVED', comps: unknown[] = [{ type: 'BODY', text: 'Hi {{1}}' }]) {
  raw.prepare(`INSERT INTO templates (id,name,language,category,status,components,header_format,body_params_count,header_params_count,synced_at) VALUES (?,?,?,?,?,?,?,?,0,?)`)
    .run(id, `n_${id}`, 'en', category, status, JSON.stringify(comps), 'NONE', 1, now())
}
function person(id: number, o: { phone?: string | null; lead?: boolean; tag?: boolean; out?: boolean; name?: string } = {}) {
  const ph = o.phone === undefined ? `1666000${String(id).padStart(4, '0')}` : o.phone
  raw.prepare(`INSERT INTO contacts (id,wa_id,phone,name,opted_out_at,opt_out_source) VALUES (?,?,?,?,?,?)`).run(id, ph, ph, o.name ?? `P${id}`, o.out ? now() : null, o.out ? 'keyword' : null)
  if (o.lead !== false) {
    raw.prepare(`INSERT INTO leads (id,contact_id,source,status) VALUES (?,?,?,?)`).run(id, id, 'whatsapp', 'new')
    if (o.tag !== false) raw.prepare(`INSERT INTO lead_tags (lead_id,tag_id) VALUES (?,1)`).run(id)
  }
}
const q = <T = any>(sql: string, ...a: any[]) => raw.prepare(sql).all(...a) as T[]

beforeEach(async () => {
  const f = fakeD1(); raw = f.raw
  env = { DB: f.d1, ADMIN_KEY: 'adminkey', SESSION_SECRET: SECRET, INSTANCE_NAME: 'inst', ALLOWED_ORIGINS: '' } as unknown as Env
  waiting = []
  env.LIVE = { idFromName: (n: string) => n, get: () => ({ broadcast: async () => 1 }) } as any
  await ensureSchema(env.DB)
  raw.exec(`INSERT INTO tags (id,label,color) VALUES (1,'hot','#f00'),(2,'vip','#00f')`)
  tpl('t1', 'MARKETING')
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 200 }))
  admin = await seed('admin@example.com', 'admin'); staff = await seed('staff@example.com', 'staff')
})
afterEach(() => vi.unstubAllGlobals())

describe('auth matrix', () => {
  it('rejects the unauthenticated, lets all staff read, and keeps every write admin-only (the key acts as admin)', async () => {
    expect((await call('GET', '/api/broadcasts')).status).toBe(401)
    expect((await call('GET', '/api/broadcasts', undefined, as(staff))).status).toBe(200)
    expect((await call('GET', '/api/broadcasts', undefined, KEY)).status).toBe(200)
    const made = await call('POST', '/api/broadcasts', draft(), as(admin))
    expect(made.status).toBe(201)
    const id = ((await made.json()) as any).broadcast.id
    expect((await call('GET', `/api/broadcasts/${id}`, undefined, as(staff))).status).toBe(200)
    expect((await call('GET', `/api/broadcasts/${id}/recipients`, undefined, as(staff))).status).toBe(200)
    const writes: [string, string, unknown][] = [
      ['POST', '/api/broadcasts', draft()], ['POST', '/api/broadcasts/preview', draft()], ['PATCH', `/api/broadcasts/${id}`, { name: 'x' }],
      ['POST', `/api/broadcasts/${id}/start`, { total: 0 }], ['POST', `/api/broadcasts/${id}/pause`, {}], ['POST', `/api/broadcasts/${id}/resume`, {}],
      ['POST', `/api/broadcasts/${id}/cancel`, {}], ['POST', `/api/broadcasts/${id}/requeue-unknown`, {}], ['DELETE', `/api/broadcasts/${id}`, undefined],
    ]
    for (const [m, p, b] of writes) expect((await call(m, p, b, as(staff))).status, `${m} ${p}`).toBe(403)
    expect(q(`SELECT name FROM broadcasts`)).toEqual([{ name: 'Diwali' }])
    expect((await call('POST', '/api/broadcasts/preview', draft(), KEY)).status).toBe(200)
  })
  it('every broadcast route has a rate-limit row', () => {
    const id = 'bc_0123456789abcdef'
    for (const [m, p] of [['GET', '/api/broadcasts'], ['GET', `/api/broadcasts/${id}`], ['GET', `/api/broadcasts/${id}/recipients`], ['POST', '/api/broadcasts'],
      ['POST', '/api/broadcasts/preview'], ['PATCH', `/api/broadcasts/${id}`], ['DELETE', `/api/broadcasts/${id}`], ['POST', `/api/broadcasts/${id}/start`],
      ['POST', `/api/broadcasts/${id}/pause`], ['POST', `/api/broadcasts/${id}/resume`], ['POST', `/api/broadcasts/${id}/cancel`],
      ['POST', `/api/broadcasts/${id}/requeue-unknown`], ['PATCH', '/api/contacts/7/opt-out']] as const) expect(routeLimit(m, p), `${m} ${p}`).not.toBeNull()
  })
  it('returns 429 once the write budget is spent', async () => {
    const codes: number[] = []
    for (let i = 0; i < 31; i++) codes.push((await call('POST', '/api/broadcasts/preview', draft(), KEY)).status)
    expect(codes[29]).toBe(200)
    expect(codes[30]).toBe(429)
  })
})

describe('validation', () => {
  it('refuses authentication, unapproved and missing templates', async () => {
    tpl('auth1', 'AUTHENTICATION'); tpl('pend', 'MARKETING', 'PENDING')
    expect((await call('POST', '/api/broadcasts', draft({ template_id: 'auth1' }), KEY)).status).toBe(422)
    expect((await call('POST', '/api/broadcasts', draft({ template_id: 'pend' }), KEY)).status).toBe(422)
    expect((await call('POST', '/api/broadcasts', draft({ template_id: 'ghost' }), KEY)).status).toBe(404)
    expect(q(`SELECT COUNT(*) AS n FROM broadcasts`)[0].n).toBe(0)
  })
  it('refuses a wrong parameter count and a filter with neither tags, a stage nor the all-contacts flag', async () => {
    const bad = await call('POST', '/api/broadcasts', draft({ params: { body: [] } }), KEY)
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as any).field).toBe('params')
    const none = await call('POST', '/api/broadcasts', draft({ filter: {} }), KEY)
    expect(none.status).toBe(400)
    expect(((await none.json()) as any).field).toBe('filter')
    expect((await call('POST', '/api/broadcasts', draft({ filter: { stage: 'ghost' } }), KEY)).status).toBe(400)
  })
})

describe('audience (D25)', () => {
  it('preview without a template_id is counts only; a bad filter still fails', async () => {
    person(2); person(3)
    const j: any = await (await call('POST', '/api/broadcasts/preview', { filter: { all: true } }, KEY)).json()
    expect(j).toMatchObject({ ok: true, total: 2, sample: [], template: null })
    expect((await call('POST', '/api/broadcasts/preview', { filter: { stage: 'nope' } }, KEY)).status).toBe(400)
    expect((await call('POST', '/api/broadcasts/preview', { filter: {} }, KEY)).status).toBe(400)
  })
  it('sends one message per contact even when two leads match, and reports the exclusions separately', async () => {
    person(2); person(3)
    raw.prepare(`INSERT INTO leads (id,contact_id,source,status) VALUES (30,3,'whatsapp','new')`).run()
    raw.prepare(`INSERT INTO lead_tags (lead_id,tag_id) VALUES (30,1)`).run()
    person(4, { out: true })
    person(5, { phone: null })
    const res = await call('POST', '/api/broadcasts/preview', draft(), KEY)
    const j: any = await res.json()
    expect(j).toMatchObject({ ok: true, matched: 5, total: 2 })
    expect(j.excluded).toEqual({ opted_out: 1, no_phone: 1, duplicate: 1 })
    expect(j.excluded_total).toBe(3)
    expect(j.sample.length).toBeGreaterThan(0)
  })
  it('tag_mode all needs every tag; a stage narrows the match', async () => {
    person(2); person(3)
    raw.prepare(`INSERT INTO lead_tags (lead_id,tag_id) VALUES (2,2)`).run()
    raw.prepare(`UPDATE leads SET status='won' WHERE id=3`).run()
    const all: any = await (await call('POST', '/api/broadcasts/preview', draft({ filter: { tags: [1, 2], tag_mode: 'all' } }), KEY)).json()
    expect(all.total).toBe(1)
    const stage: any = await (await call('POST', '/api/broadcasts/preview', draft({ filter: { tags: [1], stage: 'won' } }), KEY)).json()
    expect(stage.total).toBe(1)
  })
  it('all contacts is allowed only with the explicit flag, and includes contacts with no lead', async () => {
    person(2); person(3, { lead: false })
    const j: any = await (await call('POST', '/api/broadcasts/preview', draft({ filter: { all: true } }), KEY)).json()
    expect(j.total).toBe(2)
  })
  it('a 10,000 contact audience resolves and previews in one call', async () => {
    raw.exec('BEGIN')
    const ic = raw.prepare(`INSERT INTO contacts (id,wa_id,phone,name) VALUES (?,?,?,?)`)
    const il = raw.prepare(`INSERT INTO leads (id,contact_id,source,status) VALUES (?,?,'whatsapp','new')`)
    const it_ = raw.prepare(`INSERT INTO lead_tags (lead_id,tag_id) VALUES (?,1)`)
    for (let i = 10; i < 10010; i++) { ic.run(i, `9170${i}`, `9170${i}`, `P${i}`); il.run(i, i); it_.run(i) }
    raw.exec('COMMIT')
    const t0 = Date.now()
    const j: any = await (await call('POST', '/api/broadcasts/preview', draft(), KEY)).json()
    expect(j.total).toBe(10000)
    expect(Date.now() - t0).toBeLessThan(5000)
  })
})

describe('lifecycle', () => {
  async function created(o: Record<string, unknown> = {}) {
    const j: any = await (await call('POST', '/api/broadcasts', draft(o), KEY)).json()
    return j.broadcast.id as string
  }
  it('start needs the previewed total; a stale total is a 409 with the new figures; an empty audience is 422', async () => {
    person(2); person(3)
    const id = await created()
    const stale = await call('POST', `/api/broadcasts/${id}/start`, { total: 99 }, KEY)
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ error: 'audience_changed', total: 2 })
    expect((await call('POST', `/api/broadcasts/${id}/start`, {}, KEY)).status).toBe(400)
    const ok: any = await (await call('POST', `/api/broadcasts/${id}/start`, { total: 2 }, KEY)).json()
    expect(ok.broadcast).toMatchObject({ status: 'queued', total: 2 })
    expect(q(`SELECT COUNT(*) AS n FROM broadcast_recipients WHERE broadcast_id=?`, id)[0].n).toBe(2)
    expect((await call('POST', `/api/broadcasts/${id}/start`, { total: 2 }, KEY)).status).toBe(409)
    const empty = await created({ name: 'None', filter: { tags: [2] } })
    const e = await call('POST', `/api/broadcasts/${empty}/start`, { total: 0 }, KEY)
    expect(e.status).toBe(422)
    expect(await e.json()).toMatchObject({ error: 'empty_audience' })
  })
  it('frozen values: the stored parameter is the contact name at start, not at send', async () => {
    person(2, { name: 'Before' })
    const id = await created()
    await call('POST', `/api/broadcasts/${id}/start`, { total: 1 }, KEY)
    raw.prepare(`UPDATE contacts SET name='After' WHERE id=2`).run()
    expect(q(`SELECT params FROM broadcast_recipients WHERE broadcast_id=?`, id)[0].params).toContain('Before')
  })
  it('list and detail carry a live count of recipients whose outcome is unknown', async () => {
    person(2); person(3); person(4)
    const id = await created()
    await call('POST', `/api/broadcasts/${id}/start`, { total: 3 }, KEY)
    const unk = async () => ({
      detail: ((await (await call('GET', `/api/broadcasts/${id}`, undefined, KEY)).json()) as any).broadcast.unknown,
      list: ((await (await call('GET', '/api/broadcasts', undefined, KEY)).json()) as any).broadcasts.find((b: any) => b.id === id).unknown,
    })
    expect(await unk()).toEqual({ detail: 0, list: 0 })
    raw.prepare(`UPDATE broadcast_recipients SET status='unknown' WHERE broadcast_id=? AND contact_id IN ('2','3')`).run(id)
    expect(await unk()).toEqual({ detail: 2, list: 2 })
  })
  it('pause, resume and cancel follow the state machine and bad moves are a 409', async () => {
    person(2)
    const id = await created()
    expect((await call('POST', `/api/broadcasts/${id}/pause`, {}, KEY)).status).toBe(409)
    await call('POST', `/api/broadcasts/${id}/start`, { total: 1 }, KEY)
    expect(((await (await call('POST', `/api/broadcasts/${id}/pause`, {}, KEY)).json()) as any).broadcast.status).toBe('paused')
    expect(((await (await call('POST', `/api/broadcasts/${id}/resume`, {}, KEY)).json()) as any).broadcast.status).toBe('queued')
    const c: any = await (await call('POST', `/api/broadcasts/${id}/cancel`, {}, KEY)).json()
    expect(c.broadcast.status).toBe('cancelled')
    expect(q(`SELECT status FROM broadcast_recipients WHERE broadcast_id=?`, id)).toEqual([{ status: 'skipped' }])
    expect((await call('POST', `/api/broadcasts/${id}/resume`, {}, KEY)).status).toBe(409)
  })
  it('only a draft can be edited or deleted; drafts can', async () => {
    person(2)
    const id = await created()
    const p: any = await (await call('PATCH', `/api/broadcasts/${id}`, { name: 'Renamed' }, KEY)).json()
    expect(p.broadcast.name).toBe('Renamed')
    await call('POST', `/api/broadcasts/${id}/start`, { total: 1 }, KEY)
    expect((await call('PATCH', `/api/broadcasts/${id}`, { name: 'No' }, KEY)).status).toBe(409)
    expect((await call('DELETE', `/api/broadcasts/${id}`, undefined, KEY)).status).toBe(409)
    const d = await created({ name: 'Drop' })
    expect((await call('DELETE', `/api/broadcasts/${d}`, undefined, KEY)).status).toBe(200)
    expect((await call('GET', `/api/broadcasts/${d}`, undefined, KEY)).status).toBe(404)
  })
  it('lists newest first with a cursor and pages the recipients with a status filter', async () => {
    for (let i = 2; i < 6; i++) person(i)
    const id = await created()
    await call('POST', `/api/broadcasts/${id}/start`, { total: 4 }, KEY)
    const list: any = await (await call('GET', '/api/broadcasts', undefined, as(staff))).json()
    expect(list.broadcasts.map((x: any) => x.id)).toContain(id)
    const r: any = await (await call('GET', `/api/broadcasts/${id}/recipients?status=queued`, undefined, as(staff))).json()
    expect(r.recipients).toHaveLength(4)
    expect(r.recipients[0]).toHaveProperty('name')
    const none: any = await (await call('GET', `/api/broadcasts/${id}/recipients?status=failed`, undefined, as(staff))).json()
    expect(none.recipients).toEqual([])
    expect((await call('GET', '/api/broadcasts/bc_ffffffffffffffff/recipients', undefined, as(staff))).status).toBe(404)
  })
})

describe('opt-out toggle and pace setting', () => {
  it('any staff member can opt a contact out and back in (source manual); the contact shows it', async () => {
    person(2)
    const off: any = await (await call('PATCH', '/api/contacts/2/opt-out', { opted_out: true }, as(staff))).json()
    expect(off).toMatchObject({ ok: true, opt_out_source: 'manual' })
    expect(off.opted_out_at).toBeTruthy()
    const on: any = await (await call('PATCH', '/api/contacts/2/opt-out', { opted_out: false }, as(staff))).json()
    expect(on.opted_out_at).toBeNull()
    expect((await call('PATCH', '/api/contacts/2/opt-out', { opted_out: 'yes' }, as(staff))).status).toBe(400)
    expect((await call('PATCH', '/api/contacts/999/opt-out', { opted_out: true }, as(staff))).status).toBe(404)
    expect((await call('PATCH', '/api/contacts/2/opt-out', { opted_out: true })).status).toBe(401)
  })
  it('the lead detail and the inbox thread carry the contact opt-out state', async () => {
    person(7, { out: true }); person(8)
    const lead: any = await (await call('GET', '/api/leads/7', undefined, as(staff))).json()
    expect(lead.lead).toMatchObject({ opt_out_source: 'keyword' })
    expect(lead.lead.opted_out_at).toBeGreaterThan(0)
    const other: any = await (await call('GET', '/api/leads/8', undefined, as(staff))).json()
    expect(other.lead).toMatchObject({ opted_out_at: null, opt_out_source: null })
    const th: any = await (await call('GET', '/api/contacts/7/messages', undefined, as(staff))).json()
    expect(th.contact).toMatchObject({ opt_out_source: 'keyword' })
    expect(th.contact.opted_out_at).toBeGreaterThan(0)
  })
  it('broadcast_per_minute is an integer from 1 to 40 and is returned with the settings', async () => {
    expect((await call('PATCH', '/api/settings', { broadcast_per_minute: 41 }, as(admin))).status).toBe(400)
    expect((await call('PATCH', '/api/settings', { broadcast_per_minute: 0 }, as(admin))).status).toBe(400)
    expect((await call('PATCH', '/api/settings', { broadcast_per_minute: 2.5 }, as(admin))).status).toBe(400)
    expect((await call('PATCH', '/api/settings', { broadcast_per_minute: 12 }, as(admin))).status).toBe(200)
    expect(((await (await call('GET', '/api/settings', undefined, as(admin))).json()) as any).settings.broadcast_per_minute).toBe(12)
    expect((await call('PATCH', '/api/settings', { broadcast_per_minute: null }, as(admin))).status).toBe(200)
    expect(((await (await call('GET', '/api/settings', undefined, as(admin))).json()) as any).settings.broadcast_per_minute).toBe(20)
  })
})
