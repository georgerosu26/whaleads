// CRM core: lead queries, stage transitions, activity rows, Today buckets. The route files stay thin.
// Every state change writes exactly one `activity` row per changed field, in the same D1 batch as the change.
import type { Actor } from './auth'
import type { Env } from './db'
import { getSettings } from './settings'
import { isTimezone, startOfDay, startOfNextDay } from './daytime'

/** A string passes through as the label (flow engine: `flow:<id>`); a staff actor is `staff:<id>`; anything else is `api`. */
export const actorLabel = (a: Actor | string | null) => (typeof a === 'string' ? a : a?.kind === 'staff' ? `staff:${a.staff.id}` : 'api')
export const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c)
export const clampInt = (v: string | null, dflt: number, min: number, max: number) => Math.min(Math.max(Math.floor(Number(v)) || dflt, min), max)
export const nowSec = () => Math.floor(Date.now() / 1000)

export class Bad extends Error {
  constructor(message: string, public field?: string, public status = 400, public extra: Record<string, unknown> = {}) { super(message) }
}

/** Cursor "<created_at>.<id>": the sort key of the last row of the previous page. Anything else is a 400. */
export function parseCursor(s: string | null): [number, number] | null | 'bad' {
  if (!s) return null
  const m = /^(\d{1,12})\.(\d{1,12})$/.exec(s)
  return m ? [Number(m[1]), Number(m[2])] : 'bad'
}

// ---- lead rows ---------------------------------------------------------------------------------------------

export const LEAD_COLS = `l.id, l.contact_id, l.source, l.status, l.message, l.created_at, l.updated_at, l.assigned_to,
  l.next_action_at, l.lost_reason, l.won_at, l.closed_at, l.first_response_at, l.last_activity_at, l.ctwa_clid, l.ad_source_id,
  l.page, l.utm_source, l.utm_medium, l.utm_campaign, l.gclid, l.external_id, l.attribution,
  c.name, c.phone, c.email, c.wa_id, c.opted_out_at, c.opt_out_source, o.name AS assigned_name, s.label AS stage_label, s.kind AS stage_kind`
export const LEAD_FROM = `leads l JOIN contacts c ON c.id = l.contact_id LEFT JOIN staff o ON o.id = l.assigned_to LEFT JOIN stages s ON s.key = l.status`

export interface TagRef { id: number; label: string; color: string }

export async function attachTags<T extends { id: number }>(env: Env, rows: T[]): Promise<(T & { tags: TagRef[] })[]> {
  if (!rows.length) return []
  const ids = rows.map((r) => r.id)
  const { results } = await env.DB.prepare(
    `SELECT lt.lead_id, t.id, t.label, t.color FROM lead_tags lt JOIN tags t ON t.id = lt.tag_id
      WHERE lt.lead_id IN (SELECT value FROM json_each(?)) ORDER BY t.label`, // one bound parameter: D1 caps a statement at 100
  ).bind(JSON.stringify(ids)).all<{ lead_id: number; id: number; label: string; color: string }>()
  const by = new Map<number, TagRef[]>()
  for (const r of results) (by.get(r.lead_id) ?? by.set(r.lead_id, []).get(r.lead_id)!).push({ id: r.id, label: r.label, color: r.color })
  return rows.map((r) => ({ ...r, tags: by.get(r.id) ?? [] }) as unknown as T & { tags: TagRef[] })
}

