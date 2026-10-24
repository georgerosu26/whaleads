// Broadcast CRUD and lifecycle (plan D1 store.ts, D2). Every transition is a compare-and-set on `status`, so two admins
// (or an admin and the cron step) cannot both win. Errors are `Bad` (status + field) for the route to translate.
import { resolveActive } from '../adaptors'
import { Bad, actorLabel, nowSec } from '../crm'
import type { Actor } from '../auth'
import type { Env } from '../db'
import { logEvent } from '../db'
import { loadSendableTemplate, sampleHeaderMedia } from '../send'
import { rowJson, type TemplateRow } from '../templates'
import { MAX_AUDIENCE, chunkBounds, insertRecipients, parseFilter, resolveAudience, sendableIds, type Filter } from './audience'
import { checkParams, type ParamsSpec } from './params'

export const STATUSES = ['draft', 'queued', 'running', 'paused', 'cancelled', 'finished', 'failed'] as const
export type BroadcastStatus = (typeof STATUSES)[number]
/** Statuses a broadcast can be deleted from. */
const DELETABLE = ['draft', 'cancelled', 'finished', 'failed']
/** Meta takes a header media id for 30 days; re-upload before that. */
export const MEDIA_REFRESH_S = 25 * 86400
const MEDIA_FORMATS = new Set(['IMAGE', 'VIDEO', 'DOCUMENT'])
const INSERT_CHUNKS_PER_CALL = 10

export interface BroadcastRow {
  id: string; name: string; template_id: string; template_name: string; language: string; category: string
  params: string; filter: string; status: BroadcastStatus; pause_reason: string | null
  total: number; excluded: number; sent: number; delivered: number; read: number; failed: number
  /** recipients whose outcome is unknown, counted live (they are inside `failed`); absent on rows read without the subquery */
  unknown?: number
  header_media_id: string | null; header_media_at: number | null; scheduled_at: number | null
  created_by: string | null; created_at: number; started_at: number | null; finished_at: number | null; updated_at: number
}

const parse = (s: string, dflt: unknown) => { try { return JSON.parse(s) } catch { return dflt } }

/** The API shape: JSON columns parsed, the excluded breakdown pulled out of the filter. */
export function view(b: BroadcastRow) {
  const filter = parse(b.filter, {}) as Record<string, unknown>
  const { excluded_detail, ...f } = filter
  return {
    id: b.id, name: b.name, template_id: b.template_id, template_name: b.template_name, language: b.language, category: b.category,
    params: parse(b.params, {}), filter: f, status: b.status, pause_reason: b.pause_reason,
    total: b.total, excluded: b.excluded, excluded_detail: excluded_detail ?? null,
    sent: b.sent, delivered: b.delivered, read: b.read, failed: b.failed, unknown: b.unknown ?? 0,
    created_by: b.created_by, created_at: b.created_at, started_at: b.started_at, finished_at: b.finished_at, updated_at: b.updated_at,
  }
}

const newId = () => 'bc_' + [...crypto.getRandomValues(new Uint8Array(8))].map((x) => x.toString(16).padStart(2, '0')).join('')

export const getBroadcast = (db: D1Database, id: string) => db.prepare(`SELECT b.*, (SELECT COUNT(*) FROM broadcast_recipients r WHERE r.broadcast_id=b.id AND r.status='unknown') AS unknown FROM broadcasts b WHERE b.id=?`).bind(id).first<BroadcastRow>()

export async function listBroadcasts(db: D1Database, cursor: string | null) {
  const m = cursor ? /^(\d{1,12})\.(bc_[0-9a-f]+)$/.exec(cursor) : null
  if (cursor && !m) throw new Bad('invalid cursor', 'cursor')
  const { results } = await db.prepare(
    `SELECT b.*, (SELECT COUNT(*) FROM broadcast_recipients r WHERE r.broadcast_id=b.id AND r.status='unknown') AS unknown FROM broadcasts b ${m ? `WHERE (b.created_at < ?1 OR (b.created_at = ?1 AND b.id < ?2))` : ''} ORDER BY b.created_at DESC, b.id DESC LIMIT 51`,
  ).bind(...(m ? [Number(m[1]), m[2]] : [])).all<BroadcastRow>()
  const rows = results.slice(0, 50)
  const last = rows[rows.length - 1]
  return { rows: rows.map(view), next: results.length > 50 && last ? `${last.created_at}.${last.id}` : null }
}

