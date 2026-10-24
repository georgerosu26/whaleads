import type { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import worker from '../src/index'
import { CloudApiAdaptor } from '../src/adaptors/cloud-api'
import { firstResponse } from '../src/conversations'
import { todayBuckets } from '../src/crm'
import { ensureSchema, type Env } from '../src/db'
import { processEvents } from '../src/inbound'
import { parseReferral, refCodeOf } from '../src/attribution'
import { startOfDay, startOfNextDay } from '../src/daytime'
import { clearSettingsCache } from '../src/settings'
import { fixture } from './helpers'
import { fakeD1 } from './d1'

const SECRET = 'test-session-secret-0123456789'
const ORIGIN = 'https://leads.example.com'
const KEY = 'adminkey'

let env: Env
let raw: DatabaseSync
const ctx = { waitUntil: (_p: Promise<unknown>) => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

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
const send = async (method: string, path: string, body?: unknown, o?: Opts) => { const r = await call(method, path, body, o); return { status: r.status, body: (await r.json()) as any } }
const q = <T = any>(sql: string, ...a: any[]) => raw.prepare(sql).get(...a) as T
const rows = <T = any>(sql: string, ...a: any[]) => raw.prepare(sql).all(...a) as T[]
const cloud = new CloudApiAdaptor({ system_token: 't', app_secret: 'appsecret', phone_number_id: '1', waba_id: '2' })
const acts = (leadId: number) => rows<{ kind: string; data: string | null; actor: string }>(`SELECT kind,data,actor FROM activity WHERE lead_id=? ORDER BY id`, leadId)

async function sessionFor() {
  const res = await worker.fetch(new Request(`${ORIGIN}/api/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ setup_key: SECRET, business_name: 'Example Co', default_country: 'US', timezone: 'UTC', admin: { name: 'Test Admin', email: 'admin@example.com', password: 'a-long-test-passphrase-1' } }),
  }), env, ctx)
  const body: any = await res.json()
  return { cookie: (res.headers.get('set-cookie') ?? '').split(';')[0], csrf: body.csrf as string }
}

let nextContact = 100
/** A contact + lead straight into the DB. */
function seedLead(o: { name?: string; status?: string; at?: number; next?: number | null; source?: string; owner?: number | null } = {}) {
  const id = nextContact++
  raw.prepare(`INSERT INTO contacts (id,wa_id,phone,name) VALUES (?,?,?,?)`).run(id, `1555000${id}`, `1555000${id}`, o.name ?? `Person ${id}`)
  const r = raw.prepare(`INSERT INTO leads (contact_id,source,status,created_at,updated_at,next_action_at,assigned_to) VALUES (?,?,?,?,?,?,?)`)
    .run(id, o.source ?? 'whatsapp', o.status ?? 'new', o.at ?? 1_760_000_000, o.at ?? 1_760_000_000, o.next ?? null, o.owner ?? null)
  return { contact: id, lead: Number(r.lastInsertRowid) }
}

function hook(file: string, over: (m: any, v: any) => void) {
  const f = fixture(file)
  const v = f.entry[0].changes[0].value
  over(v.messages[0], v)
  return f
}
const feed = (h: unknown) => processEvents(env, ctx, cloud.parseWebhook(JSON.stringify(h)))

beforeEach(async () => {
  const f = fakeD1(); raw = f.raw
  env = { DB: f.d1, ADMIN_KEY: KEY, SESSION_SECRET: SECRET, INSTANCE_NAME: 'inst', ALLOWED_ORIGINS: '', META_APP_SECRET: 'appsecret' } as unknown as Env
  await ensureSchema(f.d1)
  nextContact = 100
})

describe('gate rules', () => {
  const routes: [string, string][] = [['GET', '/api/leads'], ['GET', '/api/leads/board'], ['GET', '/api/today'], ['GET', '/api/contacts'], ['GET', '/api/leads/owners']]
  it('401 without credentials', async () => {
    for (const [m, p] of routes) expect((await call(m, p, undefined, { bearer: null })).status, p).toBe(401)
    expect((await call('POST', '/api/leads/manual', { phone: '+15550000101' }, { bearer: null })).status).toBe(401)
  })
  it('403 on a session write without CSRF, 200 with it, 200 for the bearer', async () => {
    const s = await sessionFor()
    for (const [m, p] of routes) expect((await call(m, p, undefined, { cookie: s.cookie })).status, p).toBe(200)
    const noCsrf = await call('POST', '/api/leads/manual', { phone: '+15550000101' }, { cookie: s.cookie })
    expect(noCsrf.status).toBe(403)
    const ok = await call('POST', '/api/leads/manual', { phone: '+15550000101' }, { cookie: s.cookie, csrf: s.csrf })
    expect(ok.status).toBe(201)
    for (const [m, p] of routes) expect((await call(m, p)).status, p).toBe(200)
  })
  it('the public intake POST /api/leads is untouched', async () => {
    const r = await call('POST', '/api/leads', { phone: '+15550000102', name: 'Form Person' }, { bearer: null })
    expect(r.status).not.toBe(401)
  })
})

describe('manual lead', () => {
  it('inserts source=manual (post-v4) with contact, lead_created activity, tags, owner and next action', async () => {
    const owner = q<{ id: number }>(`SELECT id FROM staff LIMIT 1`)?.id ?? null
    raw.prepare(`INSERT INTO tags (label) VALUES ('vip')`).run()
    const tag = q<{ id: number }>(`SELECT id FROM tags WHERE label='vip'`).id
    const r = await send('POST', '/api/leads/manual', { name: 'Asha Example', phone: '+1 555 000 0101', email: 'asha@example.com', message: 'wants a demo', next_action_at: 1_800_000_000, tag_ids: [tag] })
    expect(r.status).toBe(201)
    const lead = q(`SELECT * FROM leads WHERE id=?`, r.body.id)
    expect(lead).toMatchObject({ source: 'manual', status: 'new', message: 'wants a demo', next_action_at: 1_800_000_000 })
    expect(q(`SELECT wa_id,phone,name,email FROM contacts WHERE id=?`, lead.contact_id)).toMatchObject({ wa_id: '15550000101', name: 'Asha Example', email: 'asha@example.com' })
    expect(acts(r.body.id).map((a) => a.kind)).toEqual(['lead_created', 'next_action', 'tag_added'])
    expect(owner).toBeNull() // no staff yet with the bearer-only env
  })
  it('reads a national number with the default country, rejects junk, unknown source, and an existing open lead', async () => {
    raw.prepare(`UPDATE sqlite_sequence SET seq=seq`).run()
    raw.prepare(`INSERT INTO settings (key,value) VALUES ('default_country','"US"')`).run(); clearSettingsCache(env.DB)
    expect((await send('POST', '/api/leads/manual', { phone: '2025550123' })).status).toBe(201)
    expect(q(`SELECT wa_id FROM contacts ORDER BY id DESC LIMIT 1`).wa_id).toBe('12025550123')
    const bad = await send('POST', '/api/leads/manual', { phone: 'abc' })
    expect(bad.status).toBe(400); expect(bad.body.field).toBe('phone')
    const src = await send('POST', '/api/leads/manual', { phone: '+15550000103', source: 'nope' })
    expect(src.status).toBe(400); expect(src.body.field).toBe('source')
    const dup = await send('POST', '/api/leads/manual', { phone: '2025550123' })
    expect(dup.status).toBe(409); expect(dup.body.error).toBe('open_lead_exists'); expect(dup.body.lead_id).toBeGreaterThan(0)
  })
  it('a won or lost contact can get a fresh manual lead', async () => {
    const { contact, lead } = seedLead({ status: 'won' })
    raw.prepare(`UPDATE contacts SET wa_id='15550000199', phone='15550000199' WHERE id=?`).run(contact)
    const phone = '+15550000199'
    const r = await send('POST', '/api/leads/manual', { phone })
    expect(r.status).toBe(201)
    expect(r.body.id).not.toBe(lead)
  })
})

describe('stage validation, won/lost timestamps and activity', () => {
  it('rejects an unknown or archived stage', async () => {
    const { lead } = seedLead()
    const unknown = await send('PATCH', `/api/leads/${lead}`, { status: 'nope' })
    expect(unknown.status).toBe(400); expect(unknown.body.field).toBe('status')
    raw.prepare(`UPDATE stages SET archived=1 WHERE key='contacted'`).run()
    expect((await send('PATCH', `/api/leads/${lead}`, { status: 'contacted' })).status).toBe(400)
    expect(q(`SELECT status FROM leads WHERE id=?`, lead).status).toBe('new')
    expect((await send('PATCH', `/api/leads/9999`, { status: 'won' })).status).toBe(404)
  })
  it('won sets won_at and closed_at; lost sets closed_at and the reason; reopening clears all three', async () => {
    const { lead } = seedLead()
    expect((await send('PATCH', `/api/leads/${lead}`, { status: 'qualified' })).status).toBe(200)
    expect(q(`SELECT won_at,closed_at FROM leads WHERE id=?`, lead)).toMatchObject({ won_at: null, closed_at: null })
    await send('PATCH', `/api/leads/${lead}`, { status: 'won' })
    const won = q(`SELECT won_at,closed_at,lost_reason FROM leads WHERE id=?`, lead)
    expect(won.won_at).toBeGreaterThan(0); expect(won.closed_at).toBe(won.won_at); expect(won.lost_reason).toBeNull()
    await send('PATCH', `/api/leads/${lead}`, { status: 'lost', lost_reason: 'Too expensive' })
    const lost = q(`SELECT won_at,closed_at,lost_reason FROM leads WHERE id=?`, lead)
    expect(lost.won_at).toBeNull(); expect(lost.closed_at).toBeGreaterThan(0); expect(lost.lost_reason).toBe('Too expensive')
    await send('PATCH', `/api/leads/${lead}`, { status: 'new' })
    expect(q(`SELECT won_at,closed_at,lost_reason FROM leads WHERE id=?`, lead)).toMatchObject({ won_at: null, closed_at: null, lost_reason: null })
    const kinds = acts(lead).map((a) => JSON.parse(a.data!))
    expect(kinds[kinds.length - 1]).toMatchObject({ from: 'lost', to: 'new', reopened: true })
  })
  it('lost_reason is refused unless the move is to a lost stage', async () => {
    const { lead } = seedLead()
    const r = await send('PATCH', `/api/leads/${lead}`, { status: 'contacted', lost_reason: 'x' })
    expect(r.status).toBe(400); expect(r.body.field).toBe('lost_reason')
    expect((await send('PATCH', `/api/leads/${lead}`, { lost_reason: 'x' })).status).toBe(400)
  })
  it('writes one activity row per changed field and none for a no-op', async () => {
    const s = await sessionFor()
    const o = { cookie: s.cookie, csrf: s.csrf }
    const me = q(`SELECT id FROM staff LIMIT 1`).id
    const { lead } = seedLead()
    const r = await send('PATCH', `/api/leads/${lead}`, { status: 'contacted', assigned_to: me, next_action_at: 1_800_000_000 }, o)
    expect(r.body.changed).toEqual(['stage_changed', 'assigned', 'next_action'])
    expect(acts(lead).map((a) => a.kind)).toEqual(['stage_changed', 'assigned', 'next_action'])
    expect(acts(lead)[0].actor).toBe(`staff:${me}`)
    const again = await send('PATCH', `/api/leads/${lead}`, { status: 'contacted', assigned_to: me, next_action_at: 1_800_000_000 }, o)
    expect(again.status).toBe(200); expect(again.body.changed).toEqual([])
    expect(acts(lead)).toHaveLength(3)
    await send('PATCH', `/api/leads/${lead}`, { assigned_to: null, next_action_at: null }, o)
    expect(acts(lead).map((a) => a.kind).slice(3)).toEqual(['assigned', 'next_action'])
    expect((await send('PATCH', `/api/leads/${lead}`, { assigned_to: 9999 }, o)).status).toBe(400)
    expect((await send('PATCH', `/api/leads/${lead}`, { next_action_at: 'soon' }, o)).status).toBe(400)
    expect((await send('PATCH', `/api/leads/${lead}`, {}, o)).status).toBe(400)
    expect(q(`SELECT last_activity_at FROM leads WHERE id=?`, lead).last_activity_at).toBeGreaterThan(0)
  })
  it('notes, calls and tags each leave an activity row; notes list back', async () => {
    const { lead } = seedLead()
    raw.prepare(`INSERT INTO tags (label,color) VALUES ('hot','coral'),('cold','blue')`).run()
    const [hot, cold] = rows<{ id: number }>(`SELECT id FROM tags ORDER BY id`).map((t) => t.id)
    expect((await send('POST', `/api/leads/${lead}/notes`, { text: '  called, will ring back  ' })).status).toBe(201)
    expect((await send('POST', `/api/leads/${lead}/notes`, { text: '   ' })).status).toBe(400)
    expect((await send('POST', `/api/leads/${lead}/calls`, { outcome: 'no_answer', duration_s: 0 })).status).toBe(201)
    expect((await send('POST', `/api/leads/${lead}/calls`, { outcome: 'teleported' })).status).toBe(400)
    const put = await send('PUT', `/api/leads/${lead}/tags`, { tag_ids: [hot, cold] })
    expect(put.body.tags.map((t: any) => t.label)).toEqual(['cold', 'hot'])
    await send('PUT', `/api/leads/${lead}/tags`, { tag_ids: [hot] })
    expect((await send('PUT', `/api/leads/${lead}/tags`, { tag_ids: [999] })).status).toBe(400)
    expect(acts(lead).map((a) => a.kind)).toEqual(['note', 'call', 'tag_added', 'tag_added', 'tag_removed'])
    const notes = await get(`/api/leads/${lead}/notes`)
    expect(notes.notes).toHaveLength(1); expect(notes.notes[0].text).toBe('called, will ring back')
    const detail = await get(`/api/leads/${lead}`)
    expect(detail.lead.tags.map((t: any) => t.label)).toEqual(['hot'])
    expect(detail.activity[0].kind).toBe('tag_removed')
    expect(detail.activity.find((a: any) => a.kind === 'call').data).toMatchObject({ outcome: 'no_answer', duration_s: 0 })
    expect(detail.messages_url).toBe(`/api/contacts/${detail.lead.contact_id}/messages`)
  })
})

describe('click-to-WhatsApp referral', () => {
  it('parses the Meta referral object, bounded, and a reference code', () => {
    const r = parseReferral(fixture('ctwa').entry[0].changes[0].value.messages[0], 'x')!
    expect(r.fromAd).toBe(true)
    expect(r.ctwa_clid).toBe('AfZexample_clid_0001'); expect(r.ad_source_id).toBe('120210000000001')
    expect(Object.keys(r.attribution).sort()).toEqual(['body', 'ctwa_clid', 'headline', 'media_type', 'source_id', 'source_type', 'source_url'])
    expect(parseReferral({ referral: { headline: 'x'.repeat(900) } }, null)!.attribution.headline).toHaveLength(500)
    expect(parseReferral({}, 'hello')).toBeNull()
    expect(parseReferral({ referral: 'junk' }, 'hello')).toBeNull()
    expect(refCodeOf('Hi ref:SPRING-24 thanks')).toBe('SPRING-24')
    expect(refCodeOf('reference: none')).toBeNull()
    expect(refCodeOf('xref:abc')).toBeNull()
  })
  it('a new contact from an ad gets a ctwa lead with attribution columns and a referral activity row', async () => {
    const res = await feed(fixture('ctwa'))
    expect(res.messages).toBe(1)
    const lead = q(`SELECT * FROM leads`)
    expect(lead).toMatchObject({ source: 'ctwa', status: 'new', ctwa_clid: 'AfZexample_clid_0001', ad_source_id: '120210000000001' })
    expect(JSON.parse(lead.attribution)).toMatchObject({ source_url: 'https://example.com/ads/spring-sale', headline: 'Spring sale', source_type: 'ad' })
    expect(rows(`SELECT COUNT(*) n FROM leads`)[0].n).toBe(1)
    expect(acts(lead.id).map((a) => a.kind)).toEqual(['referral'])
    // replay of the same wamid changes nothing
    await feed(fixture('ctwa'))
    expect(rows(`SELECT COUNT(*) n FROM leads`)[0].n).toBe(1)
    expect(acts(lead.id)).toHaveLength(1)
  })
  it('a second referral on an open lead adds an activity row only', async () => {
    await feed(fixture('ctwa'))
    const first = q(`SELECT * FROM leads`)
    await feed(hook('ctwa', (m) => { m.id = 'wamid.CTWA0002'; m.referral = { source_id: '999', source_type: 'ad', headline: 'Other ad', ctwa_clid: 'clid-2' } }))
    expect(rows(`SELECT COUNT(*) n FROM leads`)[0].n).toBe(1)
    const after = q(`SELECT * FROM leads`)
    expect(after.attribution).toBe(first.attribution); expect(after.ctwa_clid).toBe('AfZexample_clid_0001'); expect(after.source).toBe('ctwa')
    expect(acts(first.id).map((a) => a.kind)).toEqual(['referral', 'referral'])
    expect(JSON.parse(acts(first.id)[1].data!)).toMatchObject({ headline: 'Other ad', wamid: 'wamid.CTWA0002' })
  })
  it('an existing lead without attribution gets it filled once', async () => {
    await feed(hook('text', (m, v) => { m.from = '15550000077'; m.id = 'wamid.PLAIN1'; m.text = { body: 'hello' }; v.contacts[0].wa_id = '15550000077' }))
    const plain = q(`SELECT * FROM leads`)
    expect(plain).toMatchObject({ source: 'whatsapp', attribution: null })
    await feed(fixture('ctwa'))
    expect(rows(`SELECT COUNT(*) n FROM leads`)[0].n).toBe(1)
    const l = q(`SELECT * FROM leads`)
    expect(l.source).toBe('whatsapp'); expect(l.ctwa_clid).toBe('AfZexample_clid_0001'); expect(l.attribution).not.toBeNull()
    expect(acts(l.id).map((a) => a.kind)).toEqual(['referral'])
  })
  it('an ad click after a won lead starts a fresh ctwa lead', async () => {
    const { contact, lead } = seedLead({ status: 'won' })
    await feed(hook('ctwa', (m, v) => { m.from = `1555000${contact}`; v.contacts[0].wa_id = `1555000${contact}` }))
    const all = rows(`SELECT id,source,status FROM leads ORDER BY id`)
    expect(all).toHaveLength(2)
    expect(all[1]).toMatchObject({ source: 'ctwa', status: 'new' })
    expect(q(`SELECT attribution FROM leads WHERE id=?`, lead).attribution).toBeNull()
  })
  it('a typed reference code never creates a lead; it attributes an existing one and adds an activity row', async () => {
    const { contact } = seedLead({ source: 'whatsapp', at: Math.floor(Date.now() / 1000) })
    await feed(hook('text', (m, v) => { m.from = `1555000${contact}`; m.id = 'wamid.REF1'; m.text = { body: 'Hi ref:SPRING-24' }; v.contacts[0].wa_id = `1555000${contact}` }))
    const l = q(`SELECT * FROM leads`)
    expect(l.source).toBe('whatsapp'); expect(l.ctwa_clid).toBeNull()
    expect(JSON.parse(l.attribution)).toEqual({ ref_code: 'SPRING-24' })
    expect(acts(l.id).map((a) => a.kind)).toEqual(['referral'])
  })
  it('a typed code after a lost lead does not open a new lead (30-day rule)', async () => {
    const { contact } = seedLead({ status: 'lost', at: Math.floor(Date.now() / 1000) - 86400 })
    await feed(hook('text', (m, v) => { m.from = `1555000${contact}`; m.id = 'wamid.REFZ'; m.text = { body: 'ref:zz' }; v.contacts[0].wa_id = `1555000${contact}` }))
    expect(rows(`SELECT COUNT(*) n FROM leads`)[0].n).toBe(1)
  })
})

describe('first_response_at', () => {
  it('is set by the first outbound once the customer has written in, and only once', async () => {
    await feed(hook('text', (m, v) => { m.timestamp = String(Math.floor(Date.now() / 1000)); m.from = '15550000066'; m.id = 'wamid.FR1'; m.text = { body: 'hi' }; v.contacts[0].wa_id = '15550000066' }))
    const { id, contact_id } = q(`SELECT id,contact_id FROM leads`)
    expect(q(`SELECT first_response_at f FROM leads WHERE id=?`, id).f).toBeNull()
    await env.DB.batch([firstResponse(env.DB, contact_id)])
    const first = q(`SELECT first_response_at f FROM leads WHERE id=?`, id).f
    expect(first).toBeGreaterThan(0)
    raw.prepare(`UPDATE leads SET first_response_at=5 WHERE id=?`).run(id)
    await env.DB.batch([firstResponse(env.DB, contact_id)])
    expect(q(`SELECT first_response_at f FROM leads WHERE id=?`, id).f).toBe(5)
  })
  it('is not set when staff message a contact who never wrote in (outbound first)', async () => {
    const { contact, lead } = seedLead({ source: 'manual' })
    await env.DB.batch([firstResponse(env.DB, contact)])
    expect(q(`SELECT first_response_at f FROM leads WHERE id=?`, lead).f).toBeNull()
  })
})

describe('Today buckets in the instance timezone', () => {
  // 2026-10-19 19:00 UTC is 2026-10-20 00:30 in Asia/Kolkata (UTC+5:30).
  const NOW = Date.UTC(2026, 9, 19, 19, 0) / 1000
  const A = Date.UTC(2026, 9, 19, 10, 0) / 1000 // UTC today; IST yesterday-of-now, i.e. overdue
  const B = Date.UTC(2026, 9, 20, 1, 0) / 1000 // UTC tomorrow; IST today
  const setTz = (tz: string) => { raw.prepare(`INSERT OR REPLACE INTO settings (key,value) VALUES ('timezone',?)`).run(JSON.stringify(tz)); clearSettingsCache(env.DB) }
  const ids = (xs: any[]) => xs.map((x) => x.name).sort()

  it('day boundaries', () => {
    expect(startOfDay(NOW, 'UTC')).toBe(Date.UTC(2026, 9, 19) / 1000)
    expect(startOfDay(NOW, 'Asia/Kolkata')).toBe(Date.UTC(2026, 9, 19, 18, 30) / 1000)
    expect(startOfNextDay(NOW, 'Asia/Kolkata')).toBe(Date.UTC(2026, 9, 20, 18, 30) / 1000)
    // a 25 hour day (US fall back, 2026-11-01) and a 23 hour day (spring forward, 2026-03-08)
    const fall = Date.UTC(2026, 10, 1, 12, 0) / 1000
    expect(startOfNextDay(fall, 'America/New_York') - startOfDay(fall, 'America/New_York')).toBe(25 * 3600)
    const spring = Date.UTC(2026, 2, 8, 18, 0) / 1000
    expect(startOfNextDay(spring, 'America/New_York') - startOfDay(spring, 'America/New_York')).toBe(23 * 3600)
  })
  it('UTC: A is due today, B is not in any bucket', async () => {
    setTz('UTC')
    seedLead({ name: 'A', status: 'contacted', next: A }); seedLead({ name: 'B', status: 'contacted', next: B })
    const t = await todayBuckets(env, NOW)
    expect(t.timezone).toBe('UTC')
    expect(ids(t.due_today)).toEqual(['A']); expect(ids(t.overdue)).toEqual([])
  })
  it('Asia/Kolkata: A is overdue, B is due today', async () => {
    setTz('Asia/Kolkata')
    seedLead({ name: 'A', status: 'contacted', next: A }); seedLead({ name: 'B', status: 'contacted', next: B })
    const t = await todayBuckets(env, NOW)
    expect(t.timezone).toBe('Asia/Kolkata')
    expect(ids(t.overdue)).toEqual(['A']); expect(ids(t.due_today)).toEqual(['B'])
    expect(t.counts).toMatchObject({ overdue: 1, due_today: 1 })
  })
  it('an invalid timezone falls back to UTC; closed leads never appear', async () => {
    setTz('Mars/Olympus')
    seedLead({ name: 'Done', status: 'won', next: A })
    const t = await todayBuckets(env, NOW)
    expect(t.timezone).toBe('UTC'); expect(t.due_today).toEqual([])
  })
  it('new = untouched leads in the entry stage; unanswered = open conversations whose last message is the customer\'s', async () => {
    seedLead({ name: 'Fresh', status: 'new' }); seedLead({ name: 'Moved', status: 'contacted' })
    const u = seedLead({ name: 'Waiting' }); const a = seedLead({ name: 'Answered' }); const c = seedLead({ name: 'Closed' })
    const conv = (cid: number, last: number, inb: number | null, status = 'open') =>
      raw.prepare(`INSERT INTO conversations (contact_id,last_message_at,last_inbound_at,last_preview,unread_count,status) VALUES (?,?,?,?,1,?)`).run(cid, last, inb, 'hi', status)
    conv(u.contact, 1000, 1000); conv(a.contact, 2000, 1500); conv(c.contact, 3000, 3000, 'closed')
    const t = await todayBuckets(env, NOW)
    expect(ids(t.new)).toEqual(['Answered', 'Closed', 'Fresh', 'Waiting'])
    expect(t.unanswered.map((x: any) => x.name)).toEqual(['Waiting'])
    expect(t.counts.unanswered).toBe(1)
    const api = await get('/api/today')
    expect(api.ok).toBe(true); expect(api.counts.new).toBe(4)
  })
})

describe('lists, cursors and contacts', () => {
  it('filters by stage, source, owner, tag and search; unknown values are 400', async () => {
    const me = null
    const a = seedLead({ name: 'Alpha', status: 'contacted', source: 'ctwa' }); seedLead({ name: 'Beta', status: 'new' })
    raw.prepare(`INSERT INTO tags (label) VALUES ('hot')`).run()
    raw.prepare(`INSERT INTO lead_tags (lead_id,tag_id) VALUES (?,1)`).run(a.lead)
    expect((await get('/api/leads?stage=contacted')).leads.map((l: any) => l.name)).toEqual(['Alpha'])
    expect((await get('/api/leads?source=ctwa')).leads).toHaveLength(1)
    expect((await get('/api/leads?tag=1')).leads[0].tags[0].label).toBe('hot')
    expect((await get('/api/leads?owner=none')).leads).toHaveLength(2)
    expect((await get('/api/leads?q=bet')).leads.map((l: any) => l.name)).toEqual(['Beta'])
    expect((await get('/api/leads?kind=open')).leads).toHaveLength(2)
    expect((await call('GET', '/api/leads?stage=zzz')).status).toBe(400)
    expect((await call('GET', '/api/leads?owner=abc')).status).toBe(400)
    expect((await call('GET', '/api/leads?kind=weird')).status).toBe(400)
    expect(me).toBeNull()
  })
  it('pages with a cursor and rejects a tampered one with 400', async () => {
    for (let i = 0; i < 5; i++) seedLead({ name: `L${i}`, at: 1_760_000_000 + (i >> 1) }) // equal timestamps exercise the id tiebreak
    const p1 = await get('/api/leads?limit=2')
    expect(p1.leads).toHaveLength(2); expect(p1.next_before).toMatch(/^\d+\.\d+$/)
    const p2 = await get(`/api/leads?limit=2&before=${p1.next_before}`)
    const p3 = await get(`/api/leads?limit=2&before=${p2.next_before}`)
    const seen = [...p1.leads, ...p2.leads, ...p3.leads].map((l: any) => l.name)
    expect(seen).toHaveLength(5); expect(new Set(seen).size).toBe(5); expect(p3.next_before).toBeNull()
    for (const bad of ['abc', '1.2.3', '12.x', '-1.5', "1.2'; drop table leads;--"]) {
      const r = await call('GET', `/api/leads?before=${encodeURIComponent(bad)}`)
      expect(r.status, bad).toBe(400)
      expect(((await r.json()) as any).error).toBe('bad cursor')
    }
    expect((await call('GET', '/api/contacts?before=oops')).status).toBe(400)
  })
  it('board groups by stage with counts and a per-stage cap', async () => {
    for (let i = 0; i < 4; i++) seedLead({ status: 'new', at: 1_760_000_000 + i })
    seedLead({ status: 'won' })
    const b = await get('/api/leads/board?per_stage=2')
    const col = (k: string) => b.columns.find((c: any) => c.stage.key === k)
    expect(b.columns.map((c: any) => c.stage.key)).toEqual(['new', 'contacted', 'qualified', 'won', 'lost'])
    expect(col('new').count).toBe(4); expect(col('new').leads).toHaveLength(2); expect(col('new').next_before).toMatch(/^\d+\.\d+$/)
    expect(col('won').count).toBe(1); expect(col('contacted').count).toBe(0); expect(col('contacted').next_before).toBeNull()
    const more = await get(`/api/leads?stage=new&limit=5&before=${col('new').next_before}`)
    expect(more.leads).toHaveLength(2)
  })
  it('contacts: list, search, detail with leads and conversation, patch writes an activity row', async () => {
    const a = seedLead({ name: 'Alpha' }); seedLead({ name: 'Beta' })
    raw.prepare(`INSERT INTO conversations (contact_id,last_message_at,last_inbound_at,last_preview,unread_count) VALUES (?,?,?,?,2)`).run(a.contact, 2000, 2000, 'hello')
    expect((await get('/api/contacts')).contacts).toHaveLength(2)
    expect((await get('/api/contacts?q=alph')).contacts.map((c: any) => c.name)).toEqual(['Alpha'])
    expect((await get(`/api/contacts?q=${encodeURIComponent('+1 555 000 ' + (a.contact))}`)).contacts.length).toBeGreaterThanOrEqual(0)
    const d = await get(`/api/contacts/${a.contact}`)
    expect(d.contact.name).toBe('Alpha'); expect(d.leads).toHaveLength(1); expect(d.conversation.unread_count).toBe(2)
    expect((await call('GET', '/api/contacts/99999')).status).toBe(404)
    const p = await send('PATCH', `/api/contacts/${a.contact}`, { name: 'Alpha Renamed', email: 'alpha@example.com' })
    expect(p.body.changed).toEqual(['name', 'email'])
    expect(rows(`SELECT kind FROM activity WHERE contact_id=?`, a.contact).map((r: any) => r.kind)).toEqual(['contact_updated'])
    expect((await send('PATCH', `/api/contacts/${a.contact}`, { email: 'nope' })).status).toBe(400)
    expect((await send('PATCH', `/api/contacts/${a.contact}`, { name: 'Alpha Renamed' })).body.changed).toEqual([])
    // the inbox's thread route is still reachable
    expect((await call('GET', `/api/contacts/${a.contact}/messages`)).status).toBe(200)
  })
})

describe('review fixes', () => {
  const add = (n: number) => {
    const c = raw.prepare(`INSERT INTO contacts (wa_id,phone,name) VALUES (?,?,?)`)
    const l = raw.prepare(`INSERT INTO leads (contact_id,source,status,created_at,updated_at) VALUES (?,?,?,?,?)`)
    const st = ['new', 'contacted', 'qualified', 'won', 'lost']
    for (let i = 0; i < n; i++) { const id = Number(c.run(`1555999${i}`, `1555999${i}`, `Bulk ${i}`).lastInsertRowid); l.run(id, 'whatsapp', st[i % 5], 1_760_000_000 + i, 1_760_000_000 + i) }
  }
  it('board and limit=200 survive 150 leads (D1 100-variable cap)', async () => {
    add(150)
    const t = Number(q(`SELECT id FROM tags LIMIT 1`)?.id ?? raw.prepare(`INSERT INTO tags (label,color) VALUES ('t','gray')`).run().lastInsertRowid)
    raw.prepare(`INSERT INTO lead_tags (lead_id,tag_id) SELECT id,? FROM leads`).run(t)
    expect((await call('GET', '/api/leads?limit=200')).status).toBe(200)
    expect((await call('GET', '/api/leads/board')).status).toBe(200)
  })
  it('list rows carry page, utm and attribution columns', async () => {
    const { lead } = seedLead()
    raw.prepare(`UPDATE leads SET page='/p',utm_source='s',utm_medium='m',utm_campaign='c',gclid='g',external_id='e' WHERE id=?`).run(lead)
    const r = (await get('/api/leads')).leads.find((x: any) => x.id === lead)
    expect(r).toMatchObject({ page: '/p', utm_source: 's', utm_medium: 'm', utm_campaign: 'c', gclid: 'g', external_id: 'e' })
    expect('attribution' in r).toBe(true)
  })
  it('PATCH with a bad tag id is atomic: 400 and the status is unchanged', async () => {
    const { lead } = seedLead()
    const r = await send('PATCH', `/api/leads/${lead}`, { status: 'won', tag_ids: [999] })
    expect(r.status).toBe(400)
    expect(q(`SELECT status FROM leads WHERE id=?`, lead).status).toBe('new')
    expect(acts(lead)).toHaveLength(0)
  })
  it('first_response_at ignores an inbound older than the lead', async () => {
    const { contact, lead } = seedLead({ at: 1_760_000_000 + 100_000 })
    raw.prepare(`INSERT INTO conversations (contact_id,last_message_at,last_inbound_at) VALUES (?,?,?)`).run(contact, 1_760_000_000, 1_760_000_000)
    await env.DB.batch([firstResponse(env.DB, contact)])
    expect(q(`SELECT first_response_at f FROM leads WHERE id=?`, lead).f).toBeNull()
  })
  it('day starts resolve forward across a midnight DST gap', () => {
    // Santiago 2026-09-06 00:00 -> 01:00 (-04 to -03); Havana 2026-03-08 same.
    expect(startOfDay(Date.UTC(2026, 8, 6, 12, 0) / 1000, 'America/Santiago')).toBe(Date.UTC(2026, 8, 6, 4, 0) / 1000)
    expect(startOfDay(Date.UTC(2026, 2, 8, 12, 0) / 1000, 'America/Havana')).toBe(Date.UTC(2026, 2, 8, 5, 0) / 1000)
    expect(startOfDay(Date.UTC(2026, 8, 5, 12, 0) / 1000, 'America/Santiago')).toBe(Date.UTC(2026, 8, 5, 4, 0) / 1000)
  })
  it('manual create: second call for the same contact is 409 with the lead id, one lead only', async () => {
    const a = await send('POST', '/api/leads/manual', { phone: '+15550000201', name: 'Dup' })
    const b = await send('POST', '/api/leads/manual', { phone: '+15550000201', name: 'Dup' })
    expect(a.status).toBe(201)
    expect(b.status).toBe(409)
    expect(b.body).toMatchObject({ error: 'open_lead_exists', lead_id: a.body.id })
    expect(rows(`SELECT COUNT(*) n FROM leads`)[0].n).toBe(1)
    expect(rows(`SELECT COUNT(*) n FROM activity WHERE kind='lead_created'`)[0].n).toBe(1)
  })
})