/** Parses the filter query params shared by the list and the board. Throws Bad on an unknown value. */
export async function leadFilters(env: Env, actor: Actor | null, url: URL, opts: { stage?: boolean } = { stage: true }): Promise<{ where: string[]; args: unknown[] }> {
  const where: string[] = []
  const args: unknown[] = []
  const p = url.searchParams
  const stage = p.get('stage')
  if (stage && opts.stage !== false) {
    if (!(await env.DB.prepare(`SELECT 1 x FROM stages WHERE key=?`).bind(stage).first())) throw new Bad('unknown stage', 'stage')
    where.push('l.status = ?'); args.push(stage)
  }
  const kind = p.get('kind')
  if (kind) {
    if (!['open', 'won', 'lost'].includes(kind)) throw new Bad('kind must be open, won or lost', 'kind')
    where.push('s.kind = ?'); args.push(kind)
  }
  const source = p.get('source')
  if (source) { where.push('l.source = ?'); args.push(source) }
  const campaign = p.get('campaign') // Click-to-WhatsApp ad source id
  if (campaign) { where.push('l.ad_source_id = ?'); args.push(campaign.slice(0, 200)) }
  const owner = p.get('owner')
  if (owner) {
    if (owner === 'none') where.push('l.assigned_to IS NULL')
    else {
      const id = owner === 'me' ? (actor?.kind === 'staff' ? actor.staff.id : -1) : Number(owner)
      if (!Number.isInteger(id)) throw new Bad('owner must be a staff id, me or none', 'owner')
      where.push('l.assigned_to = ?'); args.push(id)
    }
  }
  const tag = p.get('tag')
  if (tag) {
    const id = Number(tag)
    if (!Number.isInteger(id) || id < 1) throw new Bad('tag must be a tag id', 'tag')
    where.push('EXISTS (SELECT 1 FROM lead_tags lt WHERE lt.lead_id = l.id AND lt.tag_id = ?)'); args.push(id)
  }
  const q = (p.get('q') ?? '').trim().slice(0, 80)
  if (q) {
    const parts = [`c.name LIKE ? ESCAPE '\\'`, `c.email LIKE ? ESCAPE '\\'`]
    args.push('%' + escapeLike(q) + '%', '%' + escapeLike(q) + '%')
    const digits = q.replace(/\D/g, '')
    if (digits.length >= 3) { parts.push(`c.phone LIKE ? ESCAPE '\\'`); args.push('%' + digits + '%') }
    where.push(`(${parts.join(' OR ')})`)
  }
  return { where, args }
}

// ---- activity ----------------------------------------------------------------------------------------------

/** One activity row plus the lead's last_activity_at bump. Both statements go into the caller's batch. */
export function activityStmts(env: Env, leadId: number, contactId: number, actor: string, kind: string, data: unknown, at = nowSec()): D1PreparedStatement[] {
  return [
    env.DB.prepare(`INSERT INTO activity (lead_id,contact_id,actor,kind,data,created_at) VALUES (?,?,?,?,?,?)`)
      .bind(leadId, contactId, actor, kind, data === null || data === undefined ? null : JSON.stringify(data), at),
    env.DB.prepare(`UPDATE leads SET last_activity_at=?2 WHERE id=?1`).bind(leadId, at),
  ]
}

// ---- updates -----------------------------------------------------------------------------------------------

interface LeadRow { id: number; contact_id: number; status: string; assigned_to: number | null; next_action_at: number | null; won_at: number | null; closed_at: number | null; lost_reason: string | null }

export async function getLeadRow(env: Env, id: number): Promise<LeadRow | null> {
  return env.DB.prepare(`SELECT id,contact_id,status,assigned_to,next_action_at,won_at,closed_at,lost_reason FROM leads WHERE id=?`).bind(id).first<LeadRow>()
}

/**
 * Applies a PATCH body to a lead. Validates everything first (throws Bad), then writes the changes and one
 * activity row per changed field in one batch. Returns the list of activity kinds written (empty = no-op).
 */
