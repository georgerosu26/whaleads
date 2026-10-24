import type { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import worker from '../src/index'
import { parseCsv } from '../src/csv'
import { ensureSchema, type Env } from '../src/db'
import { LEAD_CSV_COLUMNS } from '../src/export'
import { MAX_CHUNK_ROWS, MAX_ROWS, detectMapping } from '../src/import'
import { overview } from '../src/reports'
import { clearSettingsCache } from '../src/settings'
import { fakeD1 } from './d1'

const SECRET = 'test-session-secret-0123456789'
const ORIGIN = 'https://leads.example.com'
const KEY = 'adminkey'
let env: Env
let raw: DatabaseSync
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
const q = <T = any>(sql: string, ...a: any[]) => raw.prepare(sql).get(...a) as T
const rows = <T = any>(sql: string, ...a: any[]) => raw.prepare(sql).all(...a) as T[]

type Auth = { cookie?: string; csrf?: string; bearer?: string | null; origin?: boolean }
function hdr(a: Auth, method: string): Record<string, string> {
  const h: Record<string, string> = {}
  if (a.cookie) h.Cookie = a.cookie
  if (a.csrf) h['X-CSRF-Token'] = a.csrf
  const bearer = a.bearer === undefined ? (a.cookie ? null : KEY) : a.bearer
  if (bearer) h.Authorization = `Bearer ${bearer}`
  if (method !== 'GET' && a.origin !== false) h.Origin = ORIGIN
  return h
}
const get = (path: string, a: Auth = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, { headers: hdr(a, 'GET') }), env, ctx)
function upload(csv: string, mode: string, mapping?: Record<string, number>, a: Auth = {}, name = 'leads.csv') {
  const fd = new FormData()
  fd.set('file', new File([csv], name, { type: 'text/csv' }))
  fd.set('mode', mode)
  if (mapping) fd.set('mapping', JSON.stringify(mapping))
  return worker.fetch(new Request(`${ORIGIN}/api/import/leads`, { method: 'POST', headers: hdr(a, 'POST'), body: fd }), env, ctx)
}
const postJson = (path: string, body: unknown, a: Auth = {}) =>
  worker.fetch(new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...hdr(a, 'POST') }, body: JSON.stringify(body) }), env, ctx)

/** What the Data page does: parse the file in the browser, send at most 100 rows per request, the last one closes the log. */
async function commitAll(csv: string, mapping: Record<string, number>, a: Auth = {}, file = 'leads.csv', importId = 'imp-test-0001') {
  const data = parseCsv(csv).slice(1)
  const total = { rows: 0, leads_created: 0, contacts_created: 0, contacts_updated: 0, duplicates: 0, errors: 0, tags_created: 0, batches: 0 }
  const chunks: any[] = []
  const errors: any[] = []
  for (let i = 0, c = 0; i < data.length; i += MAX_CHUNK_ROWS, c++) {
    const last = i + MAX_CHUNK_ROWS >= data.length
    const res = await postJson('/api/import/leads/commit', { import_id: importId, chunk: c, file, mapping, rows: data.slice(i, i + MAX_CHUNK_ROWS), ...(last ? { last: true, totals: total } : {}) }, a)
    const body: any = await res.json()
    if (res.status !== 200) return { status: res.status, body, total, chunks, errors }
    chunks.push(body)
    total.rows += Math.min(MAX_CHUNK_ROWS, data.length - i)
    errors.push(...body.errors)
    for (const k of ['leads_created', 'contacts_created', 'contacts_updated', 'duplicates', 'errors', 'tags_created', 'batches'] as const) total[k] += body.result[k]
  }
  return { status: 200, body: chunks.at(-1), total, chunks, errors }
}

async function adminSession() {
  const res = await worker.fetch(new Request(`${ORIGIN}/api/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ setup_key: SECRET, business_name: 'Example Co', default_country: 'US', timezone: 'UTC', admin: { name: 'Test Admin', email: 'admin@example.com', password: 'a-long-test-passphrase-1' } }),
  }), env, ctx)
  const b: any = await res.json()
  return { cookie: (res.headers.get('set-cookie') ?? '').split(';')[0], csrf: b.csrf as string }
}
async function staffSession() {
  const add = await postJson('/api/staff', { name: 'Member', email: 'm@example.com' })
  const { temp_password }: any = await add.json()
  raw.exec(`UPDATE staff SET must_change_pw=0 WHERE email='m@example.com'`)
  const res = await worker.fetch(new Request(`${ORIGIN}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ email: 'm@example.com', password: temp_password }) }), env, ctx)
  const b: any = await res.json()
  return { cookie: (res.headers.get('set-cookie') ?? '').split(';')[0], csrf: b.csrf as string }
}

