// Who a broadcast reaches (plan D1 audience.ts, D25). One recipient per CONTACT: a contact matched through two leads gets
// one message (the newest lead's values). Opted-out contacts and contacts without a phone are excluded and counted
// separately from duplicates. Resolution is pure SQL over lead_tags / leads / contacts.
import { paramsSql, PARAM_JOINS, type ParamsSpec } from './params'

export interface Filter { tags: number[]; tag_mode: 'any' | 'all'; stage: string | null; all: boolean }
export const MAX_TAGS = 25
/** Free-plan sizing: start inserts ~5,000 recipients per D1 call. */
export const MAX_AUDIENCE = 50_000
export const CHUNK = 500

export type FilterCheck = { ok: true; filter: Filter } | { ok: false; error: string; field: string }

/** The stored/posted filter. No tags and no stage is "all contacts" and must say so (`all: true`). */
export function parseFilter(raw: unknown): FilterCheck {
  const r = (raw ?? {}) as Record<string, unknown>
  if (typeof r !== 'object' || Array.isArray(r)) return { ok: false, error: 'filter must be an object.', field: 'filter' }
  const tagsIn = r.tags === undefined || r.tags === null ? [] : r.tags
  if (!Array.isArray(tagsIn)) return { ok: false, error: 'filter.tags must be a list of tag ids.', field: 'filter' }
  const tags = [...new Set(tagsIn.map(Number))]
  if (tags.some((t) => !Number.isInteger(t) || t < 1)) return { ok: false, error: 'filter.tags must be tag ids.', field: 'filter' }
  if (tags.length > MAX_TAGS) return { ok: false, error: `At most ${MAX_TAGS} tags.`, field: 'filter' }
  const mode = r.tag_mode === 'all' ? 'all' : r.tag_mode === undefined || r.tag_mode === 'any' ? 'any' : null
  if (!mode) return { ok: false, error: 'filter.tag_mode must be "any" or "all".', field: 'filter' }
  const stage = typeof r.stage === 'string' && r.stage ? r.stage : null
  if (r.stage !== undefined && r.stage !== null && r.stage !== '' && !stage) return { ok: false, error: 'filter.stage must be a stage key.', field: 'filter' }
  const all = r.all === true
  if (!tags.length && !stage && !all) return { ok: false, error: 'Pick at least one tag or a stage, or confirm that you mean all contacts.', field: 'filter' }
  if (all && (tags.length || stage)) return { ok: false, error: '"all contacts" cannot be combined with tags or a stage.', field: 'filter' }
  return { ok: true, filter: { tags, tag_mode: mode, stage, all } }
}

export const DEST = `COALESCE(NULLIF(c.wa_id, ''), NULLIF(c.phone, ''))`

/** `WITH m, p`: m = matching leads (or every contact), p = one row per contact with the newest matching lead. */
function cte(f: Filter, bind: (v: unknown) => string): string {
  if (f.all) {
    return `m AS (SELECT (SELECT MAX(id) FROM leads WHERE contact_id = c.id) AS lead_id, c.id AS contact_id FROM contacts c),
      p AS (SELECT contact_id, MAX(lead_id) AS lead_id FROM m GROUP BY contact_id)`
  }
  const where: string[] = []
  if (f.stage) where.push(`l.status = ${bind(f.stage)}`)
  if (f.tags.length) {
    const ids = f.tags.join(',') // validated integers
    where.push(f.tag_mode === 'all'
      ? `(SELECT COUNT(DISTINCT t.tag_id) FROM lead_tags t WHERE t.lead_id = l.id AND t.tag_id IN (${ids})) = ${f.tags.length}`
      : `EXISTS (SELECT 1 FROM lead_tags t WHERE t.lead_id = l.id AND t.tag_id IN (${ids}))`)
  }
  return `m AS (SELECT l.id AS lead_id, l.contact_id FROM leads l WHERE ${where.join(' AND ')}),
    p AS (SELECT contact_id, MAX(lead_id) AS lead_id FROM m GROUP BY contact_id)`
}

const binder = () => {
  const binds: unknown[] = []
  return { binds, bind: (v: unknown) => { binds.push(v); return `?${binds.length}` } }
}