export async function planLeadUpdate(env: Env, actor: Actor | string | null, lead: LeadRow, b: Record<string, unknown>, at = nowSec()): Promise<{ stmts: D1PreparedStatement[]; kinds: string[] }> {
  const sets: string[] = []
  const args: unknown[] = []
  const acts: [string, unknown][] = []
  const who = actorLabel(actor)

  if ('status' in b && b.status !== lead.status) {
    const key = typeof b.status === 'string' ? b.status : ''
    const to = key ? await env.DB.prepare(`SELECT key,kind,archived FROM stages WHERE key=?`).bind(key).first<{ key: string; kind: string; archived: number }>() : null
    if (!to || to.archived) throw new Bad('stage must be one of the active stages', 'status')
    const from = await env.DB.prepare(`SELECT kind FROM stages WHERE key=?`).bind(lead.status).first<{ kind: string }>()
    const fromKind = from?.kind ?? 'open'
    let reason: string | null = null
    if ('lost_reason' in b && b.lost_reason !== null && b.lost_reason !== undefined) {
      if (to.kind !== 'lost') throw new Bad('lost_reason only applies when moving to a lost stage', 'lost_reason')
      if (typeof b.lost_reason !== 'string' || b.lost_reason.trim().length > 200) throw new Bad('lost_reason must be text up to 200 characters', 'lost_reason')
      reason = b.lost_reason.trim() || null
    }
    sets.push('status=?'); args.push(to.key)
    if (to.kind !== fromKind) {
      // The kind changed, so the closing timestamps are rewritten from scratch.
      if (to.kind === 'open') sets.push('won_at=NULL', 'closed_at=NULL', 'lost_reason=NULL')
      else if (to.kind === 'won') { sets.push('won_at=?', 'closed_at=?', 'lost_reason=NULL'); args.push(at, at) }
      else { sets.push('won_at=NULL', 'closed_at=?', 'lost_reason=?'); args.push(at, reason) }
    } else if (to.kind === 'lost' && reason !== null) { sets.push('lost_reason=?'); args.push(reason) }
    acts.push(['stage_changed', { from: lead.status, to: to.key, kind: to.kind, ...(reason ? { lost_reason: reason } : {}), ...(fromKind !== 'open' && to.kind === 'open' ? { reopened: true } : {}) }])
  } else if ('lost_reason' in b && !('status' in b)) {
    throw new Bad('lost_reason is set together with a move to a lost stage', 'lost_reason')
  }

  if ('assigned_to' in b && b.assigned_to !== lead.assigned_to) {
    let to: number | null = null
    if (b.assigned_to !== null) {
      to = Number(b.assigned_to)
      const ok = Number.isInteger(to) && (await env.DB.prepare(`SELECT 1 x FROM staff WHERE id=? AND active=1`).bind(to).first())
      if (!ok) throw new Bad('owner must be an active staff member', 'assigned_to')
    }
    if (to !== lead.assigned_to) { sets.push('assigned_to=?'); args.push(to); acts.push(['assigned', { from: lead.assigned_to, to }]) }
  }

  if ('next_action_at' in b) {
    let to: number | null = null
    if (b.next_action_at !== null) {
      to = Number(b.next_action_at)
      if (!Number.isInteger(to) || to < 1 || to > 4102444800) throw new Bad('next_action_at must be unix seconds or null', 'next_action_at')
    }
    if (to !== lead.next_action_at) { sets.push('next_action_at=?'); args.push(to); acts.push(['next_action', { from: lead.next_action_at, to }]) }
  }

  if (!acts.length) return { stmts: [], kinds: [] }
  const stmts = [
    env.DB.prepare(`UPDATE leads SET ${sets.join(', ')}, updated_at=?, last_activity_at=? WHERE id=?`).bind(...args, at, at, lead.id),
    ...acts.map(([kind, data]) => env.DB.prepare(`INSERT INTO activity (lead_id,contact_id,actor,kind,data,created_at) VALUES (?,?,?,?,?,?)`).bind(lead.id, lead.contact_id, who, kind, JSON.stringify(data), at)),
  ]
  return { stmts, kinds: acts.map((a) => a[0]) }
}

export async function updateLead(env: Env, actor: Actor | string | null, lead: LeadRow, b: Record<string, unknown>, at = nowSec()): Promise<string[]> {
  const { stmts, kinds } = await planLeadUpdate(env, actor, lead, b, at)
  if (stmts.length) await env.DB.batch(stmts)
  return kinds
}

/** Replaces a lead's tag set. One activity row per tag added or removed. */
export async function planLeadTags(env: Env, actor: Actor | string | null, lead: { id: number; contact_id: number }, tagIds: unknown, at = nowSec()): Promise<{ stmts: D1PreparedStatement[]; kinds: string[] }> {
  if (!Array.isArray(tagIds) || tagIds.length > 50 || tagIds.some((x) => !Number.isInteger(x) || x < 1)) throw new Bad('tag_ids must be an array of tag ids', 'tag_ids')
  const want = [...new Set(tagIds as number[])]
  const { results: all } = await env.DB.prepare(`SELECT id,label FROM tags`).all<{ id: number; label: string }>()
  const known = new Map(all.map((t) => [t.id, t.label]))
  if (want.some((id) => !known.has(id))) throw new Bad('unknown tag', 'tag_ids')
  const { results: have } = await env.DB.prepare(`SELECT tag_id FROM lead_tags WHERE lead_id=?`).bind(lead.id).all<{ tag_id: number }>()
  return tagDeltaStmts(env, actor, lead, known, new Set(have.map((r) => r.tag_id)), want, at)
}

