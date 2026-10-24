import { describe, expect, it } from 'vitest'
import { MIGRATIONS, ensureSchema } from '../src/db'
import { fakeD1, legacyV2, legacyV3, legacyV4, legacyV5, legacyV7, legacyV8 } from './d1'

type Raw = ReturnType<typeof fakeD1>['raw']
const one = <T = any>(raw: Raw, sql: string) => raw.prepare(sql).get() as T
const all = <T = any>(raw: Raw, sql: string) => raw.prepare(sql).all() as T[]
const keys = (raw: Raw) => all<{ key: string }>(raw, `SELECT key FROM meta WHERE key LIKE 'applied_%' ORDER BY key`).map((r) => r.key)
const LATEST = MIGRATIONS.length
const ALL_LOCKS = Array.from({ length: LATEST }, (_, i) => `applied_${i + 1}`)

/** Populated pre-v4 data: sparse lead ids on purpose, one lead per old CHECK value. */
function populate(raw: Raw) {
  raw.exec(`INSERT INTO contacts (id,wa_id,phone,name) VALUES (1,'15550000001','15550000001','Test One'),(2,'15550000002','15550000002','Test Two'),(3,NULL,'15550000003','Form Only')`)
  raw.exec(`INSERT INTO leads (id,contact_id,source,message,status,utm_source,gclid,created_at,updated_at) VALUES
    (5,1,'whatsapp','hi','new','g','abc',1000,1001),(9,2,'pilot_form',NULL,'contacted',NULL,NULL,2000,2001),
    (12,3,'contact_form','form msg','qualified',NULL,NULL,3000,3001),(40,1,'call',NULL,'won',NULL,NULL,4000,4001)`)
  raw.exec(`INSERT INTO messages (id,contact_id,direction,wamid,type,body,media_id,timestamp) VALUES
    (1,1,'in','w1','text','first',NULL,100),(2,1,'out','w2','text','reply',NULL,200),(3,1,'in','w3','image',NULL,'media-a',300),
    (4,2,'in','w4','text','${'x'.repeat(200)}',NULL,150),(5,2,'out','w5','text','sent last',NULL,160)`)
  raw.exec(`INSERT INTO adaptor_config (id,kind,config_enc) VALUES (1,'whabuzz','v1.AAAA.BBBB')`)
}

function expectV4(raw: Raw) {
  expect(one(raw, `SELECT value FROM meta WHERE key='schema_version'`).value).toBe(String(LATEST))
  expect(keys(raw)).toEqual(ALL_LOCKS)
  // leads: same rows, same ids, same data
  expect(all(raw, `SELECT id FROM leads ORDER BY id`).map((r) => r.id)).toEqual([5, 9, 12, 40])
  expect(one(raw, 'SELECT COUNT(*) n FROM contacts').n).toBe(3)
  expect(one(raw, 'SELECT COUNT(*) n FROM messages').n).toBe(5)
  const l5 = one(raw, 'SELECT * FROM leads WHERE id=5')
  expect(l5).toMatchObject({ contact_id: 1, source: 'whatsapp', message: 'hi', status: 'new', utm_source: 'g', gclid: 'abc', created_at: 1000, updated_at: 1001, assigned_to: null, next_action_at: null })
  expect(all(raw, 'SELECT id,status FROM leads ORDER BY id').map((r) => r.status)).toEqual(['new', 'contacted', 'qualified', 'won'])
  // the v1 CHECK is gone, and ids keep counting up from the old maximum
  raw.exec(`INSERT INTO leads (contact_id,source) VALUES (1,'manual'),(2,'import'),(3,'ctwa')`)
  expect(one(raw, `SELECT COUNT(*) n FROM leads WHERE source IN ('manual','import','ctwa')`).n).toBe(3)
  expect(one(raw, 'SELECT MIN(id) m FROM leads WHERE id > 40').m).toBe(41)
  expect(one(raw, `SELECT COUNT(*) n FROM sqlite_master WHERE name='leads_v4'`).n).toBe(0)
  expect(one(raw, `SELECT sql FROM sqlite_master WHERE name='leads'`).sql).not.toMatch(/CHECK/i)
  expect(all(raw, `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='leads' AND name LIKE 'leads_%' ORDER BY name`).map((r) => r.name))
    .toEqual(['leads_ad_source_idx', 'leads_contact_idx', 'leads_created_idx', 'leads_external_idx', 'leads_next_action_idx'])
  // conversations backfilled, no unread flood
  expect(all(raw, 'SELECT * FROM conversations ORDER BY contact_id')).toMatchObject([
    { contact_id: 1, last_message_at: 300, last_inbound_at: 300, last_preview: '[image]', unread_count: 0, status: 'open', assigned_to: null },
    { contact_id: 2, last_message_at: 160, last_inbound_at: 150, last_preview: 'sent last', unread_count: 0, status: 'open' },
  ])
  // media backfilled as pending for inbound media ids
  expect(all(raw, 'SELECT message_id,media_id,status FROM media')).toEqual([{ message_id: 3, media_id: 'media-a', status: 'pending' }])
  expect(one(raw, 'SELECT config_enc FROM adaptor_config').config_enc).toBe('v1.AAAA.BBBB')
  expect(one(raw, 'SELECT COUNT(*) n FROM stages').n).toBe(5)
  for (const t of ['lead_tags', 'activity', 'quick_replies', 'push_subscriptions']) expect(one(raw, `SELECT COUNT(*) n FROM ${t}`).n).toBe(0)
  // FKs still hold after the rebuild: deleting a contact cascades to its leads and conversation
  raw.exec('PRAGMA foreign_keys=ON')
  raw.exec('DELETE FROM contacts WHERE id=3')
  expect(one(raw, 'SELECT COUNT(*) n FROM leads WHERE contact_id=3').n).toBe(0)
}

