// /api/leads/*: list, board, detail, manual create, update, notes, calls, tags. Behind the auth gate in
// index.ts (staff session + CSRF on writes, or the ADMIN_KEY bearer). `POST /api/leads` stays the public intake.
import { onLeadCreated, onStageEdited } from '../flows/triggers'
import type { Actor } from '../auth'
import type { Env } from '../db'
import { json } from '../leads'
import { getSettings, phoneCountry } from '../settings'
import { phoneError, toWaDigits } from '../phone'
import { upsertWaContact } from '../inbound'
import { publishLead } from '../live' // D20
import { readJson } from './auth'
import { actorId } from './settings'
import {
  Bad, LEAD_COLS, LEAD_FROM, activityStmts, actorLabel, attachTags, clampInt, getLeadRow, leadFilters, nowSec, parseCursor, planLeadTags, planLeadUpdate, setLeadTags,
} from '../crm'

const fail = (e: unknown): Response => {
  if (e instanceof Bad) return json({ ok: false, error: e.message, ...(e.field ? { field: e.field } : {}), ...e.extra }, e.status)
  throw e
}

async function list(env: Env, actor: Actor | null, url: URL): Promise<Response> {
  const { where, args } = await leadFilters(env, actor, url)
  const limit = clampInt(url.searchParams.get('limit'), 50, 1, 200)
  const cur = parseCursor(url.searchParams.get('before'))
  if (cur === 'bad') return json({ ok: false, error: 'bad cursor', field: 'before' }, 400)
  if (cur) { where.push('(l.created_at < ? OR (l.created_at = ? AND l.id < ?))'); args.push(cur[0], cur[0], cur[1]) }
  const { results } = await env.DB.prepare(
    `SELECT ${LEAD_COLS} FROM ${LEAD_FROM} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY l.created_at DESC, l.id DESC LIMIT ?`,
  ).bind(...args, limit + 1).all<{ id: number; created_at: number }>()
  const more = results.length > limit
  const page = results.slice(0, limit)
  const last = page[page.length - 1]
  return json({ ok: true, leads: await attachTags(env, page), next_before: more && last ? `${last.created_at}.${last.id}` : null })
}

/** Columns for the board: every active stage with its total and its newest leads. Cursor paging per column uses the list endpoint. */
async function board(env: Env, actor: Actor | null, url: URL): Promise<Response> {
  const { where, args } = await leadFilters(env, actor, url, { stage: false })
  const per = clampInt(url.searchParams.get('per_stage'), 30, 1, 100)
  const w = where.length ? 'WHERE ' + where.join(' AND ') : ''
  const [{ results: stages }, { results: counts }, { results: rows }] = await Promise.all([
    env.DB.prepare(`SELECT key,label,kind,position FROM stages WHERE archived=0 ORDER BY position, key`).all<{ key: string; label: string; kind: string; position: number }>(),
    env.DB.prepare(`SELECT l.status AS key, COUNT(*) AS n FROM ${LEAD_FROM} ${w} GROUP BY l.status`).bind(...args).all<{ key: string; n: number }>(),
    env.DB.prepare(
      `SELECT * FROM (SELECT ${LEAD_COLS}, ROW_NUMBER() OVER (PARTITION BY l.status ORDER BY l.created_at DESC, l.id DESC) AS rn
         FROM ${LEAD_FROM} ${w}) WHERE rn <= ? ORDER BY status, created_at DESC, id DESC`,
    ).bind(...args, per).all<{ id: number; status: string }>(),
  ])
  const withTags = await attachTags(env, rows.map(({ rn: _rn, ...r }: any) => r) as { id: number; status: string; created_at: number }[])
  const n = new Map(counts.map((c) => [c.key, c.n]))
  const columns = stages.map((st) => {
    const leads = withTags.filter((r) => r.status === st.key)
    const total = n.get(st.key) ?? 0
    const last = leads[leads.length - 1]
    return { stage: st, count: total, leads, next_before: leads.length < total && last ? `${last.created_at}.${last.id}` : null }
  })
  return json({ ok: true, columns })
}

async function owners(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(`SELECT id,name,role FROM staff WHERE active=1 ORDER BY name COLLATE NOCASE`).all()
  return json({ ok: true, owners: results })
}

