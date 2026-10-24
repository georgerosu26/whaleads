import type { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import worker from '../src/index'
import { ensureSchema, type Env } from '../src/db'
import { clearSettingsCache } from '../src/settings'
import { isoWeek, median, overview, percentile } from '../src/reports'
import { fakeD1 } from './d1'

const ORIGIN = 'https://leads.example.com'
let env: Env
let raw: DatabaseSync
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
const t = (iso: string) => Math.floor(Date.parse(iso) / 1000)
const get = (path: string, bearer: string | null = 'adminkey') =>
  worker.fetch(new Request(`${ORIGIN}${path}`, { headers: bearer ? { Authorization: `Bearer ${bearer}` } : {} }), env, ctx)

let n = 0
function lead(o: { at: string; source?: string; status?: string; fr?: number; owner?: number | null; ad?: string; headline?: string }) {
  const c = ++n
  raw.prepare(`INSERT INTO contacts (id,wa_id,phone,name) VALUES (?,?,?,?)`).run(c, `1555010${String(c).padStart(4, '0')}`, `1555010${String(c).padStart(4, '0')}`, `Person ${c}`)
  const at = t(o.at)
  raw.prepare(`INSERT INTO leads (contact_id,source,status,created_at,updated_at,assigned_to,first_response_at,ad_source_id,attribution) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(c, o.source ?? 'whatsapp', o.status ?? 'new', at, at, o.owner ?? null, o.fr === undefined ? null : at + o.fr, o.ad ?? null, o.headline ? JSON.stringify({ headline: o.headline, source_id: o.ad }) : null)
  return c
}
function msg(contact: number, dir: 'in' | 'out', at: string) {
  raw.prepare(`INSERT INTO messages (contact_id,direction,type,body,timestamp) VALUES (?,?,?,?,?)`).run(contact, dir, 'text', 'x', t(at))
}

beforeEach(async () => {
  const f = fakeD1(); raw = f.raw
  env = { DB: f.d1, ADMIN_KEY: 'adminkey', SESSION_SECRET: 'test-session-secret-0123456789', INSTANCE_NAME: 'inst', ALLOWED_ORIGINS: '' } as unknown as Env
  await ensureSchema(f.d1)
  n = 0
  raw.exec(`INSERT INTO settings (key,value) VALUES ('timezone','"Asia/Kolkata"')`)
  clearSettingsCache(f.d1)
})

describe('report maths', () => {
  it('helpers: median, nearest-rank percentile, ISO weeks', () => {
    expect(median([])).toBeNull()
    expect(median([5])).toBe(5)
    expect(median([300, 60, 120, 900])).toBe(210)
    expect(median([1, 2, 3])).toBe(2)
    expect(percentile([60, 120, 300, 900], 90)).toBe(900)
    expect(percentile(Array.from({ length: 10 }, (_, i) => i + 1), 90)).toBe(9)
    expect(isoWeek([2026, 1, 1])).toBe(1)
    expect(isoWeek([2025, 12, 29])).toBe(1)
    expect(isoWeek([2027, 1, 3])).toBe(53)
    expect(isoWeek([2026, 3, 2])).toBe(10)
  })

  it('a fixture across the Monday boundary in the instance timezone (Asia/Kolkata)', async () => {
    raw.exec(`INSERT INTO staff (id,email,name,role,pw_hash) VALUES (1,'a@example.com','Asha','staff','x')`)
    // range 2026-02-23 .. 2026-03-08 IST = 2026-02-22T18:30Z .. 2026-03-08T18:30Z (exclusive)
    lead({ at: '2026-02-22T18:30:00Z', fr: 900 }) // exactly the start: in, ISO week 9 (Mon 23 Feb)
    const a = lead({ at: '2026-02-28T10:00:00Z', fr: 60 })
    const c = lead({ at: '2026-03-01T18:29:59Z', source: 'ctwa', status: 'lost', fr: 300, ad: 'AD1', headline: 'Spring offer' }) // Sun 23:59:59 IST: week 9
    const b = lead({ at: '2026-03-01T18:30:00Z', source: 'ctwa', status: 'won', fr: 120, ad: 'AD1' }) // Mon 00:00:00 IST: week 10
    lead({ at: '2026-03-05T05:00:00Z', source: 'manual', status: 'contacted', owner: 1 })
    lead({ at: '2026-02-22T18:29:59Z' }) // one second before the range
    lead({ at: '2026-03-08T18:30:00Z' }) // exactly the (exclusive) end
    msg(a, 'in', '2026-03-01T18:29:00Z'); msg(a, 'out', '2026-03-01T18:29:30Z') // week 9
    msg(b, 'in', '2026-03-01T18:30:00Z'); msg(b, 'in', '2026-03-02T09:00:00Z'); msg(c, 'out', '2026-03-03T09:00:00Z') // week 10
    msg(c, 'in', '2026-02-22T18:29:59Z') // before the range: not counted
    raw.exec(`INSERT INTO conversations (contact_id,last_message_at,last_inbound_at,status,unread_count) VALUES (${a},200,200,'open',2),(${b},200,100,'open',0),(${c},300,300,'closed',1)`)

    const o = await overview(env, '2026-02-23', '2026-03-08')
    expect(o.range).toMatchObject({ from: '2026-02-23', to: '2026-03-08', timezone: 'Asia/Kolkata', days: 14, from_ts: t('2026-02-22T18:30:00Z'), to_ts: t('2026-03-08T18:30:00Z') })
    expect(o.totals).toMatchObject({ leads: 5, won: 1, lost: 1, open: 3, conversion: 0.2, win_rate: 0.5, responded: 4, median_first_response_s: 210, p90_first_response_s: 900, unanswered_now: 1 })
    expect(o.weekly).toEqual([
      { week_start: '2026-02-23', label: 'W09', leads: 3, messages_in: 1, messages_out: 1 },
      { week_start: '2026-03-02', label: 'W10', leads: 2, messages_in: 2, messages_out: 1 },
    ])
    expect(o.by_source.map((s) => [s.key, s.leads, s.won, s.lost, s.conversion])).toEqual([['whatsapp', 2, 0, 0, 0], ['ctwa', 2, 1, 1, 0.5], ['manual', 1, 0, 0, 0]])
    expect(o.by_source.find((s) => s.key === 'ctwa')!.campaigns).toEqual([{ source_id: 'AD1', headline: 'Spring offer', leads: 2, won: 1, lost: 1 }])
    expect(o.by_stage.map((s) => [s.key, s.leads])).toEqual([['new', 2], ['contacted', 1], ['qualified', 0], ['won', 1], ['lost', 1]])
    expect(o.by_staff).toEqual([
      { id: null, name: 'Unassigned', leads: 4, won: 1, responded: 4, median_first_response_s: 210 },
      { id: 1, name: 'Asha', leads: 1, won: 0, responded: 0, median_first_response_s: null },
    ])
    expect(o.truncated).toBe(false)
  })

  it('the same instants bucket differently in UTC (the tz boundary is real)', async () => {
    raw.exec(`UPDATE settings SET value='"UTC"' WHERE key='timezone'`); clearSettingsCache(env.DB)
    lead({ at: '2026-03-01T18:30:00Z' }) // Sunday evening UTC: week 9
    const o = await overview(env, '2026-02-23', '2026-03-08')
    expect(o.weekly.map((w) => w.leads)).toEqual([1, 0])
  })

  it('ignores a first response before creation and counts only leads that have one', async () => {
    lead({ at: '2026-03-02T05:00:00Z', fr: -50 })
    lead({ at: '2026-03-02T06:00:00Z', fr: 40 })
    lead({ at: '2026-03-02T07:00:00Z' })
    const o = await overview(env, '2026-03-02', '2026-03-02')
    expect(o.totals).toMatchObject({ leads: 3, responded: 1, median_first_response_s: 40, p90_first_response_s: 40 })
  })

  it('an empty range returns zeros and null medians, with every week present', async () => {
    const o = await overview(env, '2026-03-02', '2026-03-15')
    expect(o.totals).toMatchObject({ leads: 0, won: 0, conversion: 0, win_rate: 0, median_first_response_s: null, p90_first_response_s: null })
    expect(o.weekly.map((w) => w.week_start)).toEqual(['2026-03-02', '2026-03-09'])
    expect(o.by_source).toEqual([])
  })

  it('defaults to the last 30 days ending today in the instance timezone', async () => {
    const now = t('2026-03-10T20:00:00Z') // already 11 March in Kolkata
    const o = await overview(env, null, null, now)
    expect(o.range).toMatchObject({ from: '2026-02-10', to: '2026-03-11', days: 30 })
  })

  it('queries use the date indexes', () => {
    const plan = (sql: string) => (raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((r) => r.detail).join(' | ')
    expect(plan(`SELECT created_at FROM leads WHERE created_at >= 1 AND created_at < 2 ORDER BY created_at`)).toMatch(/leads_created_idx/)
    const m = plan(`SELECT timestamp / 900 AS slot, direction, COUNT(*) AS n FROM messages WHERE timestamp >= 1 AND timestamp < 2 GROUP BY slot, direction`)
    expect(m).toMatch(/COVERING INDEX messages_ts_idx/)
    expect(plan(`SELECT COUNT(*) AS n FROM conversations WHERE status='open' AND unread_count > 0`)).toMatch(/conversations_unread_idx/) // bounded by the unread set
    expect(plan(`SELECT l.id FROM leads l WHERE l.ad_source_id = 'x'`)).toMatch(/leads_ad_source_idx/)
  })
})

describe('GET /api/reports/overview', () => {
  it('401 without credentials, 200 with the bearer', async () => {
    expect((await get('/api/reports/overview', null)).status).toBe(401)
    const r = await get('/api/reports/overview?from=2026-03-01&to=2026-03-02')
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ ok: true, totals: { leads: 0 } })
  })
  it('rejects bad dates, an inverted range and more than 12 months', async () => {
    for (const q of ['from=nope', 'from=2026-02-30', 'from=2026-03-05&to=2026-03-01', 'from=2024-01-01&to=2026-01-01']) {
      const r = await get(`/api/reports/overview?${q}`)
      expect(r.status, q).toBe(400)
      expect(await r.json()).toMatchObject({ ok: false })
    }
    expect((await get('/api/reports/overview?from=2025-03-01&to=2026-03-01')).status).toBe(200) // 366 days is the cap
  })
})