export interface AudienceCounts { matched: number; contacts: number; total: number; excluded: { opted_out: number; no_phone: number; duplicate: number }; excluded_total: number }
export interface SampleRow { contact_id: number; lead_id: number | null; name: string | null; phone: string | null; params: string | null }

export async function resolveAudience(db: D1Database, f: Filter, spec: ParamsSpec | null, sampleSize = 5): Promise<AudienceCounts & { sample: SampleRow[] }> {
  const c = binder()
  const counts = db.prepare(
    `WITH ${cte(f, c.bind)}
     SELECT (SELECT COUNT(*) FROM m) AS matched, COUNT(*) AS contacts,
       COALESCE(SUM(c.opted_out_at IS NOT NULL), 0) AS opted_out,
       COALESCE(SUM(c.opted_out_at IS NULL AND ${DEST} IS NULL), 0) AS no_phone
     FROM p JOIN contacts c ON c.id = p.contact_id`,
  ).bind(...c.binds)
  const s = binder()
  const withCte = cte(f, s.bind)
  const paramExpr = spec ? paramsSql(spec, s.bind) : 'NULL'
  const lim = s.bind(sampleSize)
  const sample = db.prepare(
    `WITH ${withCte}
     SELECT c.id AS contact_id, p.lead_id, c.name, ${DEST} AS phone, ${paramExpr} AS params
     FROM p JOIN contacts c ON c.id = p.contact_id ${PARAM_JOINS}
     WHERE c.opted_out_at IS NULL AND ${DEST} IS NOT NULL ORDER BY c.id LIMIT ${lim}`,
  ).bind(...s.binds)
  const [a, b] = await db.batch([counts, sample])
  const r = (a!.results[0] ?? {}) as Record<string, number>
  const matched = Number(r.matched ?? 0), contacts = Number(r.contacts ?? 0)
  const opted_out = Number(r.opted_out ?? 0), no_phone = Number(r.no_phone ?? 0)
  const duplicate = Math.max(0, matched - contacts)
  return {
    matched, contacts, total: contacts - opted_out - no_phone,
    excluded: { opted_out, no_phone, duplicate }, excluded_total: opted_out + no_phone + duplicate,
    sample: (b!.results as SampleRow[]),
  }
}

/** Ids of every sendable contact, ascending: the boundaries for the chunked recipient insert. */
export async function sendableIds(db: D1Database, f: Filter): Promise<number[]> {
  const c = binder()
  const { results } = await db.prepare(
    `WITH ${cte(f, c.bind)}
     SELECT c.id FROM p JOIN contacts c ON c.id = p.contact_id WHERE c.opted_out_at IS NULL AND ${DEST} IS NOT NULL ORDER BY c.id`,
  ).bind(...c.binds).all<{ id: number }>()
  return results.map((r) => r.id)
}

/** Recipients with contact ids in (lo, hi], params frozen from the fields as they are now. INSERT OR IGNORE: safe to repeat. */
export function insertRecipients(db: D1Database, broadcastId: string, f: Filter, spec: ParamsSpec, now: number, lo: number, hi: number): D1PreparedStatement {
  const c = binder()
  const withCte = cte(f, c.bind)
  const bid = c.bind(broadcastId), at = c.bind(now)
  const params = paramsSql(spec, c.bind)
  const a = c.bind(lo), z = c.bind(hi)
  return db.prepare(
    `INSERT OR IGNORE INTO broadcast_recipients (broadcast_id, contact_id, lead_id, status, params, next_attempt_at, updated_at)
     WITH ${withCte}
     SELECT ${bid}, CAST(c.id AS TEXT), CAST(p.lead_id AS TEXT), 'queued', ${params}, 0, ${at}
     FROM p JOIN contacts c ON c.id = p.contact_id ${PARAM_JOINS}
     WHERE c.opted_out_at IS NULL AND ${DEST} IS NOT NULL AND c.id > ${a} AND c.id <= ${z}`,
  ).bind(...c.binds)
}

/** (lo, hi] pairs of at most CHUNK ids each, covering `ids`. */
export function chunkBounds(ids: number[]): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (let i = 0; i < ids.length; i += CHUNK) out.push([i === 0 ? 0 : ids[i - 1]!, ids[Math.min(i + CHUNK, ids.length) - 1]!])
  return out
}
