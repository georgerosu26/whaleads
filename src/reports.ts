// Reports: one overview for a date range in the instance timezone. Every query is bounded by a created_at /
// timestamp range that an index serves (leads_created_idx, messages_ts_idx); the aggregation runs in JS over one
// compact lead-row query, so the numbers (median, p90, ISO weeks across DST) are computed in one place and testable.
import type { Env } from './db'
import { isTimezone, localDate, zonedToEpoch } from './daytime'
import { getSettings } from './settings'
import { Bad, nowSec } from './crm'

export const MAX_RANGE_DAYS = 366
export const LEAD_CAP = 100_000
const SLOT = 900 // seconds; message counts are grouped in 15-minute slots so any real tz offset lands on a boundary

export interface SourceRow {
  key: string; label: string; leads: number; won: number; lost: number; conversion: number
  campaigns?: { source_id: string | null; headline: string | null; leads: number; won: number; lost: number }[]
}
export interface Overview {
  range: { from: string; to: string; from_ts: number; to_ts: number; timezone: string; days: number }
  totals: {
    leads: number; won: number; lost: number; open: number; conversion: number; win_rate: number
    responded: number; median_first_response_s: number | null; p90_first_response_s: number | null; unanswered_now: number
  }
  by_source: SourceRow[]
  by_stage: { key: string; label: string; kind: string; leads: number }[]
  weekly: { week_start: string; label: string; leads: number; messages_in: number; messages_out: number }[]
  by_staff: { id: number | null; name: string; leads: number; won: number; responded: number; median_first_response_s: number | null }[]
  truncated: boolean
}

export interface LeadFacts {
  created_at: number; source: string; kind: 'open' | 'won' | 'lost'; stage: string; assigned_to: number | null
  first_response_at: number | null; ad_source_id: string | null; headline: string | null
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
export function parseDate(s: string | null, field: string): [number, number, number] | null {
  if (s === null || s === '') return null
  const m = DATE.exec(s)
  if (!m) throw new Bad(`${field} must be YYYY-MM-DD`, field)
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const t = new Date(Date.UTC(y, mo - 1, d))
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) throw new Bad(`${field} is not a real date`, field)
  return [y, mo, d]
}
const ymd = (p: [number, number, number]) => `${p[0]}-${String(p[1]).padStart(2, '0')}-${String(p[2]).padStart(2, '0')}`
const addDays = (p: [number, number, number], n: number): [number, number, number] => {
  const t = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n))
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()]
}
const dayNum = (p: [number, number, number]) => Date.UTC(p[0], p[1] - 1, p[2]) / 86_400_000

/** Median (mean of the two middle values when even) and nearest-rank p90 of a numeric list. */
export function median(v: number[]): number | null {
  if (!v.length) return null
  const s = [...v].sort((a, b) => a - b), m = s.length >> 1
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2)
}
export function percentile(v: number[], p: number): number | null {
  if (!v.length) return null
  const s = [...v].sort((a, b) => a - b)
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)]
}
const ratio = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 1000 : 0)

/** ISO week number (Monday start) of a calendar date. */
export function isoWeek(p: [number, number, number]): number {
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]))
  const dow = (d.getUTCDay() + 6) % 7 // Monday = 0
  d.setUTCDate(d.getUTCDate() - dow + 3) // the Thursday of this week decides the year
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4))
  return 1 + Math.round(((d.getTime() - jan4.getTime()) / 86_400_000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7)
}

export interface Weeks { starts: number[]; keys: string[]; labels: string[] }
/** Local-midnight epochs of every ISO week (Monday) touching [from, to], so a row maps to its week by binary search. */
export function weekBounds(from: [number, number, number], to: [number, number, number], tz: string): Weeks {
  const start = addDays(from, -((new Date(Date.UTC(from[0], from[1] - 1, from[2])).getUTCDay() + 6) % 7))
  const starts: number[] = [], keys: string[] = [], labels: string[] = []
  for (let p = start; dayNum(p) <= dayNum(to); p = addDays(p, 7)) {
    starts.push(zonedToEpoch(p[0], p[1], p[2], 0, 0, tz)); keys.push(ymd(p)); labels.push('W' + String(isoWeek(p)).padStart(2, '0'))
  }
  return { starts, keys, labels }
}
export function weekIndex(starts: number[], ts: number): number {
  let lo = 0, hi = starts.length - 1, ans = -1
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (starts[mid] <= ts) { ans = mid; lo = mid + 1 } else hi = mid - 1 }
  return ans
}