describe('migrate(): v4 (leads rebuild, conversations, media)', () => {
  it('v2 database with data -> v4: counts equal, lead ids preserved, CHECK gone', async () => {
    const f = await legacyV2()
    populate(f.raw)
    expect(keys(f.raw)).toEqual([]) // v2 as originally shipped: no lock rows
    expect(await ensureSchema(f.d1)).toBe(LATEST)
    expectV4(f.raw)
    expect(one(f.raw, 'SELECT COUNT(*) n FROM staff').n).toBe(0)
  })

  it('v3 database with data (staff, settings, sessions present) -> v4', async () => {
    const f = await legacyV3()
    populate(f.raw)
    f.raw.exec(`INSERT INTO staff (id,email,name,role,pw_hash) VALUES (1,'a@example.com','A','admin','x')`)
    f.raw.exec(`INSERT INTO settings (key,value) VALUES ('timezone','"UTC"')`)
    f.raw.exec(`INSERT INTO sessions (id_hash,staff_id,expires_at) VALUES ('h',1,99999999999)`)
    expect(await ensureSchema(f.d1)).toBe(LATEST)
    expectV4(f.raw)
    expect(one(f.raw, 'SELECT COUNT(*) n FROM staff').n).toBe(1)
    expect(one(f.raw, 'SELECT COUNT(*) n FROM sessions').n).toBe(1)
    expect(one(f.raw, `SELECT value FROM settings WHERE key='timezone'`).value).toBe('"UTC"')
  })

  it('an empty v3 database upgrades cleanly (no leads, no messages)', async () => {
    const f = await legacyV3()
    expect(await ensureSchema(f.d1)).toBe(LATEST)
    expect(one(f.raw, 'SELECT COUNT(*) n FROM leads').n).toBe(0)
    expect(one(f.raw, 'SELECT COUNT(*) n FROM conversations').n).toBe(0)
  })

  it('a failure mid-step rolls the whole batch back: old leads table, CHECK, version and lock untouched', async () => {
    const f = await legacyV3()
    populate(f.raw)
    f.raw.exec(`CREATE TABLE quick_replies (id INTEGER)`) // collides with a statement near the END of the v4 batch
    await expect(ensureSchema(f.d1)).rejects.toThrow()
    expect(one(f.raw, `SELECT value FROM meta WHERE key='schema_version'`).value).toBe('3')
    expect(keys(f.raw)).toEqual(['applied_1', 'applied_2', 'applied_3'])
    expect(one(f.raw, 'SELECT COUNT(*) n FROM leads').n).toBe(4)
    expect(one(f.raw, `SELECT sql FROM sqlite_master WHERE name='leads'`).sql).toMatch(/CHECK/i)
    expect(one(f.raw, `SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('leads_v4','conversations','media','activity','lead_tags','push_subscriptions')`).n).toBe(0)
  })

  it('concurrent migrate from v3: exactly one isolate applies v4, the other recovers', async () => {
    const a = await legacyV3()
    populate(a.raw)
    const b = fakeD1(a.raw)
    let rejected = 0
    for (const h of [a.d1, b.d1]) {
      const real = h.batch.bind(h)
      ;(h as any).batch = async (s: any) => { try { return await real(s) } catch (e) { rejected++; throw e } }
    }
    const res = await Promise.allSettled([ensureSchema(a.d1), ensureSchema(b.d1)])
    expect(res.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled'])
    // The loser's whole batch (rebuild included) was rolled back by the applied_4 lock row. The racers then run the
    // later steps in lockstep too, so each later step can add a rejected batch: at least one, never zero.
    expect(rejected).toBeGreaterThanOrEqual(1)
    for (let n = 4; n <= LATEST; n++) expect(one(a.raw, `SELECT COUNT(*) n FROM meta WHERE key='applied_${n}'`).n).toBe(1)
    expect(one(a.raw, `SELECT COUNT(*) n FROM meta WHERE key='applied_4'`).n).toBe(1)
    expect(one(a.raw, 'SELECT COUNT(*) n FROM leads').n).toBe(4)
    expect(one(a.raw, 'SELECT COUNT(*) n FROM conversations').n).toBe(2)
  })
})

describe('migrate(): fresh and repeat', () => {
  it('a fresh database ends at the latest version with every applied_ lock, and a second run changes nothing', async () => {
    const f = fakeD1()
    expect(await ensureSchema(f.d1)).toBe(LATEST)
    expect(keys(f.raw)).toEqual(ALL_LOCKS)
    const g = fakeD1(f.raw)
    expect(await ensureSchema(g.d1)).toBe(LATEST)
    expect(keys(f.raw)).toEqual(ALL_LOCKS)
    f.raw.exec(`INSERT INTO contacts (id) VALUES (1)`)
    f.raw.exec(`INSERT INTO leads (contact_id,source) VALUES (1,'manual')`) // CHECK gone on a fresh DB too
  })

  it('concurrent migrate on an empty database also converges', async () => {
    const a = fakeD1()
    const b = fakeD1(a.raw)
    const res = await Promise.allSettled([ensureSchema(a.d1), ensureSchema(b.d1)])
    expect(res.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(keys(a.raw)).toEqual(ALL_LOCKS)
  })

  it('AUTOINCREMENT counter survives the rebuild: a deleted top id is never reused', async () => {
    const f = await legacyV3()
    f.raw.exec(`INSERT INTO contacts (id,phone) VALUES (1,'15550000001')`)
    f.raw.exec(`INSERT INTO leads (id,contact_id,source) VALUES (5,1,'whatsapp'),(9,1,'whatsapp'),(12,1,'whatsapp')`)
    f.raw.exec(`DELETE FROM leads WHERE id=12`)
    expect(one(f.raw, `SELECT seq FROM sqlite_sequence WHERE name='leads'`).seq).toBe(12)
    await ensureSchema(f.d1)
    expect(all(f.raw, 'SELECT id FROM leads ORDER BY id').map((r) => r.id)).toEqual([5, 9])
    expect(one(f.raw, `SELECT seq FROM sqlite_sequence WHERE name='leads'`).seq).toBe(12)
    f.raw.exec(`INSERT INTO leads (contact_id,source) VALUES (1,'manual')`)
    expect(one(f.raw, 'SELECT MAX(id) m FROM leads').m).toBe(13)
    expect(one(f.raw, `SELECT COUNT(*) n FROM sqlite_sequence WHERE name IN ('leads','leads_v4') `).n).toBe(1)
  })

  it('counter also survives when every lead was deleted', async () => {
    const f = await legacyV3()
    f.raw.exec(`INSERT INTO contacts (id,phone) VALUES (1,'15550000001')`)
    f.raw.exec(`INSERT INTO leads (id,contact_id,source) VALUES (7,1,'whatsapp')`)
    f.raw.exec(`DELETE FROM leads`)
    await ensureSchema(f.d1)
    f.raw.exec(`INSERT INTO leads (contact_id,source) VALUES (1,'manual')`)
    expect(one(f.raw, 'SELECT MAX(id) m FROM leads').m).toBe(8)
  })
})

describe('migrate(): v5 (polling indexes)', () => {
  const idx = (raw: Raw) => all<{ name: string }>(raw, `SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'conversations_%' ORDER BY name`).map((r) => r.name)
  const plan = (raw: Raw, sql: string) => all<{ detail: string }>(raw, `EXPLAIN QUERY PLAN ${sql}`).map((r) => r.detail).join(' | ')

  it('v4 -> v5 adds only the two indexes: data, ids and other tables untouched, lock applied_5 written', async () => {
    const f = await legacyV4()
    populate(f.raw)
    f.raw.exec(`INSERT INTO conversations (contact_id,last_message_at,last_inbound_at,last_preview,unread_count) VALUES (1,300,300,'x',2),(2,160,150,'y',0)`)
    expect(idx(f.raw)).toEqual(['conversations_last_idx'])
    const before = { leads: all(f.raw, 'SELECT * FROM leads ORDER BY id'), msgs: all(f.raw, 'SELECT * FROM messages ORDER BY id'), conv: all(f.raw, 'SELECT * FROM conversations ORDER BY contact_id') }
    expect(await ensureSchema(f.d1)).toBe(LATEST)
    expect(one(f.raw, `SELECT value FROM meta WHERE key='schema_version'`).value).toBe(String(LATEST))
    expect(keys(f.raw)).toEqual(ALL_LOCKS)
    expect(idx(f.raw)).toEqual(['conversations_last_idx', 'conversations_list_idx', 'conversations_unread_idx'])
    // later steps add nullable columns (messages.origin): compare the original columns only
    const msgs = all(f.raw, 'SELECT * FROM messages ORDER BY id').map(({ origin: _o, ...m }: any) => m)
    expect({ leads: all(f.raw, 'SELECT * FROM leads ORDER BY id'), msgs, conv: all(f.raw, 'SELECT * FROM conversations ORDER BY contact_id') }).toEqual(before)
    expect(await ensureSchema(fakeD1(f.raw).d1)).toBe(LATEST) // a second isolate re-runs nothing
    expect(keys(f.raw)).toEqual(ALL_LOCKS)
  })

  it('the badge count reads only the partial index; the list is served in order from the list index', async () => {
    const f = fakeD1(); await ensureSchema(f.d1)
    expect(plan(f.raw, `SELECT COUNT(*) AS n FROM conversations WHERE unread_count > 0`)).toMatch(/COVERING INDEX conversations_unread_idx/)
    const list = plan(f.raw, `SELECT v.contact_id, (v.unread_count > 0) AS has_unread FROM conversations v JOIN contacts c ON c.id = v.contact_id
      ORDER BY has_unread DESC, v.last_message_at DESC, v.contact_id DESC LIMIT 31`)
    expect(list).toMatch(/conversations_list_idx/)
    expect(list).not.toMatch(/TEMP B-TREE/)
  })

  it('two isolates upgrading v4 concurrently: one applies v5, the other recovers', async () => {
    const a = await legacyV4(); const b = fakeD1(a.raw)
    const res = await Promise.allSettled([ensureSchema(a.d1), ensureSchema(b.d1)])
    expect(res.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(one(a.raw, `SELECT COUNT(*) n FROM meta WHERE key='applied_5'`).n).toBe(1)
  })
})

describe('migrate(): v6 (templates)', () => {
  it('v5 -> v6 adds the templates table only: rows preserved, lock applied_6 written, second isolate re-runs nothing', async () => {
    const f = await legacyV5()
    populate(f.raw)
    const before = { leads: all(f.raw, 'SELECT * FROM leads ORDER BY id'), msgs: all(f.raw, 'SELECT * FROM messages ORDER BY id') }
    expect(all(f.raw, `SELECT name FROM sqlite_master WHERE name='templates'`)).toEqual([])
    expect(await ensureSchema(f.d1)).toBe(LATEST)
    expect(one(f.raw, `SELECT value FROM meta WHERE key='schema_version'`).value).toBe(String(LATEST))
    expect(keys(f.raw)).toEqual(ALL_LOCKS)
    expect({ leads: all(f.raw, 'SELECT * FROM leads ORDER BY id'), msgs: all(f.raw, 'SELECT * FROM messages ORDER BY id').map(({ origin: _o, ...m }: any) => m) }).toEqual(before)
    f.raw.exec(`INSERT INTO templates (id,name,language) VALUES ('t1','hello','en')`)
    expect(() => f.raw.exec(`INSERT INTO templates (id,name,language) VALUES ('t2','hello','en')`)).toThrow() // unique (name, language)
    expect(one(f.raw, `SELECT status, header_format, body_params_count FROM templates`)).toEqual({ status: 'PENDING', header_format: 'NONE', body_params_count: 0 })
    expect(await ensureSchema(fakeD1(f.raw).d1)).toBe(LATEST)
    expect(keys(f.raw)).toEqual(ALL_LOCKS)
  })
})

// The flow engine's step, after the templates step. Positional: renumber when another slice's step lands before it.
const FLOW_STEP = 7

describe('migrate(): flow engine step (flows, flow_runs, messages.origin)', () => {
  const tables = (raw: Raw) => all<{ name: string }>(raw, `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('flows','flow_runs') ORDER BY name`).map((r) => r.name)

  it('v5 database with rows -> adds the tables, keeps every row, writes its lock and the version', async () => {
    const f = await legacyV5()
    populate(f.raw)
    expect(tables(f.raw)).toEqual([])
    const before = { leads: all(f.raw, 'SELECT * FROM leads ORDER BY id'), msgs: all(f.raw, 'SELECT * FROM messages ORDER BY id'), contacts: all(f.raw, 'SELECT * FROM contacts ORDER BY id') }
    await ensureSchema(f.d1)
    expect(tables(f.raw)).toEqual(['flow_runs', 'flows'])
    expect(keys(f.raw)).toContain(`applied_${FLOW_STEP}`)
    expect(Number(one(f.raw, `SELECT value FROM meta WHERE key='schema_version'`).value)).toBeGreaterThanOrEqual(FLOW_STEP)
    const after = { leads: all(f.raw, 'SELECT * FROM leads ORDER BY id'), msgs: all(f.raw, 'SELECT * FROM messages ORDER BY id'), contacts: all(f.raw, 'SELECT * FROM contacts ORDER BY id') }
    // existing rows are byte-identical except the new nullable column on messages
    expect(after.leads).toEqual(before.leads)
    // (v9 adds the nullable opt-out columns to contacts: compare the original columns only)
    expect(after.contacts.map(({ opted_out_at, opt_out_source, ...c }: any) => c)).toEqual(before.contacts)
    expect(after.msgs.map((m: any) => ({ ...m, origin: undefined }))).toEqual(before.msgs.map((m: any) => ({ ...m, origin: undefined })))
    expect(after.msgs.every((m: any) => m.origin === null)).toBe(true)
    expect(one(f.raw, 'SELECT COUNT(*) n FROM leads').n).toBe(4)
  })

  it('the unique indexes hold: one run per idem_key, one live run per (flow, lead, shadow)', async () => {
    const f = fakeD1(); await ensureSchema(f.d1)
    f.raw.exec(`INSERT INTO contacts (id,phone) VALUES (1,'15550000001')`)
    f.raw.exec(`INSERT INTO leads (id,contact_id,source,status) VALUES (1,1,'whatsapp','new'),(2,1,'whatsapp','new')`)
    f.raw.exec(`INSERT INTO flows (id,name) VALUES (1,'a')`)
    const ins = (lead: number, status: string, idem: string | null) => f.raw.prepare(`INSERT INTO flow_runs (flow_id,flow_version,lead_id,contact_id,status,trigger,idem_key,snapshot,context) VALUES (1,1,?,1,?,'t',?,'{}','{}')`).run(lead, status, idem)
    ins(1, 'running', 'k1')
    expect(() => ins(2, 'running', 'k1')).toThrow(/UNIQUE/) // same idem_key
    expect(() => ins(1, 'awaiting', 'k2')).toThrow(/UNIQUE/) // second live run for the same lead
    // a shadow run coexists with the live one: it neither blocks nor is blocked by it
    f.raw.prepare(`INSERT INTO flow_runs (flow_id,flow_version,lead_id,contact_id,status,shadow,trigger,idem_key,snapshot,context) VALUES (1,1,1,1,'awaiting',1,'t','k3','{}','{}')`).run()
    expect(() => f.raw.prepare(`INSERT INTO flow_runs (flow_id,flow_version,lead_id,contact_id,status,shadow,trigger,idem_key,snapshot,context) VALUES (1,1,1,1,'running',1,'t','k4','{}','{}')`).run()).toThrow(/UNIQUE/)
    expect(one(f.raw, `SELECT step FROM flow_runs WHERE idem_key='k1'`).step).toBe(0) // the resume lock counter starts at 0
    ins(2, 'completed', null); ins(2, 'completed', null) // finished runs and null keys repeat freely
    expect(() => f.raw.prepare(`INSERT INTO flows (name) VALUES ('a')`).run()).toThrow(/UNIQUE/)
  })

  it('the tick queries use the partial indexes', async () => {
    const f = fakeD1(); await ensureSchema(f.d1)
    const plan = (sql: string) => all<{ detail: string }>(f.raw, `EXPLAIN QUERY PLAN ${sql}`).map((r) => r.detail).join(' | ')
    expect(plan(`SELECT id FROM flow_runs WHERE status='awaiting' AND resume_at <= 5 ORDER BY resume_at LIMIT 10`)).toMatch(/flow_runs_due/)
    expect(plan(`UPDATE flow_runs SET status='failed' WHERE status='running' AND updated_at < 5`)).toMatch(/flow_runs_running/)
  })
})

describe('migrate(): v8 (reports indexes)', () => {
  it('v7 (flows) -> v8 adds the three indexes only: flows and rows preserved, lock applied_8 written, second isolate re-runs nothing', async () => {
    const f = await legacyV7()
    populate(f.raw)
    f.raw.exec(`INSERT INTO flows (id,name) VALUES (1,'Welcome')`)
    const before = { leads: all(f.raw, 'SELECT * FROM leads ORDER BY id'), msgs: all(f.raw, 'SELECT * FROM messages ORDER BY id'), flows: all(f.raw, 'SELECT * FROM flows') }
    expect(keys(f.raw)).toContain('applied_7')
    expect(keys(f.raw)).not.toContain('applied_8')
    expect(await ensureSchema(f.d1)).toBe(LATEST)
    expect(one(f.raw, `SELECT value FROM meta WHERE key='schema_version'`).value).toBe(String(LATEST))
    expect(keys(f.raw)).toContain('applied_8')
    expect(keys(f.raw)).toEqual(ALL_LOCKS)
    expect(all(f.raw, `SELECT name FROM sqlite_master WHERE name IN ('messages_ts_idx','leads_ad_source_idx','leads_external_idx') ORDER BY name`).map((r) => r.name)).toEqual(['leads_ad_source_idx', 'leads_external_idx', 'messages_ts_idx'])
    expect({ leads: all(f.raw, 'SELECT * FROM leads ORDER BY id'), msgs: all(f.raw, 'SELECT * FROM messages ORDER BY id'), flows: all(f.raw, 'SELECT * FROM flows') }).toEqual(before)
    expect(await ensureSchema(fakeD1(f.raw).d1)).toBe(LATEST)
    expect(keys(f.raw)).toEqual(ALL_LOCKS)
  })
})

describe('migrate(): v9 (broadcasts)', () => {
  it('v8 -> v9 adds the opt-out columns, template quality, both broadcast tables and the partial indexes; rows preserved', async () => {
    const f = await legacyV8()
    populate(f.raw)
    const before = all(f.raw, 'SELECT * FROM contacts ORDER BY id')
    expect(keys(f.raw)).not.toContain('applied_9')
    expect(await ensureSchema(f.d1)).toBe(9)
    expect(keys(f.raw)).toContain('applied_9')
    expect(all(f.raw, `SELECT name FROM sqlite_master WHERE name IN ('broadcasts','broadcast_recipients','broadcasts_status','broadcast_recipients_queue','broadcast_recipients_wamid','contacts_opted_out') ORDER BY name`).map((r) => r.name))
      .toEqual(['broadcast_recipients', 'broadcast_recipients_queue', 'broadcast_recipients_wamid', 'broadcasts', 'broadcasts_status', 'contacts_opted_out'])
    // partial indexes are accepted and used
    expect(all<{ sql: string }>(f.raw, `SELECT sql FROM sqlite_master WHERE name='contacts_opted_out'`)[0].sql).toMatch(/WHERE opted_out_at IS NOT NULL/)
    expect(all<{ detail: string }>(f.raw, `EXPLAIN QUERY PLAN SELECT id FROM contacts WHERE opted_out_at IS NOT NULL`).map((r) => r.detail).join('|')).toMatch(/contacts_opted_out/)
    expect(all(f.raw, 'SELECT * FROM contacts ORDER BY id').map(({ opted_out_at, opt_out_source, ...c }: any) => c)).toEqual(before)
    expect(one(f.raw, `SELECT opted_out_at FROM contacts WHERE id=1`).opted_out_at).toBeNull()
    expect(await ensureSchema(fakeD1(f.raw).d1)).toBe(9)
    expect(keys(f.raw)).toEqual(ALL_LOCKS)
  })
})
