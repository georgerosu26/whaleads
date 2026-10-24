// Stages, sources and tags: ordered lists that live in D1. Reads need any staff session, writes need admin.
// Stage keys never change once created (leads.status stores the key), so editing is rename-in-place.
import type { Actor } from '../auth'
import { require } from '../auth'
import type { Env } from '../db'
import { logEvent } from '../db'
import { json } from '../leads'
import { readJson } from './auth'
import { actorId } from './settings'

export const TAG_COLORS = ['neutral', 'coral', 'amber', 'green', 'teal', 'blue', 'violet', 'pink'] as const
const KINDS = ['open', 'won', 'lost']
/** leads.status defaults to 'new' and intake inserts it, so this stage can be renamed but never removed or retyped. */
const PROTECTED_STAGE = 'new'

const label = (v: unknown) => (typeof v === 'string' && v.trim() && v.trim().length <= 60 ? v.trim() : null)
const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'item'
const bad = (error: string, field?: string, status = 400) => json({ ok: false, error, ...(field ? { field } : {}) }, status)

async function uniqueKey(env: Env, table: 'stages' | 'sources', base: string): Promise<string> {
  for (let i = 1; i < 100; i++) {
    const k = i === 1 ? base : `${base}_${i}`
    if (!(await env.DB.prepare(`SELECT 1 x FROM ${table} WHERE key=?`).bind(k).first())) return k
  }
  return `${base}_${crypto.randomUUID().slice(0, 6)}`
}

// ---- stages
const stageList = async (env: Env, all: boolean) =>
  (await env.DB.prepare(
    `SELECT s.key,s.label,s.position,s.kind,s.archived,(SELECT COUNT(*) FROM leads l WHERE l.status=s.key) AS lead_count
       FROM stages s ${all ? '' : 'WHERE s.archived=0'} ORDER BY s.position, s.key`,
  ).all()).results

/** At least one active stage of each kind must remain (won_at / closed_at are set from the kind). */
async function keepsEveryKind(env: Env, key: string, newKind: string, newArchived: number): Promise<boolean> {
  const { results } = await env.DB.prepare(`SELECT key,kind,archived FROM stages`).all<{ key: string; kind: string; archived: number }>()
  const left = new Set(results.map((r) => (r.key === key ? { kind: newKind, archived: newArchived } : r)).filter((r) => !r.archived).map((r) => r.kind))
  return KINDS.every((k) => left.has(k))
}

async function moveLeads(env: Env, from: string, moveTo: unknown): Promise<Response | { moved: number }> {
  const n = (await env.DB.prepare(`SELECT COUNT(*) n FROM leads WHERE status=?`).bind(from).first<{ n: number }>())?.n ?? 0
  if (!n) return { moved: 0 }
  if (moveTo === undefined || moveTo === null || moveTo === '') return json({ ok: false, error: 'stage_has_leads', lead_count: n }, 409)
  const dest = typeof moveTo === 'string' ? await env.DB.prepare(`SELECT key FROM stages WHERE key=? AND archived=0`).bind(moveTo).first() : null
  if (!dest || moveTo === from) return bad('move_to must be a different, active stage', 'move_to')
  await env.DB.prepare(`UPDATE leads SET status=?, updated_at=unixepoch() WHERE status=?`).bind(moveTo, from).run()
  return { moved: n }
}