async function detail(env: Env, id: number, url: URL): Promise<Response> {
  const row = await env.DB.prepare(`SELECT ${LEAD_COLS}, l.attribution FROM ${LEAD_FROM} WHERE l.id=?`).bind(id).first<Record<string, any>>()
  if (!row) return json({ ok: false, error: 'not found' }, 404)
  const [lead] = await attachTags(env, [row as { id: number }])
  let attribution: unknown = null
  try { attribution = row.attribution ? JSON.parse(row.attribution) : null } catch { /* stored by this app, but never trust it */ }
  const limit = clampInt(url.searchParams.get('limit'), 100, 1, 200)
  const beforeRaw = url.searchParams.get('activity_before')
  const before = beforeRaw ? Number(beforeRaw) : null
  if (beforeRaw && !(Number.isInteger(before) && before! > 0)) return json({ ok: false, error: 'bad cursor', field: 'activity_before' }, 400)
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.kind, a.data, a.actor, a.created_at, s.name AS actor_name FROM activity a LEFT JOIN staff s ON a.actor = 'staff:' || s.id
      WHERE a.lead_id=?1 ${before ? 'AND a.id < ?3' : ''} ORDER BY a.id DESC LIMIT ?2`,
  ).bind(...(before ? [id, limit + 1, before] : [id, limit + 1])).all<Record<string, any>>()
  const more = results.length > limit
  const page = results.slice(0, limit)
  const activity = page.map((a) => { let data: unknown = null; try { data = a.data ? JSON.parse(a.data) : null } catch { /* leave null */ } return { ...a, data } })
  const conversation = await env.DB.prepare(
    `SELECT contact_id,last_message_at,last_inbound_at,last_preview,unread_count,status FROM conversations WHERE contact_id=?`,
  ).bind(row.contact_id).first()
  return json({
    ok: true, lead: { ...lead, attribution }, activity, activity_next_before: more && page.length ? page[page.length - 1].id : null,
    conversation, messages_url: `/api/contacts/${row.contact_id}/messages`,
  })
}

async function createManual(req: Request, env: Env, ctx: ExecutionContext, actor: Actor | null): Promise<Response> {
  const b = await readJson(req)
  if (!b) return json({ ok: false, error: 'invalid JSON' }, 400)
  try {
    const country = await phoneCountry(env)
    const digits = toWaDigits(b.phone, country)
    if (!digits) throw new Bad(phoneError(b.phone, country), 'phone')
    const name = typeof b.name === 'string' ? b.name.trim() : ''
    if (name.length > 120) throw new Bad('name is at most 120 characters', 'name')
    const email = typeof b.email === 'string' ? b.email.trim() : ''
    if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new Bad('email looks wrong', 'email')
    const message = typeof b.message === 'string' ? b.message.trim().slice(0, 2000) : ''
    const source = typeof b.source === 'string' && b.source ? b.source : 'manual'
    if (!(await env.DB.prepare(`SELECT 1 x FROM sources WHERE key=? AND archived=0`).bind(source).first())) throw new Bad('unknown source', 'source')
    let owner: number | null = null
    if (b.assigned_to !== undefined && b.assigned_to !== null) {
      owner = Number(b.assigned_to)
      if (!Number.isInteger(owner) || !(await env.DB.prepare(`SELECT 1 x FROM staff WHERE id=? AND active=1`).bind(owner).first())) throw new Bad('owner must be an active staff member', 'assigned_to')
    }
    let next: number | null = null
    if (b.next_action_at !== undefined && b.next_action_at !== null) {
      next = Number(b.next_action_at)
      if (!Number.isInteger(next) || next < 1 || next > 4102444800) throw new Bad('next_action_at must be unix seconds', 'next_action_at')
    }
    const tagIds: number[] = Array.isArray(b.tag_ids) ? [...new Set(b.tag_ids as number[])] : []
    if (b.tag_ids !== undefined && (!Array.isArray(b.tag_ids) || tagIds.length > 50 || tagIds.some((x) => !Number.isInteger(x) || x < 1))) throw new Bad('tag_ids must be an array of tag ids', 'tag_ids')
    const labels = new Map<number, string>()
    if (tagIds.length) {
      const { results } = await env.DB.prepare(`SELECT id,label FROM tags WHERE id IN (${tagIds.map(() => '?').join(',')})`).bind(...tagIds).all<{ id: number; label: string }>()
      results.forEach((t) => labels.set(t.id, t.label))
      if (labels.size !== tagIds.length) throw new Bad('unknown tag', 'tag_ids')
    }

    const contactId = await upsertWaContact(env.DB, digits, name || null)
    if (email) await env.DB.prepare(`UPDATE contacts SET email=COALESCE(email,?2) WHERE id=?1`).bind(contactId, email).run()
    const now = nowSec()
    const who = actorLabel(actor)
    // The open-lead check lives inside the INSERT, so two concurrent creates cannot both pass it. Every statement
    // after it is guarded by changes() > 0 (each inserts exactly one row when the lead was created), so a lost
    // race writes nothing and the newest lead of the contact is only ever the one inserted here.
    const newest = `(SELECT id FROM leads WHERE contact_id=?1 ORDER BY id DESC LIMIT 1)`
    const act = (kind: string, data: unknown) =>
      env.DB.prepare(`INSERT INTO activity (lead_id,contact_id,actor,kind,data,created_at) SELECT ${newest},?1,?2,?3,?4,?5 WHERE changes() > 0`).bind(contactId, who, kind, JSON.stringify(data), now)
    const out = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO leads (contact_id,source,message,status,assigned_to,next_action_at,created_at,updated_at,last_activity_at)
         SELECT ?1,?2,?3,'new',?4,?5,?6,?6,?6
          WHERE NOT EXISTS (SELECT 1 FROM leads l JOIN stages s ON s.key=l.status WHERE l.contact_id=?1 AND s.kind='open')`,
      ).bind(contactId, source, message || null, owner, next, now),
      act('lead_created', { source, by: actorId(actor) }),
      ...(owner !== null ? [act('assigned', { from: null, to: owner })] : []),
      ...(next !== null ? [act('next_action', { from: null, to: next })] : []),
      ...tagIds.flatMap((tid) => [
        env.DB.prepare(`INSERT INTO lead_tags (lead_id,tag_id) SELECT ${newest},?2 WHERE changes() > 0`).bind(contactId, tid),
        act('tag_added', { tag_id: tid, label: labels.get(tid) }),
      ]),
    ])
    if (!out[0].meta.changes) {
      const existing = await env.DB.prepare(
        `SELECT l.id FROM leads l JOIN stages s ON s.key=l.status WHERE l.contact_id=? AND s.kind='open' ORDER BY l.created_at DESC LIMIT 1`,
      ).bind(contactId).first<{ id: number }>()
      throw new Bad('this contact already has an open lead', undefined, 409, { error: 'open_lead_exists', lead_id: existing?.id ?? null })
    }
    const lead = await env.DB.prepare(`SELECT id FROM leads WHERE contact_id=? ORDER BY id DESC LIMIT 1`).bind(contactId).first<{ id: number }>()
    publishLead(env, ctx, lead!.id, 'new')
    onLeadCreated(env, ctx, lead!.id)
    return json({ ok: true, id: lead!.id, contact_id: contactId }, 201)
  } catch (e) { return fail(e) }
}