beforeEach(async () => {
  const f = fakeD1(); raw = f.raw
  env = { DB: f.d1, ADMIN_KEY: KEY, SESSION_SECRET: SECRET, INSTANCE_NAME: 'inst', ALLOWED_ORIGINS: '', META_APP_SECRET: 'appsecret' } as unknown as Env
  await ensureSchema(f.d1)
  raw.exec(`INSERT INTO settings (key,value) VALUES ('default_country','"US"'),('timezone','"UTC"')`)
  clearSettingsCache(f.d1)
})

const HEAD = 'name,phone,email,source,stage,tags,notes'
const MAP = { name: 0, phone: 1, email: 2, source: 3, stage: 4, tags: 5, notes: 6 }
const HEAD_FULL = HEAD + ',created,lost_reason'
const MAP_FULL = { ...MAP, created_at: 7, lost_reason: 8 }

describe('access', () => {
  it('export and import need an admin; the import needs the CSRF token on a session', async () => {
    const adm = await adminSession()
    const staff = await staffSession()
    for (const p of ['/api/export/leads.csv', '/api/export/full.json', '/api/export/log']) {
      expect((await get(p, { bearer: null })).status, p).toBe(401)
      expect((await get(p, staff)).status, p).toBe(403)
      expect((await get(p, adm)).status, p).toBe(200)
      expect((await get(p)).status, p).toBe(200)
    }
    const csv = `${HEAD}\nA,+15550100001,,,,,\n`
    expect((await upload(csv, 'inspect', undefined, { bearer: null })).status).toBe(401)
    expect((await upload(csv, 'inspect', undefined, staff)).status).toBe(403)
    expect((await upload(csv, 'inspect', undefined, { cookie: adm.cookie })).status).toBe(403) // no CSRF token
    expect((await upload(csv, 'inspect', undefined, { cookie: adm.cookie, csrf: 'wrong' })).status).toBe(403)
    expect((await upload(csv, 'inspect', undefined, adm)).status).toBe(200)
    expect(q('SELECT COUNT(*) n FROM contacts').n).toBe(0)
  })
  it('wrong method on an export or the import route is a 405', async () => {
    expect((await postJson('/api/export/leads.csv', {})).status).toBe(405)
    expect((await get('/api/import/leads')).status).toBe(405)
  })
})