export interface Dim { stages: { key: string; label: string; kind: string }[]; sources: { key: string; label: string }[]; staff: { id: number; name: string }[] }

/** Pure aggregation over the cohort (leads created in range). */
export function aggregate(leads: LeadFacts[], weeks: Weeks, msgSlots: { slot: number; direction: string; n: number }[], dim: Dim, unanswered: number) {
  const lead = (l: LeadFacts) => ({ won: l.kind === 'won' ? 1 : 0, lost: l.kind === 'lost' ? 1 : 0 })
  const weekly = weeks.keys.map((k, i) => ({ week_start: k, label: weeks.labels[i], leads: 0, messages_in: 0, messages_out: 0 }))
  const srcMap = new Map<string, SourceRow & { _c: Map<string, { source_id: string | null; headline: string | null; leads: number; won: number; lost: number }> }>()
  for (const s of dim.sources) srcMap.set(s.key, { key: s.key, label: s.label, leads: 0, won: 0, lost: 0, conversion: 0, _c: new Map() })
  const stageCount = new Map<string, number>()
  const staffMap = new Map<number | null, { leads: number; won: number; fr: number[] }>()
  const frAll: number[] = []
  let won = 0, lost = 0
  for (const l of leads) {
    const wi = weekIndex(weeks.starts, l.created_at)
    if (wi >= 0) weekly[wi].leads++
    const { won: w, lost: x } = lead(l)
    won += w; lost += x
    let s = srcMap.get(l.source)
    if (!s) { s = { key: l.source, label: l.source, leads: 0, won: 0, lost: 0, conversion: 0, _c: new Map() }; srcMap.set(l.source, s) }
    s.leads++; s.won += w; s.lost += x
    if (l.source === 'ctwa') {
      const ck = l.ad_source_id ?? ''
      let c = s._c.get(ck)
      if (!c) { c = { source_id: l.ad_source_id, headline: l.headline, leads: 0, won: 0, lost: 0 }; s._c.set(ck, c) }
      if (!c.headline && l.headline) c.headline = l.headline
      c.leads++; c.won += w; c.lost += x
    }
    stageCount.set(l.stage, (stageCount.get(l.stage) ?? 0) + 1)
    let st = staffMap.get(l.assigned_to)
    if (!st) { st = { leads: 0, won: 0, fr: [] }; staffMap.set(l.assigned_to, st) }
    st.leads++; st.won += w
    if (l.first_response_at !== null && l.first_response_at >= l.created_at) {
      const d = l.first_response_at - l.created_at
      frAll.push(d); st.fr.push(d)
    }
  }
  for (const m of msgSlots) {
    const wi = weekIndex(weeks.starts, m.slot * SLOT)
    if (wi < 0) continue
    if (m.direction === 'in') weekly[wi].messages_in += m.n; else weekly[wi].messages_out += m.n
  }
  const by_source: SourceRow[] = [...srcMap.values()].filter((s) => s.leads > 0).map(({ _c, ...s }) => ({
    ...s, conversion: ratio(s.won, s.leads),
    ...(_c.size ? { campaigns: [..._c.values()].sort((a, b) => b.leads - a.leads || (a.source_id ?? '').localeCompare(b.source_id ?? '')) } : {}),
  })).sort((a, b) => b.leads - a.leads || a.label.localeCompare(b.label))
  const known = new Set(dim.stages.map((s) => s.key))
  const by_stage = [...dim.stages.map((s) => ({ ...s, leads: stageCount.get(s.key) ?? 0 })),
    ...[...stageCount].filter(([k]) => !known.has(k)).map(([k, n]) => ({ key: k, label: k, kind: 'open', leads: n }))]
  const names = new Map(dim.staff.map((s) => [s.id, s.name]))
  const by_staff = [...staffMap].map(([id, v]) => ({
    id, name: id === null ? 'Unassigned' : names.get(id) ?? `Staff ${id}`, leads: v.leads, won: v.won, responded: v.fr.length, median_first_response_s: median(v.fr),
  })).sort((a, b) => b.leads - a.leads || a.name.localeCompare(b.name))
  return {
    totals: {
      leads: leads.length, won, lost, open: leads.length - won - lost, conversion: ratio(won, leads.length), win_rate: ratio(won, won + lost),
      responded: frAll.length, median_first_response_s: median(frAll), p90_first_response_s: percentile(frAll, 90), unanswered_now: unanswered,
    },
    by_source, by_stage, weekly, by_staff,
  }
}