async function patch(req: Request, env: Env, ctx: ExecutionContext, actor: Actor | null, id: number): Promise<Response> {
  const b = await readJson(req)
  if (!b) return json({ ok: false, error: 'invalid JSON' }, 400)
  const lead = await getLeadRow(env, id)
  if (!lead) return json({ ok: false, error: 'not found' }, 404)
  try {
    // Plan both first (every validation throws before any write), then commit them as one batch.
    const u = await planLeadUpdate(env, actor, lead, b)
    const t = 'tag_ids' in b ? await planLeadTags(env, actor, lead, b.tag_ids) : { stmts: [], kinds: [] as string[] }
    const all = [...u.stmts, ...t.stmts]
    // newest activity id before the batch: the stage.changed hook keys on every stage row written after it
    const before = u.kinds.includes('stage_changed') ? ((await env.DB.prepare(`SELECT COALESCE(MAX(id),0) AS m FROM activity WHERE lead_id=?`).bind(id).first<{ m: number }>())?.m ?? 0) : undefined
    if (all.length) await env.DB.batch(all)
    const changed = u.kinds, tags = t.kinds
    if (!changed.length && !tags.length && !Object.keys(b).some((k) => ['status', 'assigned_to', 'next_action_at', 'tag_ids'].includes(k))) throw new Bad('nothing to change')
    if (changed.length) publishLead(env, ctx, id, 'update') // stage / owner / next action; tags alone do not move the board
    if (changed.includes('stage_changed')) onStageEdited(env, ctx, id, before)
    return json({ ok: true, changed: [...changed, ...tags] })
  } catch (e) { return fail(e) }
}