describe('import', () => {
  it('inspect detects the export columns and the usual synonyms', async () => {
    const r: any = await (await upload('Full Name;Mobile Number;E-mail;Lead Source;Status;Labels;Remarks\nA;+15550100001;;;;;\n', 'inspect')).json()
    expect(r).toMatchObject({ ok: true, row_count: 1, headers: ['Full Name', 'Mobile Number', 'E-mail', 'Lead Source', 'Status', 'Labels', 'Remarks'] })
    expect(r.mapping).toEqual({ name: 0, phone: 1, email: 2, source: 3, stage: 4, tags: 5, notes: 6 })
    expect(detectMapping([...LEAD_CSV_COLUMNS])).toMatchObject({ phone: 3, name: 2, email: 4, source: 5, stage: 6, tags: 9, message: 15, created_at: 1 })
  })

  it('dry run reports counts, duplicates and per-row errors, and writes nothing', async () => {
    raw.exec(`INSERT INTO contacts (id,wa_id,phone,name) VALUES (1,'15550100002','15550100002','Existing')`)
    raw.exec(`INSERT INTO leads (contact_id,source,status) VALUES (1,'whatsapp','new')`) // open lead
    raw.exec(`INSERT INTO contacts (id,wa_id,phone,name) VALUES (2,'15550100003','15550100003',NULL)`) // contact without a lead
    const csv = [HEAD,
      'Ann,+1 555 010 0001,ann@example.com,manual,qualified,vip;hot,Called twice',
      'Dup,(555) 010-0002,,,,,', // open lead exists -> duplicate
      'Fill,+15550100003,fill@example.com,,,,', // contact exists, no open lead -> lead created, contact filled
      'Bad,12,,,,,', // bad phone
      'Again,+15550100001,,,,,', // same phone twice in the file
      'Odd,+15550100004,not-an-email,nowhere,limbo,,',
    ].join('\n') + '\n'
    const r: any = await (await upload(csv, 'preview', MAP)).json()
    expect(r).toMatchObject({ ok: true, dry_run: true })
    expect(r.counts).toMatchObject({ rows: 6, to_create: 3, new_contacts: 2, existing_contacts: 2, duplicates: 2, duplicates_open_lead: 1, duplicates_in_file: 1, errors: 1, new_tags: 2 })
    expect(r.errors).toEqual([expect.objectContaining({ row: 5, phone: '12' })])
    expect(r.preview.map((p: any) => [p.row, p.action])).toEqual([[2, 'create_lead'], [3, 'duplicate_open_lead'], [4, 'create_lead'], [6, 'duplicate_in_file'], [7, 'create_lead']])
    const odd = r.preview.find((p: any) => p.row === 7)
    expect(odd).toMatchObject({ source: 'import', stage: 'new' })
    expect(odd.warnings.join(' ')).toMatch(/email ignored.*unknown source.*unknown stage/)
    expect(q('SELECT COUNT(*) n FROM contacts').n).toBe(2)
    expect(q('SELECT COUNT(*) n FROM leads').n).toBe(1)
    expect(q('SELECT COUNT(*) n FROM tags').n).toBe(0)
  })

  it('commit creates contacts, leads, tags, notes and an imported activity; dedupes by phone', async () => {
    raw.exec(`INSERT INTO contacts (id,wa_id,phone,name) VALUES (1,'15550100002','15550100002','Existing')`)
    raw.exec(`INSERT INTO leads (contact_id,source,status) VALUES (1,'whatsapp','new')`)
    raw.exec(`INSERT INTO contacts (id,wa_id,phone,name) VALUES (2,'15550100003','15550100003',NULL)`)
    raw.exec(`INSERT INTO tags (label) VALUES ('VIP')`)
    const csv = [HEAD,
      'Ann,+1 555 010 0001,ann@example.com,manual,qualified,vip;hot,Called twice',
      'Dup,(555) 010-0002,dup@example.com,,,,',
      'Fill,+15550100003,fill@example.com,,won,,',
      'Bad,12,,,,,',
    ].join('\n') + '\n'
    const r = await commitAll(csv, MAP, {}, 'people.csv')
    expect(r.status).toBe(200)
    expect(r.total).toMatchObject({ contacts_created: 1, contacts_updated: 1, leads_created: 2, duplicates: 1, errors: 1, tags_created: 1 })

    const ann = q(`SELECT l.id,l.source,l.status,c.name,c.email,c.wa_id,c.source AS csource FROM leads l JOIN contacts c ON c.id=l.contact_id WHERE c.wa_id='15550100001'`)
    expect(ann).toMatchObject({ source: 'manual', status: 'qualified', name: 'Ann', email: 'ann@example.com', csource: 'import' })
    expect(rows(`SELECT t.label FROM lead_tags lt JOIN tags t ON t.id=lt.tag_id WHERE lt.lead_id=? ORDER BY t.label`, ann.id).map((x) => x.label)).toEqual(['hot', 'VIP'].sort((a, b) => a.localeCompare(b)))
    expect(rows(`SELECT kind,actor,data FROM activity WHERE lead_id=? ORDER BY id`, ann.id).map((a) => a.kind)).toEqual(['imported', 'note'])
    expect(JSON.parse(rows(`SELECT data FROM activity WHERE lead_id=? AND kind='note'`, ann.id)[0].data)).toEqual({ text: 'Called twice' })
    expect(JSON.parse(rows(`SELECT data FROM activity WHERE lead_id=? AND kind='imported'`, ann.id)[0].data)).toMatchObject({ file: 'people.csv', row: 2, source: 'manual' })
    // duplicate: contact filled, no second lead
    expect(q(`SELECT COUNT(*) n FROM leads WHERE contact_id=1`).n).toBe(1)
    expect(q(`SELECT email,name FROM contacts WHERE id=1`)).toEqual({ email: null, name: 'Existing' }) // duplicates are skipped untouched
    // existing contact without an open lead: a lead, and the blank name/email are filled (won -> closed fields)
    expect(q(`SELECT l.status,l.won_at,l.closed_at,c.email FROM leads l JOIN contacts c ON c.id=l.contact_id WHERE c.id=2`)).toMatchObject({ status: 'won', email: 'fill@example.com' })
    expect(q(`SELECT won_at FROM leads WHERE contact_id=2`).won_at).toBeGreaterThan(0)
    // an event for the Data page
    const log: any = await (await get('/api/export/log')).json()
    expect(log.events[0]).toMatchObject({ kind: 'import', leads_created: 2, rows: 4 })
    // running the same file again creates nothing: Ann and Fill carry their row key, Dup still has the older open lead
    const leadsBefore = q('SELECT COUNT(*) n FROM leads').n
    const again = await commitAll(csv, MAP)
    expect(again.total).toMatchObject({ contacts_created: 0, leads_created: 0, duplicates: 3, errors: 1 })
    expect(again.body.counts).toMatchObject({ duplicates_imported: 2, duplicates_open_lead: 1 })
    expect(q('SELECT COUNT(*) n FROM leads').n).toBe(leadsBefore)
  })

  it('re-uploading a file with open, won and lost rows creates no new rows; a replayed chunk is harmless', async () => {
    const csv = [HEAD_FULL,
      'A,+15550100011,,manual,new,,,2025-01-10,',
      'B,+15550100012,,manual,won,,,2025-01-11,',
      'C,+15550100013,,manual,lost,,,2025-01-12,price',
      'B again,+15550100012,,manual,won,,,2025-02-11,', // same person, a second won deal on another date: a different row
      'D,+15550100014,,manual,won,,,,', // no date: the key must not depend on today
    ].join('\n') + '\n'
    const first = await commitAll(csv, MAP_FULL)
    expect(first.total).toMatchObject({ leads_created: 5, contacts_created: 4, duplicates: 0 })
    const counts = () => [q('SELECT COUNT(*) n FROM leads').n, q('SELECT COUNT(*) n FROM contacts').n, q('SELECT COUNT(*) n FROM activity').n]
    const snap = counts()
    const second = await commitAll(csv, MAP_FULL)
    expect(second.total).toMatchObject({ leads_created: 0, contacts_created: 0, duplicates: 5 })
    expect(counts()).toEqual(snap)
    // the same chunk sent again by a client that never saw the response
    const rowsAgain = parseCsv(csv).slice(1)
    const replay: any = await (await postJson('/api/import/leads/commit', { import_id: 'imp-test-0001', chunk: 0, file: 'leads.csv', mapping: MAP_FULL, rows: rowsAgain })).json()
    expect(replay.result).toMatchObject({ leads_created: 0 })
    expect(counts()).toEqual(snap)
    expect(rows(`SELECT external_id FROM leads WHERE external_id IS NOT NULL`).length).toBe(5)
  })

  it('a CSV id column is the row key: same person, date and stage but different ids are two leads, and a re-run adds none', async () => {
    const csv = ['name,phone,stage,created,ref', 'A,+15550100021,won,2025-03-01,r-1', 'A,+15550100021,won,2025-03-01,r-2'].join('\n') + '\n'
    const insp: any = await (await upload(csv, 'inspect')).json()
    expect(insp.mapping.external_id).toBe(4)
    expect((await commitAll(csv, insp.mapping)).total).toMatchObject({ leads_created: 2 })
    expect((await commitAll(csv, insp.mapping)).total).toMatchObject({ leads_created: 0, duplicates: 2 })
    expect(rows(`SELECT external_id FROM leads ORDER BY id`).map((r) => r.external_id)).toEqual(['imp:x:15550100021:r-1', 'imp:x:15550100021:r-2'])
  })

  it('won and lost rows take their dates from the row: a historical win is not in this week\'s report', async () => {
    const csv = [HEAD_FULL, 'W,+15550100031,,manual,won,,,2025-01-15,', 'L,+15550100032,,manual,lost,,,2025-01-16,price', 'N,+15550100033,,manual,won,,,,'].join('\n') + '\n'
    const t0 = Math.floor(Date.now() / 1000)
    await commitAll(csv, MAP_FULL)
    const jan15 = Date.UTC(2025, 0, 15) / 1000, jan16 = Date.UTC(2025, 0, 16) / 1000
    expect(q(`SELECT created_at,won_at,closed_at FROM leads WHERE external_id LIKE 'imp:h:15550100031%'`)).toEqual({ created_at: jan15, won_at: jan15, closed_at: jan15 })
    expect(q(`SELECT won_at,closed_at FROM leads WHERE external_id LIKE 'imp:h:15550100032%'`)).toEqual({ won_at: null, closed_at: jan16 })
    expect(q(`SELECT won_at FROM leads WHERE external_id LIKE 'imp:h:15550100033%'`).won_at).toBeGreaterThanOrEqual(t0) // no date in the file: now
    const day = new Date().toISOString().slice(0, 10)
    const week: any = await overview(env, day, day)
    expect(week.totals.won).toBe(1) // only the undated row (created and won today); the dated ones are not in this window
    const jan: any = await overview(env, '2025-01-13', '2025-01-19')
    expect(jan.totals).toMatchObject({ leads: 2, won: 1, lost: 1 })
  })

  it('chunk requests are validated: 100 rows at most, a sane import id, a mapped phone, text cells', async () => {
    const rowsOf = (n: number) => Array.from({ length: n }, (_, i) => [`P${i}`, `+1555${3000000 + i}`])
    const ok = (over: object) => postJson('/api/import/leads/commit', { import_id: 'imp-limits-01', chunk: 0, mapping: { name: 0, phone: 1 }, rows: rowsOf(2), ...over })
    expect((await ok({})).status).toBe(200)
    const big = await ok({ rows: rowsOf(MAX_CHUNK_ROWS + 1) })
    expect(big.status).toBe(413)
    expect(await big.json()).toMatchObject({ error: 'chunk_too_large', limit: MAX_CHUNK_ROWS })
    expect((await ok({ rows: rowsOf(MAX_CHUNK_ROWS) })).status).toBe(200)
    expect((await ok({ import_id: 'x' })).status).toBe(400)
    expect((await ok({ chunk: -1 })).status).toBe(400)
    expect((await ok({ chunk: MAX_ROWS / MAX_CHUNK_ROWS })).status).toBe(400)
    expect((await ok({ mapping: { name: 0 } })).status).toBe(400)
    expect((await ok({ rows: [[1, 2]] })).status).toBe(400)
    expect((await ok({ rows: [] })).status).toBe(400)
    expect((await postJson('/api/import/leads/commit', { import_id: 'imp-limits-01', chunk: 0, mapping: { phone: 0 }, rows: [['+15550100099']] }, { bearer: null })).status).toBe(401)
    expect((await worker.fetch(new Request(`${ORIGIN}/api/import/leads/commit`, { method: 'GET', headers: hdr({}, 'GET') }), env, ctx)).status).toBe(405)
  })

  it('an oversized upload is refused from its Content-Length before the body is read', async () => {
    let pulled = false
    const body = new ReadableStream({ pull(c) { pulled = true; c.enqueue(new Uint8Array(1024)) } }, { highWaterMark: 0 })
    const res = await worker.fetch(new Request(`${ORIGIN}/api/import/leads`, { method: 'POST', headers: { ...hdr({}, 'POST'), 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(50 * 1024 * 1024) }, body, duplex: 'half' } as RequestInit), env, ctx)
    expect(res.status).toBe(413)
    expect(pulled).toBe(false)
    // no declared length: the stream is cut off at the cap
    let sent = 0
    const endless = new ReadableStream({ pull(c) { sent += 65536; c.enqueue(new Uint8Array(65536)) } })
    const res2 = await worker.fetch(new Request(`${ORIGIN}/api/import/leads`, { method: 'POST', headers: { ...hdr({}, 'POST'), 'content-type': 'multipart/form-data; boundary=x' }, body: endless, duplex: 'half' } as RequestInit), env, ctx)
    expect(res2.status).toBe(413)
    expect(sent).toBeLessThan(4 * 1024 * 1024)
  })

  it('the preview parses at most 5,001 rows and stops', async () => {
    const huge = HEAD + '\n' + 'A,+15550100001,,,,,\n'.repeat(200000)
    const res = await upload(huge.slice(0, 1.9 * 1024 * 1024), 'preview', MAP)
    expect(res.status).toBe(413)
    expect(await res.json()).toMatchObject({ error: 'too_many_rows', limit: MAX_ROWS })
  })

  it('commits a 250-row file as three client-driven chunks; the preview enforces the 5,000 row limit', async () => {
    const mk = (n: number) => [HEAD, ...Array.from({ length: n }, (_, i) => `P${i},+1555${String(2000000 + i)},,,,,`)].join('\n') + '\n'
    const r = await commitAll(mk(250), MAP)
    expect(r.chunks.length).toBe(3)
    expect(r.chunks.map((c) => c.result.leads_created)).toEqual([100, 100, 50])
    expect(r.chunks.map((c) => c.result.batches)).toEqual([1, 1, 1])
    expect(r.errors).toEqual([])
    expect(q('SELECT COUNT(*) n FROM leads').n).toBe(250)
    expect(q(`SELECT COUNT(*) n FROM activity WHERE kind='imported'`).n).toBe(250)
    const ok: any = await (await upload(mk(MAX_ROWS), 'preview', MAP)).json()
    expect(ok.counts).toMatchObject({ rows: MAX_ROWS, to_create: MAX_ROWS - 250, duplicates: 250, duplicates_imported: 250 })
    const over = await upload(mk(MAX_ROWS + 1), 'preview', MAP)
    expect(over.status).toBe(413)
    expect(await over.json()).toMatchObject({ ok: false, error: 'too_many_rows', limit: MAX_ROWS })
  })

  it('the old single-request commit mode points at the chunked route', async () => {
    const res = await upload(`${HEAD}\nA,+15550100001,,,,,\n`, 'commit', MAP)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'use_chunked_commit', chunk_rows: MAX_CHUNK_ROWS })
    expect(q('SELECT COUNT(*) n FROM leads').n).toBe(0)
  })

  it('rejects a missing phone mapping, an out-of-range column, junk mode and non-multipart bodies', async () => {
    const csv = `${HEAD}\nA,+15550100001,,,,,\n`
    expect((await upload(csv, 'preview', { name: 0 })).status).toBe(400)
    expect((await upload(csv, 'preview', { phone: 99 })).status).toBe(400)
    expect((await upload(csv, 'nope')).status).toBe(400)
    expect((await postJson('/api/import/leads', {})).status).toBe(415)
    expect((await upload('', 'inspect')).status).toBe(400)
  })

  it('bad-phone rows are reported with the row number and the file is otherwise imported', async () => {
    const csv = `${HEAD}\nA,abc,,,,,\nB,+15550100005,,,,,\nC,,,,,,\n`
    const r = await commitAll(csv, MAP)
    expect(r.errors.map((e: any) => e.row)).toEqual([2, 4])
    expect(r.total).toMatchObject({ leads_created: 1, errors: 2 })
  })
})