/** The writes that take a lead from `haveSet` to `want`, given already-loaded tag state (no reads). */
export function tagDeltaStmts(env: Env, actor: Actor | string | null, lead: { id: number; contact_id: number }, known: Map<number, string>, haveSet: Set<number>, want: number[], at: number): { stmts: D1PreparedStatement[]; kinds: string[] } {
  const add = want.filter((id) => !haveSet.has(id))
  const del = [...haveSet].filter((id) => !want.includes(id))
  if (!add.length && !del.length) return { stmts: [], kinds: [] }
  const who = actorLabel(actor)
  const stmts: D1PreparedStatement[] = []
  for (const id of add) {
    stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO lead_tags (lead_id,tag_id) VALUES (?,?)`).bind(lead.id, id))
    stmts.push(...activityStmts(env, lead.id, lead.contact_id, who, 'tag_added', { tag_id: id, label: known.get(id) }, at))
  }
  for (const id of del) {
    stmts.push(env.DB.prepare(`DELETE FROM lead_tags WHERE lead_id=? AND tag_id=?`).bind(lead.id, id))
    stmts.push(...activityStmts(env, lead.id, lead.contact_id, who, 'tag_removed', { tag_id: id, label: known.get(id) ?? null }, at))
  }
  stmts.push(env.DB.prepare(`UPDATE leads SET updated_at=? WHERE id=?`).bind(at, lead.id))
  return { stmts, kinds: [...add.map(() => 'tag_added'), ...del.map(() => 'tag_removed')] }
}

export async function setLeadTags(env: Env, actor: Actor | string | null, lead: { id: number; contact_id: number }, tagIds: unknown, at = nowSec()): Promise<string[]> {
  const { stmts, kinds } = await planLeadTags(env, actor, lead, tagIds, at)
  if (stmts.length) await env.DB.batch(stmts)
  return kinds
}

// ---- Today -------------------------------------------------------------------------------------------------

const TODAY_LIMIT = 50

export interface TodayResult {
  timezone: string; now: number; day_start: number; day_end: number
  overdue: unknown[]; due_today: unknown[]; new: unknown[]; unanswered: unknown[]
  counts: { overdue: number; due_today: number; new: number; unanswered: number }
}

/**
 * Buckets for the Today screen, with day boundaries from the instance `timezone` setting:
 *  - overdue: open leads whose next action is before today started
 *  - due_today: open leads whose next action falls inside today
 *  - new: open leads still in the entry stage 'new' (nobody has moved them yet), newest first
 *  - unanswered: open conversations whose last message is the customer's, longest-waiting first
 */
export async function todayBuckets(env: Env, now = nowSec()): Promise<TodayResult> {
  const cfg = await getSettings(env)
  const timezone = isTimezone(cfg.timezone) ? cfg.timezone : 'UTC'
  const dayStart = startOfDay(now, timezone)
  const dayEnd = startOfNextDay(now, timezone)
  const open = `s.kind = 'open'`
  const leadQuery = async (cond: string, args: unknown[], order: string) => {
    const [{ results }, count] = await Promise.all([
      env.DB.prepare(`SELECT ${LEAD_COLS} FROM ${LEAD_FROM} WHERE ${open} AND ${cond} ORDER BY ${order} LIMIT ${TODAY_LIMIT}`).bind(...args).all<{ id: number }>(),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM ${LEAD_FROM} WHERE ${open} AND ${cond}`).bind(...args).first<{ n: number }>(),
    ])
    return { rows: await attachTags(env, results), n: count?.n ?? 0 }
  }
  const overdue = await leadQuery('l.next_action_at < ?', [dayStart], 'l.next_action_at ASC, l.id ASC')
  const due = await leadQuery('l.next_action_at >= ? AND l.next_action_at < ?', [dayStart, dayEnd], 'l.next_action_at ASC, l.id ASC')
  const fresh = await leadQuery(`l.status = 'new'`, [], 'l.created_at DESC, l.id DESC')
  const unCond = `v.status = 'open' AND v.last_inbound_at IS NOT NULL AND v.last_inbound_at >= v.last_message_at`
  const [{ results: un }, unCount] = await Promise.all([
    env.DB.prepare(
      `SELECT v.contact_id, c.name, c.phone, c.wa_id, v.last_preview, v.last_inbound_at AS waiting_since, v.unread_count, v.assigned_to
         FROM conversations v JOIN contacts c ON c.id = v.contact_id WHERE ${unCond} ORDER BY v.last_inbound_at ASC, v.contact_id ASC LIMIT ${TODAY_LIMIT}`,
    ).all(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM conversations v WHERE ${unCond}`).first<{ n: number }>(),
  ])
  return {
    timezone, now, day_start: dayStart, day_end: dayEnd,
    overdue: overdue.rows, due_today: due.rows, new: fresh.rows, unanswered: un,
    counts: { overdue: overdue.n, due_today: due.n, new: fresh.n, unanswered: unCount?.n ?? 0 },
  }
}