async function stages(req: Request, env: Env, actor: Actor | null, url: URL, parts: string[]): Promise<Response | null> {
  if (parts.length === 0 && req.method === 'GET') return json({ ok: true, stages: await stageList(env, url.searchParams.get('all') === '1') })
  const denied = require(actor, 'admin'); if (denied) return denied
  const by = actorId(actor) ?? 'api'

  if (parts.length === 0 && req.method === 'POST') {
    const b = await readJson(req); const l = label(b?.label); const kind = b?.kind ?? 'open'
    if (!l) return bad('label required (max 60 characters)', 'label')
    if (!KINDS.includes(kind as string)) return bad('kind must be open, won or lost', 'kind')
    const key = await uniqueKey(env, 'stages', slug(l))
    await env.DB.prepare(`INSERT INTO stages (key,label,position,kind) VALUES (?,?,(SELECT COALESCE(MAX(position),-1)+1 FROM stages),?)`).bind(key, l, kind).run()
    await logEvent(env.DB, 'stage_added', { key, by })
    return json({ ok: true, key, stages: await stageList(env, true) }, 201)
  }
  if (parts[0] === 'reorder' && req.method === 'POST') {
    const b = await readJson(req)
    const keys = b?.keys
    const existing = (await env.DB.prepare(`SELECT key FROM stages`).all<{ key: string }>()).results.map((r) => r.key)
    if (!Array.isArray(keys) || keys.length !== existing.length || new Set(keys).size !== keys.length || !keys.every((k) => existing.includes(k as string))) return bad('keys must list every stage exactly once', 'keys')
    await env.DB.batch((keys as string[]).map((k, i) => env.DB.prepare(`UPDATE stages SET position=? WHERE key=?`).bind(i, k)))
    return json({ ok: true, stages: await stageList(env, true) })
  }
  const key = parts[0]
  const cur = key ? await env.DB.prepare(`SELECT key,kind,archived FROM stages WHERE key=?`).bind(key).first<{ key: string; kind: string; archived: number }>() : null
  if (!key || parts.length !== 1) return null
  if (!cur) return bad('not found', undefined, 404)

  if (req.method === 'PATCH') {
    const b = await readJson(req)
    if (!b) return bad('invalid JSON')
    const l = 'label' in b ? label(b.label) : undefined
    if (l === null) return bad('label required (max 60 characters)', 'label')
    const kind = 'kind' in b ? b.kind : cur.kind
    if (typeof kind !== 'string' || !KINDS.includes(kind)) return bad('kind must be open, won or lost', 'kind')
    const archived = 'archived' in b ? (typeof b.archived === 'boolean' ? (b.archived ? 1 : 0) : null) : cur.archived
    if (archived === null) return bad('archived must be true or false', 'archived')
    if (key === PROTECTED_STAGE && (archived || kind !== 'open')) return bad('protected_stage', undefined, 409)
    if ((archived !== cur.archived || kind !== cur.kind) && !(await keepsEveryKind(env, key, kind, archived))) return bad('last_of_kind', undefined, 409)
    if (archived && !cur.archived) {
      const moved = await moveLeads(env, key, b.move_to)
      if (moved instanceof Response) return moved
    }
    await env.DB.prepare(`UPDATE stages SET label=COALESCE(?1,label), kind=?2, archived=?3 WHERE key=?4`).bind(l ?? null, kind, archived, key).run()
    await logEvent(env.DB, 'stage_changed', { key, by })
    return json({ ok: true, stages: await stageList(env, true) })
  }
  if (req.method === 'DELETE') {
    if (key === PROTECTED_STAGE) return bad('protected_stage', undefined, 409)
    if (!(await keepsEveryKind(env, key, cur.kind, 1))) return bad('last_of_kind', undefined, 409)
    const moved = await moveLeads(env, key, url.searchParams.get('move_to') ?? undefined)
    if (moved instanceof Response) return moved
    await env.DB.prepare(`DELETE FROM stages WHERE key=?`).bind(key).run()
    await logEvent(env.DB, 'stage_deleted', { key, moved: moved.moved, by })
    return json({ ok: true, moved: moved.moved, stages: await stageList(env, true) })
  }
  return null
}

// ---- sources
const sourceList = async (env: Env, all: boolean) =>
  (await env.DB.prepare(`SELECT key,label,system,archived FROM sources ${all ? '' : 'WHERE archived=0'} ORDER BY system DESC, label COLLATE NOCASE`).all()).results