async function addNote(req: Request, env: Env, actor: Actor | null, id: number): Promise<Response> {
  const b = await readJson(req)
  const text = typeof b?.text === 'string' ? b.text.trim() : ''
  if (!text || text.length > 4000) return json({ ok: false, error: 'note must be 1-4000 characters', field: 'text' }, 400)
  const lead = await getLeadRow(env, id)
  if (!lead) return json({ ok: false, error: 'not found' }, 404)
  await env.DB.batch(activityStmts(env, id, lead.contact_id, actorLabel(actor), 'note', { text }))
  return json({ ok: true }, 201)
}

async function listNotes(env: Env, id: number): Promise<Response> {
  if (!(await getLeadRow(env, id))) return json({ ok: false, error: 'not found' }, 404)
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.data, a.actor, a.created_at, s.name AS actor_name FROM activity a LEFT JOIN staff s ON a.actor = 'staff:' || s.id
      WHERE a.lead_id=? AND a.kind='note' ORDER BY a.id DESC LIMIT 200`,
  ).bind(id).all<Record<string, any>>()
  return json({ ok: true, notes: results.map(({ data, ...n }) => { let text = ''; try { text = JSON.parse(data)?.text ?? '' } catch { /* empty */ } return { ...n, text } }) })
}

const OUTCOMES = ['answered', 'no_answer', 'busy', 'voicemail', 'wrong_number']
async function addCall(req: Request, env: Env, actor: Actor | null, id: number): Promise<Response> {
  const b = await readJson(req)
  if (!b) return json({ ok: false, error: 'invalid JSON' }, 400)
  const outcome = typeof b.outcome === 'string' ? b.outcome : 'answered'
  if (!OUTCOMES.includes(outcome)) return json({ ok: false, error: `outcome must be one of ${OUTCOMES.join(', ')}`, field: 'outcome' }, 400)
  const note = typeof b.note === 'string' ? b.note.trim().slice(0, 1000) : ''
  let duration: number | null = null
  if (b.duration_s !== undefined && b.duration_s !== null) {
    duration = Number(b.duration_s)
    if (!Number.isInteger(duration) || duration < 0 || duration > 86400) return json({ ok: false, error: 'duration_s must be whole seconds', field: 'duration_s' }, 400)
  }
  const lead = await getLeadRow(env, id)
  if (!lead) return json({ ok: false, error: 'not found' }, 404)
  await env.DB.batch(activityStmts(env, id, lead.contact_id, actorLabel(actor), 'call', { outcome, ...(note ? { note } : {}), ...(duration !== null ? { duration_s: duration } : {}) }))
  return json({ ok: true }, 201)
}

async function putTags(req: Request, env: Env, actor: Actor | null, id: number): Promise<Response> {
  const b = await readJson(req)
  if (!b) return json({ ok: false, error: 'invalid JSON' }, 400)
  const lead = await getLeadRow(env, id)
  if (!lead) return json({ ok: false, error: 'not found' }, 404)
  try {
    const changed = await setLeadTags(env, actor, lead, b.tag_ids)
    const [withTags] = await attachTags(env, [{ id }])
    return json({ ok: true, changed, tags: withTags.tags })
  } catch (e) { return fail(e) }
}

/** Returns null when the path is not a lead route. */
export async function handleLeads(req: Request, env: Env, ctx: ExecutionContext, path: string, actor: Actor | null, url: URL): Promise<Response | null> {
  try {
    if (path === '/api/leads' && req.method === 'GET') return await list(env, actor, url)
    if (path === '/api/leads/board' && req.method === 'GET') return await board(env, actor, url)
    if (path === '/api/leads/owners' && req.method === 'GET') return await owners(env)
    if (path === '/api/leads/manual' && req.method === 'POST') return await createManual(req, env, ctx, actor)
    const m = path.match(/^\/api\/leads\/(\d+)(?:\/(notes|calls|tags))?$/)
    if (!m) return null
    const id = Number(m[1])
    if (!m[2]) {
      if (req.method === 'GET') return await detail(env, id, url)
      if (req.method === 'PATCH') return await patch(req, env, ctx, actor, id)
    } else if (m[2] === 'notes') {
      if (req.method === 'GET') return await listNotes(env, id)
      if (req.method === 'POST') return await addNote(req, env, actor, id)
    } else if (m[2] === 'calls' && req.method === 'POST') return await addCall(req, env, actor, id)
    else if (m[2] === 'tags' && req.method === 'PUT') return await putTags(req, env, actor, id)
    return null
  } catch (e) { return fail(e) }
}