describe('export', () => {
  async function seed() {
    raw.exec(`INSERT INTO staff (id,email,name,role,pw_hash) VALUES (1,'owner@example.com','Owner, "Chief"','admin','secret-hash')`)
    raw.exec(`INSERT INTO contacts (id,wa_id,phone,name,email) VALUES (1,'15550100001','15550100001','Zoë "Z", 李雷','z@example.com'),(2,'15550100002','15550100002','=cmd|calc',NULL)`)
    raw.exec(`INSERT INTO leads (id,contact_id,source,status,message,created_at,updated_at,assigned_to,first_response_at,ad_source_id,attribution,utm_source)
      VALUES (1,1,'ctwa','won','two
lines',1760000000,1760000000,1,1760000060,'AD9','{"source_id":"AD9","source_type":"ad","source_url":"https://example.com/ad","headline":"Big, bold"}','g'),
      (2,2,'manual','new',NULL,1760000100,1760000100,NULL,NULL,NULL,NULL,NULL)`)
    raw.exec(`UPDATE leads SET won_at=1760000500, closed_at=1760000500 WHERE id=1`)
    raw.exec(`INSERT INTO tags (id,label) VALUES (1,'VIP'),(2,'a;b')`)
    raw.exec(`INSERT INTO lead_tags VALUES (1,1),(1,2)`)
    raw.exec(`INSERT INTO messages (id,contact_id,direction,wamid,type,body,timestamp,raw) VALUES (1,1,'in','w1','image','pic',1760000010,'{"secret":"raw"}')`)
    raw.exec(`INSERT INTO media (message_id,media_id,r2_key,mime,status) VALUES (1,'m1','media/1/a.jpg','image/jpeg','stored')`)
    raw.exec(`INSERT INTO activity (lead_id,contact_id,actor,kind,data) VALUES (1,1,'staff:1','note','{"text":"hello"}')`)
    raw.exec(`INSERT INTO conversations (contact_id,last_message_at,last_inbound_at) VALUES (1,1760000010,1760000010)`)
    raw.exec(`INSERT INTO quick_replies (shortcut,body) VALUES ('hi','Hello')`)
    raw.exec(`INSERT INTO settings (key,value) VALUES ('business_name','"Example Co"'),('anthropic_key_enc','"blob"'),('vapid_public','"pub"'),('push_secret','"x"')`)
    clearSettingsCache(env.DB)
  }

  it('leads.csv: header row, BOM, escaping, E.164 phone, tags, referral fields', async () => {
    await seed()
    const res = await get('/api/export/leads.csv')
    expect(res.headers.get('content-type')).toMatch(/text\/csv/)
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="whaleads-leads-\d{4}-\d{2}-\d{2}\.csv"/)
    const bytes = new Uint8Array(await res.clone().arrayBuffer())
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]) // UTF-8 BOM so Excel reads it as UTF-8
    const text = '\ufeff' + (await res.text())
    const t = parseCsv(text)
    expect(t[0]).toEqual([...LEAD_CSV_COLUMNS])
    expect(t).toHaveLength(3)
    const col = (r: string[], c: string) => r[LEAD_CSV_COLUMNS.indexOf(c as any)]
    expect(col(t[1], 'id')).toBe('1')
    expect(col(t[1], 'name')).toBe('Zoë "Z", 李雷')
    expect(col(t[1], 'phone')).toBe('+15550100001')
    expect(col(t[1], 'created_at')).toBe('2025-10-09T08:53:20.000Z')
    expect(col(t[1], 'stage')).toBe('won')
    expect(col(t[1], 'owner')).toBe('Owner, "Chief"')
    expect(col(t[1], 'owner_email')).toBe('owner@example.com')
    expect(col(t[1], 'tags')).toBe('VIP;a,b')
    expect(col(t[1], 'message')).toBe('two\nlines')
    expect(col(t[1], 'won_at')).toBe('2025-10-09T09:01:40.000Z')
    expect(col(t[1], 'first_response_at')).toBe('2025-10-09T08:54:20.000Z')
    expect(col(t[1], 'referral_source_id')).toBe('AD9')
    expect(col(t[1], 'referral_headline')).toBe('Big, bold')
    expect(col(t[1], 'utm_source')).toBe('g')
    expect(col(t[2], 'name')).toBe("'=cmd|calc") // formula guard
    expect(col(t[2], 'owner')).toBe('')
    expect(text).not.toContain('secret-hash')
  })

  it('full.json: versioned, no secrets, every section, media rows without bytes, valid JSON', async () => {
    await seed()
    const res = await get('/api/export/full.json')
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="whaleads-export-/)
    const j: any = JSON.parse(await res.text())
    expect(j.whaleads_export).toBe(1)
    expect(Object.keys(j)).toEqual(expect.arrayContaining(['exported_at', 'instance', 'settings', 'staff', 'stages', 'sources', 'tags', 'contacts', 'leads', 'lead_tags', 'activity', 'conversations', 'messages', 'media', 'quick_replies']))
    expect(j.settings).toEqual({ business_name: 'Example Co', default_country: 'US', timezone: 'UTC', vapid_public: 'pub' })
    expect(j.staff).toEqual([expect.not.objectContaining({ pw_hash: expect.anything() })])
    expect(JSON.stringify(j)).not.toMatch(/secret-hash|"blob"|"raw"/)
    expect(j.contacts).toHaveLength(2)
    expect(j.leads.map((l: any) => l.id)).toEqual([1, 2])
    expect(j.leads[0]).toMatchObject({ source: 'ctwa', status: 'won', ad_source_id: 'AD9', external_id: null })
    expect(j.lead_tags).toEqual([{ lead_id: 1, tag_id: 1 }, { lead_id: 1, tag_id: 2 }])
    expect(j.messages[0]).not.toHaveProperty('raw')
    expect(j.media[0]).toMatchObject({ r2_key: 'media/1/a.jpg', mime: 'image/jpeg' })
    expect(j.activity[0]).toMatchObject({ kind: 'note' })
    expect(j.stages.map((s: any) => s.key)).toEqual(['new', 'contacted', 'qualified', 'won', 'lost'])
    expect(j.templates).toEqual([]) // templates table exists, empty
    // an export event is logged
    expect(rows(`SELECT payload FROM events WHERE kind='export'`).map((e) => JSON.parse(e.payload).format)).toEqual(['full_json'])
  })

  it('leads can be filtered by ad campaign', async () => {
    await seed()
    const r: any = await (await get('/api/leads?campaign=AD9')).json()
    expect(r.leads.map((l: any) => l.id)).toEqual([1])
    expect((await (await get('/api/leads?campaign=nope')).json() as any).leads).toEqual([])
  })

  it('pages through more rows than one page holds', async () => {
    raw.exec('BEGIN')
    for (let i = 1; i <= 1200; i++) {
      raw.prepare(`INSERT INTO contacts (id,wa_id,phone,name) VALUES (?,?,?,?)`).run(i, `1555100${String(i).padStart(4, '0')}`, `1555100${String(i).padStart(4, '0')}`, `P${i}`)
      raw.prepare(`INSERT INTO leads (id,contact_id,source,status,created_at,updated_at) VALUES (?,?,?,?,?,?)`).run(i, i, 'manual', 'new', 1760000000 + i, 1760000000 + i)
    }
    raw.exec('COMMIT')
    const t = parseCsv(await (await get('/api/export/leads.csv')).text())
    expect(t).toHaveLength(1201)
    expect(new Set(t.slice(1).map((r) => r[0])).size).toBe(1200)
    const j: any = JSON.parse(await (await get('/api/export/full.json')).text())
    expect(j.leads).toHaveLength(1200)
    expect(j.contacts).toHaveLength(1200)
  })

  it('both exports are pulled lazily: one page of 500 per read, nothing built up front', async () => {
    raw.exec('BEGIN')
    for (let i = 1; i <= 1200; i++) {
      raw.prepare(`INSERT INTO contacts (id,wa_id,phone,name) VALUES (?,?,?,?)`).run(i, `1555100${String(i).padStart(4, '0')}`, `1555100${String(i).padStart(4, '0')}`, `P${i}`)
      raw.prepare(`INSERT INTO leads (id,contact_id,source,status,created_at,updated_at) VALUES (?,?,?,?,?,?)`).run(i, i, 'manual', 'new', 1760000000 + i, 1760000000 + i)
    }
    raw.exec('COMMIT')
    const real = env.DB.prepare.bind(env.DB)
    let queries = 0
    ;(env.DB as any).prepare = (sql: string) => { queries++; return real(sql) }
    for (const [path, perPage] of [['/api/export/leads.csv', 500], ['/api/export/full.json', 500]] as const) {
      const reader = (await get(path)).body!.getReader()
      queries = 0
      let seen = 0, reads = 0
      while (seen < 1200 * 0.5) { const { value, done } = await reader.read(); if (done) break; reads++; seen += value.byteLength }
      const early = queries
      await reader.cancel()
      expect(early, path).toBeLessThan(12) // a handful of small section/page queries, not one per row and not all sections
      expect(reads, path).toBeGreaterThan(0)
      void perPage
    }
    // a full CSV read issues 3 page queries (500, 500, 200) plus the audit-log insert
    queries = 0
    await (await get('/api/export/leads.csv')).text()
    expect(queries).toBeLessThanOrEqual(5)
  })

  it('round trip: export leads.csv, wipe, import it back, same contacts, stages, tags and sources', async () => {
    await seed()
    const text = await (await get('/api/export/leads.csv')).text()
    const before = rows(`SELECT c.wa_id, l.source, l.status FROM leads l JOIN contacts c ON c.id=l.contact_id ORDER BY l.id`)
    raw.exec(`DELETE FROM lead_tags; DELETE FROM activity; DELETE FROM media; DELETE FROM messages; DELETE FROM conversations; DELETE FROM leads; DELETE FROM contacts; DELETE FROM tags`)
    const insp: any = await (await upload(text, 'inspect')).json()
    expect(insp.row_count).toBe(2)
    const r = await commitAll(text, insp.mapping)
    expect(r.total).toMatchObject({ contacts_created: 2, leads_created: 2, errors: 0, duplicates: 0 })
    expect(rows(`SELECT c.wa_id, l.source, l.status FROM leads l JOIN contacts c ON c.id=l.contact_id ORDER BY l.id`)).toEqual(before)
    expect(q(`SELECT name FROM contacts WHERE wa_id='15550100002'`).name).toBe('=cmd|calc') // guard removed on the way in
    expect(q(`SELECT name FROM contacts WHERE wa_id='15550100001'`).name).toBe('Zoë "Z", 李雷')
    expect(rows(`SELECT label FROM tags ORDER BY label`).map((t) => t.label)).toEqual(['a,b', 'VIP'])
    expect(q(`SELECT assigned_to FROM leads WHERE source='ctwa'`).assigned_to).toBe(1) // owner_email maps back to the staff row
    expect(q(`SELECT created_at FROM leads WHERE source='ctwa'`).created_at).toBe(1760000000)
    expect(q(`SELECT message FROM leads WHERE source='ctwa'`).message).toBe('two\nlines')
  })
})