async function sources(req: Request, env: Env, actor: Actor | null, url: URL, parts: string[]): Promise<Response | null> {
  if (parts.length === 0 && req.method === 'GET') return json({ ok: true, sources: await sourceList(env, url.searchParams.get('all') === '1') })
  const denied = require(actor, 'admin'); if (denied) return denied
  if (parts.length === 0 && req.method === 'POST') {
    const b = await readJson(req); const l = label(b?.label)
    if (!l) return bad('label required (max 60 characters)', 'label')
    const key = await uniqueKey(env, 'sources', slug(l))
    await env.DB.prepare(`INSERT INTO sources (key,label,system) VALUES (?,?,0)`).bind(key, l).run()
    await logEvent(env.DB, 'source_added', { key, by: actorId(actor) ?? 'api' })
    return json({ ok: true, key, sources: await sourceList(env, true) }, 201)
  }
  if (parts.length === 1 && req.method === 'PATCH') {
    const cur = await env.DB.prepare(`SELECT system FROM sources WHERE key=?`).bind(parts[0]).first<{ system: number }>()
    if (!cur) return bad('not found', undefined, 404)
    if (cur.system) return bad('system_locked', undefined, 409)
    const b = await readJson(req)
    if (!b) return bad('invalid JSON')
    const l = 'label' in b ? label(b.label) : undefined
    if (l === null) return bad('label required (max 60 characters)', 'label')
    if ('archived' in b && typeof b.archived !== 'boolean') return bad('archived must be true or false', 'archived')
    await env.DB.prepare(`UPDATE sources SET label=COALESCE(?1,label), archived=COALESCE(?2,archived) WHERE key=?3`).bind(l ?? null, 'archived' in b ? (b.archived ? 1 : 0) : null, parts[0]).run()
    return json({ ok: true, sources: await sourceList(env, true) })
  }
  return null
}

// ---- tags
const tagList = async (env: Env) => (await env.DB.prepare(`SELECT id,label,color FROM tags ORDER BY label COLLATE NOCASE`).all()).results
const color = (v: unknown) => (typeof v === 'string' && (TAG_COLORS as readonly string[]).includes(v) ? v : null)

async function tags(req: Request, env: Env, actor: Actor | null, parts: string[]): Promise<Response | null> {
  if (parts.length === 0 && req.method === 'GET') return json({ ok: true, tags: await tagList(env), colors: TAG_COLORS })
  const denied = require(actor, 'admin'); if (denied) return denied
  const taken = (e: unknown) => /UNIQUE/i.test(String(e)) ? bad('label_taken', 'label', 409) : Promise.reject(e)
  if (parts.length === 0 && req.method === 'POST') {
    const b = await readJson(req); const l = label(b?.label); const c = b?.color === undefined ? 'neutral' : color(b.color)
    if (!l) return bad('label required (max 60 characters)', 'label')
    if (!c) return bad('unknown colour', 'color')
    try { await env.DB.prepare(`INSERT INTO tags (label,color) VALUES (?,?)`).bind(l, c).run() } catch (e) { return taken(e) }
    return json({ ok: true, tags: await tagList(env) }, 201)
  }
  const id = /^\d+$/.test(parts[0] ?? '') ? Number(parts[0]) : null
  if (id === null || parts.length !== 1) return null
  if (!(await env.DB.prepare(`SELECT 1 x FROM tags WHERE id=?`).bind(id).first())) return bad('not found', undefined, 404)
  if (req.method === 'PATCH') {
    const b = await readJson(req)
    if (!b) return bad('invalid JSON')
    const l = 'label' in b ? label(b.label) : undefined
    const c = 'color' in b ? color(b.color) : undefined
    if (l === null) return bad('label required (max 60 characters)', 'label')
    if (c === null) return bad('unknown colour', 'color')
    try { await env.DB.prepare(`UPDATE tags SET label=COALESCE(?1,label), color=COALESCE(?2,color) WHERE id=?3`).bind(l ?? null, c ?? null, id).run() } catch (e) { return taken(e) }
    return json({ ok: true, tags: await tagList(env) })
  }
  if (req.method === 'DELETE') {
    await env.DB.prepare(`DELETE FROM tags WHERE id=?`).bind(id).run()
    return json({ ok: true, tags: await tagList(env) })
  }
  return null
}

export async function handlePipeline(req: Request, env: Env, path: string, actor: Actor | null, url: URL): Promise<Response | null> {
  const m = path.match(/^\/api\/(stages|sources|tags)(?:\/([^/]+))?(?:\/([^/]+))?$/)
  if (!m) return null
  const parts = [m[2], m[3]].filter((x): x is string => !!x).map(decodeURIComponent)
  if (m[1] === 'stages') return stages(req, env, actor, url, parts)
  if (m[1] === 'sources') return sources(req, env, actor, url, parts)
  return tags(req, env, actor, parts)
}