export async function recipientsPage(db: D1Database, id: string, status: string | null, cursor: string | null) {
  if (status && !['queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'skipped', 'unknown'].includes(status)) throw new Bad('invalid status', 'status')
  if (cursor && !/^\d{1,12}$/.test(cursor)) throw new Bad('invalid cursor', 'cursor')
  const { results } = await db.prepare(
    `SELECT r.contact_id, r.lead_id, r.status, r.wamid, r.error_code, r.error_message, r.attempts, r.sent_at, r.updated_at,
            c.name, COALESCE(NULLIF(c.wa_id, ''), c.phone) AS phone
       FROM broadcast_recipients r LEFT JOIN contacts c ON c.id = CAST(r.contact_id AS INTEGER)
      WHERE r.broadcast_id = ?1 AND (?2 IS NULL OR r.status = ?2) AND (?3 IS NULL OR CAST(r.contact_id AS INTEGER) > ?3)
      ORDER BY CAST(r.contact_id AS INTEGER) LIMIT 101`,
  ).bind(id, status, cursor ? Number(cursor) : null).all<Record<string, any>>()
  const rows = results.slice(0, 100)
  return { rows, next: results.length > 100 ? String(rows[rows.length - 1]!.contact_id) : null }
}

export interface Input { name?: unknown; template_id?: unknown; params?: unknown; filter?: unknown }
export interface Checked { name: string; template: TemplateRow; spec: ParamsSpec; filter: Filter }

/** Validates a draft's content. The template must be approved and sendable, MARKETING or UTILITY (never AUTHENTICATION). */
export async function check(env: Env, i: { name: unknown; template_id: unknown; params: unknown; filter: unknown }): Promise<Checked> {
  const name = typeof i.name === 'string' ? i.name.trim() : ''
  if (!name || name.length > 120) throw new Bad('A name of 1 to 120 characters is required.', 'name')
  const tid = typeof i.template_id === 'string' ? i.template_id : ''
  if (!tid) throw new Bad('Pick a template.', 'template_id')
  const t = await loadSendableTemplate(env, { id: tid })
  if (!t.ok) throw new Bad(t.message, 'template_id', t.code === 'template_not_found' ? 404 : 422, { error: t.code })
  if (!['MARKETING', 'UTILITY'].includes(t.template.category)) throw new Bad('Only marketing and utility templates can be broadcast.', 'template_id', 422)
  const filter = await checkFilter(env, i.filter)
  const p = checkParams(i.params, t.template.body_params_count, t.template.header_params_count)
  if (!p.ok) throw new Bad(p.error, p.field)
  return { name, template: t.template, spec: p.spec, filter }
}

/** The audience filter alone: shape, then the stage key against `stages`. */
async function checkFilter(env: Env, raw: unknown): Promise<Filter> {
  const f = parseFilter(raw)
  if (!f.ok) throw new Bad(f.error, f.field)
  if (f.filter.stage) {
    const s = await env.DB.prepare(`SELECT 1 AS ok FROM stages WHERE key=?`).bind(f.filter.stage).first()
    if (!s) throw new Bad('Unknown stage.', 'filter')
  }
  return f.filter
}

export async function createDraft(env: Env, i: Input, actor: Actor | null) {
  const c = await check(env, { name: i.name, template_id: i.template_id, params: i.params ?? {}, filter: i.filter })
  const id = newId(), now = nowSec()
  await env.DB.prepare(
    `INSERT INTO broadcasts (id,name,template_id,template_name,language,category,params,filter,status,created_by,created_at,updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'draft',?9,?10,?10)`,
  ).bind(id, c.name, c.template.id, c.template.name, c.template.language, c.template.category, JSON.stringify(c.spec), JSON.stringify(c.filter), actorLabel(actor), now).run()
  return view((await getBroadcast(env.DB, id))!)
}

/** Draft only. Any field not sent keeps its stored value. */
export async function patchDraft(env: Env, id: string, i: Input) {
  const b = await getBroadcast(env.DB, id)
  if (!b) throw new Bad('broadcast not found', undefined, 404)
  if (b.status !== 'draft') throw new Bad('Only a draft can be edited.', undefined, 409, { error: 'not_draft' })
  const c = await check(env, {
    name: i.name ?? b.name, template_id: i.template_id ?? b.template_id,
    params: i.params ?? (i.template_id !== undefined && i.template_id !== b.template_id ? {} : parse(b.params, {})),
    filter: i.filter ?? parse(b.filter, {}),
  })
  const r = await env.DB.prepare(
    `UPDATE broadcasts SET name=?2, template_id=?3, template_name=?4, language=?5, category=?6, params=?7, filter=?8, updated_at=?9 WHERE id=?1 AND status='draft'`,
  ).bind(id, c.name, c.template.id, c.template.name, c.template.language, c.template.category, JSON.stringify(c.spec), JSON.stringify(c.filter), nowSec()).run()
  if (!r.meta.changes) throw new Bad('Only a draft can be edited.', undefined, 409, { error: 'not_draft' })
  return view((await getBroadcast(env.DB, id))!)
}

/** Counts, five sample renders and the template, for the wizard. Writes nothing. */
export async function preview(env: Env, i: Input) {
  // no template_id: counts only, for the wizard's audience step before a template is picked (no samples, no template)
  if (i.template_id === undefined || i.template_id === null || i.template_id === '') {
    const filter = await checkFilter(env, i.filter)
    const aud = await resolveAudience(env.DB, filter, null, 0)
    return { ...aud, template: null, filter }
  }
  const c = await check(env, { name: 'preview', template_id: i.template_id, params: i.params ?? {}, filter: i.filter })
  const aud = await resolveAudience(env.DB, c.filter, c.spec)
  const t = rowJson(c.template)
  return { ...aud, template: { id: t.id, name: t.name, category: t.category, header_format: t.header_format }, filter: c.filter }
}

async function uploadHeader(env: Env, t: TemplateRow): Promise<{ id: string; at: number }> {
  const active = await resolveActive(env)
  if (!active) throw new Bad('No WhatsApp adaptor configured.', undefined, 503, { error: 'no_adaptor' })
  const m = await sampleHeaderMedia(env, t)
  if (!m.ok) throw new Bad(m.message, 'template_id', 422, { error: m.code })
  let last = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const up = await active.adaptor.uploadMedia(m.media.bytes, m.media.mime)
    if (up.ok && up.data?.id) return { id: up.data.id, at: nowSec() }
    last = up.error?.message ?? 'upload failed'
  }
  throw new Bad(last, 'header_media', 502, { error: 'upload_failed' })
}

/**
 * draft -> queued: re-validates, uploads the header once, resolves the audience, writes the recipients in chunks and
 * flips the status. `echoTotal` is the total the admin saw in the preview; a different count now is a 409.
 */
export async function start(env: Env, id: string, echoTotal: unknown) {
  const b = await getBroadcast(env.DB, id)
  if (!b) throw new Bad('broadcast not found', undefined, 404)
  if (b.status !== 'draft') throw new Bad('Only a draft can be started.', undefined, 409, { error: 'not_draft' })
  if (typeof echoTotal !== 'number' || !Number.isInteger(echoTotal)) throw new Bad('Send the total from the preview as "total".', 'total')
  const c = await check(env, { name: b.name, template_id: b.template_id, params: parse(b.params, {}), filter: parse(b.filter, {}) })
  const aud = await resolveAudience(env.DB, c.filter, null, 0)
  if (aud.total !== echoTotal) throw new Bad('The audience changed since the preview.', 'total', 409, { error: 'audience_changed', total: aud.total, excluded: aud.excluded })
  if (aud.total === 0) throw new Bad('Nobody to send to: every match is opted out, has no phone number or is a duplicate.', 'filter', 422, { error: 'empty_audience' })
  if (aud.total > MAX_AUDIENCE) throw new Bad(`At most ${MAX_AUDIENCE.toLocaleString('en')} recipients per broadcast.`, 'filter', 422, { error: 'audience_too_large', total: aud.total })

  let media: { id: string; at: number } | null = null
  if (MEDIA_FORMATS.has(c.template.header_format)) {
    try { media = await uploadHeader(env, c.template) } catch (e) {
      if (e instanceof Bad && e.extra.error === 'upload_failed') {
        await env.DB.prepare(`UPDATE broadcasts SET status='failed', pause_reason=?2, finished_at=?3, updated_at=?3 WHERE id=?1 AND status='draft'`).bind(id, `header upload failed twice: ${e.message}`.slice(0, 400), nowSec()).run()
      }
      throw e
    }
  }

  const now = nowSec()
  const ids = await sendableIds(env.DB, c.filter)
  const inserts = chunkBounds(ids).map(([lo, hi]) => insertRecipients(env.DB, id, c.filter, c.spec, now, lo, hi))
  const detail = { ...c.filter, excluded_detail: aud.excluded }
  const cas = env.DB.prepare(
    `UPDATE broadcasts SET status='queued', total=(SELECT COUNT(*) FROM broadcast_recipients WHERE broadcast_id=?1), excluded=?2, filter=?3,
       header_media_id=?4, header_media_at=?5, updated_at=?6 WHERE id=?1 AND status='draft'`,
  ).bind(id, aud.excluded_total, JSON.stringify(detail), media?.id ?? null, media?.at ?? null, now)
  const first = [env.DB.prepare(`DELETE FROM broadcast_recipients WHERE broadcast_id=?`).bind(id)]
  const groups: D1PreparedStatement[][] = []
  for (let i = 0; i < inserts.length; i += INSERT_CHUNKS_PER_CALL) groups.push(inserts.slice(i, i + INSERT_CHUNKS_PER_CALL))
  if (!groups.length) groups.push([])
  groups[0] = [...first, ...groups[0]!]
  groups[groups.length - 1]!.push(cas)
  let flipped = 0
  for (const g of groups) {
    const res = await env.DB.batch(g)
    if (g[g.length - 1] === cas) flipped = res[res.length - 1]!.meta.changes
  }
  if (!flipped) {
    await env.DB.prepare(`DELETE FROM broadcast_recipients WHERE broadcast_id=?1 AND NOT EXISTS (SELECT 1 FROM broadcasts WHERE id=?1 AND status IN ('queued','running'))`).bind(id).run()
    throw new Bad('The broadcast changed while it was starting.', undefined, 409, { error: 'conflict' })
  }
  await logEvent(env.DB, 'broadcast_start', { id, total: aud.total })
  return view((await getBroadcast(env.DB, id))!)
}

async function cas(env: Env, id: string, from: BroadcastStatus[], set: string, binds: unknown[] = []): Promise<void> {
  const q = from.map(() => '?').join(',')
  const r = await env.DB.prepare(`UPDATE broadcasts SET ${set}, updated_at=? WHERE id=? AND status IN (${q})`).bind(...binds, nowSec(), id, ...from).run()
  if (r.meta.changes) return
  const b = await getBroadcast(env.DB, id)
  if (!b) throw new Bad('broadcast not found', undefined, 404)
  throw new Bad(`This broadcast is ${b.status}.`, undefined, 409, { error: 'bad_state', status: b.status })
}

export async function pause(env: Env, id: string) {
  await cas(env, id, ['queued', 'running'], `status='paused', pause_reason=NULL`)
  return view((await getBroadcast(env.DB, id))!)
}

/** paused -> queued: the step picks it up again (one at a time, oldest first). */
export async function resume(env: Env, id: string) {
  await cas(env, id, ['paused'], `status='queued', pause_reason=NULL`)
  return view((await getBroadcast(env.DB, id))!)
}

/** Any non-terminal state. Recipients still waiting are skipped; a send already in flight finishes (and is recorded). */
export async function cancel(env: Env, id: string) {
  const now = nowSec()
  const [flip] = await env.DB.batch([
    env.DB.prepare(`UPDATE broadcasts SET status='cancelled', finished_at=?2, updated_at=?2 WHERE id=?1 AND status IN ('draft','queued','running','paused')`).bind(id, now),
    env.DB.prepare(`UPDATE broadcast_recipients SET status='skipped', error_message='cancelled', updated_at=?2 WHERE broadcast_id=?1 AND status='queued' AND changes() > 0`).bind(id, now),
  ])
  if (!flip!.meta.changes) {
    const b = await getBroadcast(env.DB, id)
    if (!b) throw new Bad('broadcast not found', undefined, 404)
    throw new Bad(`This broadcast is ${b.status}.`, undefined, 409, { error: 'bad_state', status: b.status })
  }
  await logEvent(env.DB, 'broadcast_cancel', { id })
  return view((await getBroadcast(env.DB, id))!)
}

/** Explicit re-send to recipients whose outcome is unknown (a timeout may have delivered). The admin owns that risk. */
export async function requeueUnknown(env: Env, id: string) {
  const now = nowSec()
  const [moved] = await env.DB.batch([
    env.DB.prepare(`UPDATE broadcast_recipients SET status='queued', attempts=0, next_attempt_at=0, error_code=NULL, error_message=NULL, updated_at=?2
                      WHERE broadcast_id=?1 AND status='unknown' AND EXISTS (SELECT 1 FROM broadcasts WHERE id=?1 AND status IN ('queued','running','paused','finished'))`).bind(id, now),
    env.DB.prepare(`UPDATE broadcasts SET failed = MAX(0, failed - changes()), status = CASE status WHEN 'finished' THEN 'queued' ELSE status END,
                      finished_at = CASE status WHEN 'finished' THEN NULL ELSE finished_at END, updated_at=?2
                      WHERE id=?1 AND changes() > 0 AND status IN ('queued','running','paused','finished')`).bind(id, now),
  ])
  const n = moved!.meta.changes ?? 0
  if (!n) {
    const b = await getBroadcast(env.DB, id)
    if (!b) throw new Bad('broadcast not found', undefined, 404)
    if (!['queued', 'running', 'paused', 'finished'].includes(b.status)) throw new Bad(`This broadcast is ${b.status}.`, undefined, 409, { error: 'bad_state', status: b.status })
  }
  return { requeued: n, broadcast: view((await getBroadcast(env.DB, id))!) }
}

export async function remove(env: Env, id: string): Promise<void> {
  const q = DELETABLE.map((s) => `'${s}'`).join(',')
  const [, gone] = await env.DB.batch([
    env.DB.prepare(`DELETE FROM broadcast_recipients WHERE broadcast_id=?1 AND EXISTS (SELECT 1 FROM broadcasts WHERE id=?1 AND status IN (${q}))`).bind(id),
    env.DB.prepare(`DELETE FROM broadcasts WHERE id=?1 AND status IN (${q})`).bind(id),
  ])
  if (gone!.meta.changes) return
  const b = await getBroadcast(env.DB, id)
  if (!b) throw new Bad('broadcast not found', undefined, 404)
  throw new Bad(`A ${b.status} broadcast cannot be deleted. Cancel it first.`, undefined, 409, { error: 'bad_state', status: b.status })
}