export async function overview(env: Env, fromQ: string | null, toQ: string | null, now = nowSec()): Promise<Overview> {
  const cfg = await getSettings(env)
  const tz = isTimezone(cfg.timezone) ? cfg.timezone : 'UTC'
  const toP = parseDate(toQ, 'to') ?? parseDate(localDate(now, tz), 'to')!
  const fromP = parseDate(fromQ, 'from') ?? addDays(toP, -29)
  const days = dayNum(toP) - dayNum(fromP) + 1
  if (days < 1) throw new Bad('from must not be after to', 'from')
  if (days > MAX_RANGE_DAYS) throw new Bad('the range is at most 12 months', 'from')
  const fromTs = zonedToEpoch(fromP[0], fromP[1], fromP[2], 0, 0, tz)
  const next = addDays(toP, 1)
  const toTs = zonedToEpoch(next[0], next[1], next[2], 0, 0, tz)
  const weeks = weekBounds(fromP, toP, tz)

  const [leadRes, msgRes, stageRes, srcRes, staffRes, un] = await Promise.all([
    env.DB.prepare(
      `SELECT created_at, source, status, assigned_to, first_response_at, ad_source_id, json_extract(attribution,'$.headline') AS headline
         FROM leads WHERE created_at >= ?1 AND created_at < ?2 ORDER BY created_at LIMIT ?3`,
    ).bind(fromTs, toTs, LEAD_CAP + 1).all<{ created_at: number; source: string; status: string; assigned_to: number | null; first_response_at: number | null; ad_source_id: string | null; headline: string | null }>(),
    env.DB.prepare(
      `SELECT timestamp / ${SLOT} AS slot, direction, COUNT(*) AS n FROM messages WHERE timestamp >= ?1 AND timestamp < ?2 GROUP BY slot, direction`,
    ).bind(fromTs, toTs).all<{ slot: number; direction: string; n: number }>(),
    env.DB.prepare(`SELECT key,label,kind FROM stages ORDER BY archived, position, key`).all<{ key: string; label: string; kind: string }>(),
    env.DB.prepare(`SELECT key,label FROM sources`).all<{ key: string; label: string }>(),
    env.DB.prepare(`SELECT id,name FROM staff`).all<{ id: number; name: string }>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM conversations WHERE status='open' AND unread_count > 0`).first<{ n: number }>(),
  ])
  const kinds = new Map(stageRes.results.map((s) => [s.key, s.kind as 'open' | 'won' | 'lost']))
  const truncated = leadRes.results.length > LEAD_CAP
  const facts: LeadFacts[] = leadRes.results.slice(0, LEAD_CAP).map((r) => ({
    created_at: r.created_at, source: r.source, stage: r.status, kind: kinds.get(r.status) ?? 'open', assigned_to: r.assigned_to,
    first_response_at: r.first_response_at, ad_source_id: r.ad_source_id, headline: r.headline,
  }))
  const agg = aggregate(facts, weeks, msgRes.results, { stages: stageRes.results, sources: srcRes.results, staff: staffRes.results }, un?.n ?? 0)
  return { range: { from: ymd(fromP), to: ymd(toP), from_ts: fromTs, to_ts: toTs, timezone: tz, days }, ...agg, truncated }
}

