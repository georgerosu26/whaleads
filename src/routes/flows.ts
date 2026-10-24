// /api/flows, /api/flow-runs, /api/leads/:id/flow-runs. The staff gate in index.ts has already run (session or
// ADMIN_KEY, CSRF on state changes). Reads are for any staff; every write is admin-only.
//
// Draft vs published: `flows.graph` is the draft the canvas edits (any time, except archived); `published_graph` is
// what triggers run. Publish validates the draft in full, copies it over, bumps `version` and derives `trigger_kind`
// (and `reentry`, when the trigger node sets one) from the trigger node. Runs in flight keep their snapshot.
import type { Actor } from '../auth'
import { require } from '../auth'
import type { Env } from '../db'
import { logEvent } from '../db'
import { dryRun } from '../flows'
import { assertUrlAllowed, SsrfBlockedError } from '../flows/http-guard'
import { parseGraph, triggerKindOf, validateGraph, type GraphError } from '../flows/graph'
import { SELF_SCRIPT } from '../flows/nodes/http_request'
import { compileSafeRegex } from '../flows/regex'
import { LIMITS, type FlowData } from '../flows/types'
import { json } from '../leads'
import { publishFlowUpdated } from '../live'
import { hit } from '../ratelimit'
import { loadSendableTemplate } from '../send'
import { getAnthropicKey, getSettings } from '../settings'
import { readJson } from './auth'
import { actorId } from './settings'

const nowSec = () => Math.floor(Date.now() / 1000)
const bad = (error: string, field?: string, status = 400) => json({ ok: false, error, ...(field ? { field } : {}) }, status)
const num = (v: string | null, dflt: number, min: number, max: number) => Math.min(Math.max(Math.floor(Number(v)) || dflt, min), max)
const MAX_BODY = 256 * 1024
const MAX_TEMPLATES_CHECKED = 20
const RUN_STATUSES = ['running', 'awaiting', 'completed', 'failed', 'abandoned', 'cancelled']
const FLOW_STATUSES = ['draft', 'active', 'paused', 'archived']

const strip = (errs: GraphError[]) => errs.map((e) => ({ node: e.node, msg: e.msg }))
const actorLabel = (a: Actor | null) => (a?.kind === 'staff' ? `staff:${a.staff.id}` : 'api')

/** What the canvas needs to start from: one trigger with its kind still to choose (a soft warning until it does). */
const emptyGraph = (): FlowData => ({
  nodes: [{ id: 'trigger', type: 'trigger', label: 'Trigger', x: 80, y: 80, width: 220, height: 80, data: {}, ports: [{ id: 'out', label: 'Next', type: 'output' }] }],
  connections: [],
})

const LIST_COLS = `f.id,f.name,f.description,f.status,f.shadow,f.reentry,f.trigger_kind,f.version,f.priority,f.created_by,f.created_at,f.updated_at,f.published_at,
  (f.published_graph IS NOT NULL AND f.graph <> f.published_graph) AS unpublished_changes`

// ---- publish-time checks (need the database or settings; validateGraph is pure) -------------------------------------

/** Everything validateGraph cannot see: template state, the AI key, http targets, regex shapes. Errors, not warnings. */
async function publishChecks(env: Env, g: FlowData): Promise<GraphError[]> {
  const errs: GraphError[] = []
  const push = (node: string, msg: string) => { errs.push({ node, msg }) }
  const seenTpl = new Map<string, { ok: true; body: number; head: number } | { ok: false; message: string }>()
  let selfHosts: string[] | null = null
  let aiKey: boolean | null = null
  for (const n of g.nodes) {
    const d = (n.data ?? {}) as Record<string, unknown>
    if (n.type === 'template') {
      const ref = String(d.templateId ?? d.templateName ?? '')
      if (!ref) continue // validateGraph already says "pick a template"
      if (!seenTpl.has(ref)) {
        if (seenTpl.size >= MAX_TEMPLATES_CHECKED) { push(n.id, `a flow can use at most ${MAX_TEMPLATES_CHECKED} different templates`); continue }
        const f = await loadSendableTemplate(env, { id: d.templateId, name: d.templateName })
        seenTpl.set(ref, f.ok ? { ok: true, body: f.template.body_params_count, head: f.template.header_params_count } : { ok: false, message: f.message })
      }
      // the value counts are per node, so every node using the template is checked, not just the first
      const t = seenTpl.get(ref)!
      if (!t.ok) { push(n.id, t.message); continue }
      const body = Array.isArray(d.bodyParams) ? d.bodyParams.length : 0
      const head = Array.isArray(d.headerParams) ? d.headerParams.length : 0
      if (body !== t.body) push(n.id, `this template needs ${t.body} body value${t.body === 1 ? '' : 's'}, the node has ${body}`)
      else if (head !== t.head) push(n.id, `this template needs ${t.head} header value${t.head === 1 ? '' : 's'}, the node has ${head}`)
    } else if (n.type === 'ai') {
      aiKey ??= !!(await getAnthropicKey(env))
      if (!aiKey) push(n.id, 'AI nodes need the Anthropic key; add it in Settings before publishing')
    } else if (n.type === 'http_request') {
      const method = String(d.method ?? 'GET').toUpperCase()
      const url = String(d.url ?? '').trim()
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) push(n.id, `unsupported HTTP method "${method}"`)
      if (!url) { push(n.id, 'enter a URL'); continue }
      if (url.includes('{{')) { if (!/^https?:\/\//i.test(url)) push(n.id, 'a templated URL must start with http:// or https://'); continue } // host only known at run time; the guard re-checks then
      if (selfHosts === null) {
        const s = await getSettings(env)
        selfHosts = s.allowed_origins.flatMap((o) => { try { return [new URL(o).host.toLowerCase()] } catch { return [] } })
      }
      try { assertUrlAllowed(url, { selfHosts, selfScript: SELF_SCRIPT }) } catch (e) { push(n.id, e instanceof SsrfBlockedError ? `URL not allowed: ${e.message}` : 'URL not allowed') }
    } else if (n.type === 'condition' && d.operator === 'regex') {
      const v = String(d.value ?? '')
      if (v && !v.includes('{{')) { const c = compileSafeRegex(v); if (!c.ok) push(n.id, `regex: ${c.reason}`) }
    }
  }
  return errs
}

// ---- serialisation ------------------------------------------------------------------------------------------------

const parseJson = (s: unknown): unknown => { try { return typeof s === 'string' ? JSON.parse(s) : null } catch { return null } }

async function flowRow(env: Env, id: number): Promise<Record<string, any> | null> {
  return env.DB.prepare(`SELECT ${LIST_COLS}, f.graph, f.published_graph FROM flows f WHERE f.id=?`).bind(id).first<Record<string, any>>()
}

/** A flow for the editor: both graphs as objects. */
function detail(r: Record<string, any>) {
  const { graph, published_graph, ...rest } = r
  return { ...rest, shadow: !!rest.shadow, unpublished_changes: !!rest.unpublished_changes, graph: parseGraph(graph) ?? { nodes: [], connections: [] }, published_graph: parseGraph(published_graph) }
}

const RUN_COLS = `r.id,r.flow_id,r.flow_version,r.lead_id,r.contact_id,r.status,r.shadow,r.trigger,r.current_node_id,r.await_kind,r.resume_at,r.expires_at,r.error,r.started_at,r.updated_at,r.completed_at`
const runOut = (r: Record<string, any>) => ({ ...r, shadow: !!r.shadow })

// ---- handlers --------------------------------------------------------------------------------------------------

async function list(env: Env, url: URL): Promise<Response> {
  const status = url.searchParams.get('status')
  if (status && !FLOW_STATUSES.includes(status)) return bad('bad status', 'status')
  const since = nowSec() - 7 * 86400
  const [flows, liveRuns, recent] = await env.DB.batch([
    env.DB.prepare(`SELECT ${LIST_COLS} FROM flows f ${status ? 'WHERE f.status=?1' : ''} ORDER BY (f.status='archived'), f.priority, f.id LIMIT 200`).bind(...(status ? [status] : [])),
    env.DB.prepare(`SELECT flow_id, status, COUNT(*) AS n FROM flow_runs WHERE status IN ('running','awaiting') GROUP BY flow_id, status`),
    env.DB.prepare(`SELECT flow_id, status, COUNT(*) AS n FROM flow_runs WHERE started_at >= ?1 GROUP BY flow_id, status`).bind(since),
  ])
  // Live statuses count at any age; the finished ones only inside the 7-day window.
  const by = new Map<number, Record<string, number>>()
  for (const o of liveRuns.results as { flow_id: number; status: string; n: number }[]) (by.get(o.flow_id) ?? by.set(o.flow_id, {}).get(o.flow_id)!)[o.status] = o.n
  const win = new Map<number, Record<string, number>>()
  for (const o of recent.results as { flow_id: number; status: string; n: number }[]) (win.get(o.flow_id) ?? win.set(o.flow_id, {}).get(o.flow_id)!)[o.status] = o.n
  return json({
    ok: true,
    flows: (flows.results as Record<string, any>[]).map((f) => {
      const live = by.get(f.id) ?? {}
      const w = win.get(f.id) ?? {}
      return {
        ...f, shadow: !!f.shadow, unpublished_changes: !!f.unpublished_changes,
        active_runs: (live.running ?? 0) + (live.awaiting ?? 0),
        runs_7d: Object.values(w).reduce((a, b) => a + b, 0),
        failed_7d: w.failed ?? 0,
        outcomes_7d: Object.fromEntries(RUN_STATUSES.map((s) => [s, w[s] ?? 0])),
      }
    }),
  })
}

interface Fields { name?: string; description?: string | null; graph?: FlowData; shadow?: number; reentry?: string; priority?: number }

/** Reads the writable fields of a create / update body. Returns a Response on the first bad field. */
function readFields(b: Record<string, unknown>, creating: boolean): Fields | Response {
  const f: Fields = {}
  if ('name' in b || creating) {
    const name = typeof b.name === 'string' ? b.name.trim() : ''
    if (!name || name.length > 80) return bad('name required (max 80 characters)', 'name')
    f.name = name
  }
  if ('description' in b) {
    if (b.description !== null && (typeof b.description !== 'string' || b.description.length > 500)) return bad('description is text up to 500 characters', 'description')
    f.description = b.description === null || b.description === '' ? null : (b.description as string).trim()
  }
  if ('shadow' in b) {
    if (typeof b.shadow !== 'boolean' && b.shadow !== 0 && b.shadow !== 1) return bad('shadow must be true or false', 'shadow')
    f.shadow = b.shadow ? 1 : 0
  }
  if ('reentry' in b) {
    if (b.reentry !== 'once' && b.reentry !== 'each_event') return bad("reentry must be 'once' or 'each_event'", 'reentry')
    f.reentry = b.reentry
  }
  if ('priority' in b) {
    if (!Number.isInteger(b.priority) || (b.priority as number) < 1 || (b.priority as number) > 1000) return bad('priority is a whole number from 1 to 1000', 'priority')
    f.priority = b.priority as number
  }
  if ('graph' in b) {
    if (!b.graph || typeof b.graph !== 'object') return bad('graph must be {nodes[], connections[]}', 'graph')
    f.graph = b.graph as FlowData
  }
  return f
}

/** Storable graph or a 422. Soft problems (loose nodes, no trigger kind yet) come back as warnings. */
function checkDraft(g: FlowData): { errors: GraphError[]; warnings: GraphError[] } {
  const all = validateGraph(g)
  return { errors: all.filter((e) => !e.soft), warnings: all.filter((e) => e.soft) }
}
const invalid = (errors: GraphError[]) => json({ ok: false, error: 'invalid_graph', errors: strip(errors) }, 422)

async function create(req: Request, env: Env, actor: Actor | null): Promise<Response> {
  const b = await readBody(req)
  if (b instanceof Response) return b
  const f = readFields(b, true)
  if (f instanceof Response) return f
  const g = f.graph ?? emptyGraph()
  const { errors, warnings } = checkDraft(g)
  if (errors.length) return invalid(errors)
  try {
    const r = await env.DB.prepare(`INSERT INTO flows (name,description,shadow,reentry,priority,graph,created_by) VALUES (?,?,?,?,?,?,?)`)
      .bind(f.name, f.description ?? null, f.shadow ?? 1, f.reentry ?? 'once', f.priority ?? 100, JSON.stringify(g), actorId(actor)).run()
    await logEvent(env.DB, 'flow_created', { id: r.meta.last_row_id, by: actorLabel(actor) })
    return json({ ok: true, flow: detail((await flowRow(env, r.meta.last_row_id as number))!), warnings: strip(warnings) }, 201)
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) return bad('name_taken', 'name', 409)
    throw e
  }
}

async function readBody(req: Request): Promise<Record<string, unknown> | Response> {
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY) return bad('payload_too_large', undefined, 413)
  return (await readJson(req)) ?? bad('invalid JSON')
}

async function update(req: Request, env: Env, actor: Actor | null, id: number): Promise<Response> {
  const cur = await flowRow(env, id)
  if (!cur) return bad('not found', undefined, 404)
  if (cur.status === 'archived') return bad('flow_archived', undefined, 409)
  const b = await readBody(req)
  if (b instanceof Response) return b
  const f = readFields(b, false)
  if (f instanceof Response) return f
  let warnings: GraphError[] = []
  if (f.graph) {
    const c = checkDraft(f.graph)
    if (c.errors.length) return invalid(c.errors)
    warnings = c.warnings
  }
  const sets: string[] = []
  const args: unknown[] = []
  const put = (col: string, v: unknown) => { args.push(v); sets.push(`${col}=?${args.length}`) }
  if (f.name !== undefined) put('name', f.name)
  if ('description' in f) put('description', f.description ?? null)
  if (f.shadow !== undefined) put('shadow', f.shadow)
  if (f.reentry !== undefined) put('reentry', f.reentry)
  if (f.priority !== undefined) put('priority', f.priority)
  if (f.graph) put('graph', JSON.stringify(f.graph))
  if (!sets.length) return bad('nothing to update')
  put('updated_at', nowSec())
  args.push(id)
  try {
    const r = await env.DB.prepare(`UPDATE flows SET ${sets.join(',')} WHERE id=?${args.length} AND status<>'archived'`).bind(...args).run()
    if (!r.meta.changes) return bad('flow_archived', undefined, 409)
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) return bad('name_taken', 'name', 409)
    throw e
  }
  await logEvent(env.DB, 'flow_updated', { id, fields: Object.keys(f), by: actorLabel(actor) })
  return json({ ok: true, flow: detail((await flowRow(env, id))!), warnings: strip(warnings) })
}

async function publish(env: Env, ctx: ExecutionContext, actor: Actor | null, id: number): Promise<Response> {
  const cur = await flowRow(env, id)
  if (!cur) return bad('not found', undefined, 404)
  if (cur.status === 'archived') return bad('flow_archived', undefined, 409)
  const g = parseGraph(cur.graph)
  if (!g) return invalid([{ node: null, msg: 'graph must be {nodes[], connections[]}' }])
  const errors = [...validateGraph(g), ...(await publishChecks(env, g))]
  if (errors.length) return invalid(errors)
  const kind = triggerKindOf(g)! // validateGraph guarantees a known kind
  const trig = g.nodes.find((n) => n.type === 'trigger')!
  const re = (trig.data as Record<string, unknown>)?.reentry
  const reentry = re === 'once' || re === 'each_event' ? re : cur.reentry
  const now = nowSec()
  // Guarded on the exact draft that was validated: a PUT landing in between makes this a 409, never a publish of unchecked text.
  const r = await env.DB.prepare(
    `UPDATE flows SET published_graph=graph, version=version+1, status='active', trigger_kind=?1, reentry=?2, published_at=?3, updated_at=?3 WHERE id=?4 AND status<>'archived' AND graph=?5`,
  ).bind(kind, reentry, now, id, cur.graph).run()
  if (!r.meta.changes) return bad('flow_changed', undefined, 409)
  const fresh = (await flowRow(env, id))!
  await logEvent(env.DB, 'flow_published', { id, version: fresh.version, kind, by: actorLabel(actor) })
  publishFlowUpdated(env, ctx, { flow_id: id, name: fresh.name, status: 'active', version: fresh.version })
  return json({ ok: true, flow: detail(fresh), warnings: fresh.shadow ? [{ node: null, msg: 'shadow mode is on: runs are recorded but nothing is sent or changed. Turn it off to go live.' }] : [] })
}

async function pause(env: Env, ctx: ExecutionContext, actor: Actor | null, id: number): Promise<Response> {
  const r = await env.DB.prepare(`UPDATE flows SET status='paused', updated_at=? WHERE id=? AND status='active'`).bind(nowSec(), id).run()
  const fresh = await flowRow(env, id)
  if (!fresh) return bad('not found', undefined, 404)
  if (!r.meta.changes) return bad('not_active', undefined, 409)
  await logEvent(env.DB, 'flow_paused', { id, by: actorLabel(actor) })
  publishFlowUpdated(env, ctx, { flow_id: id, name: fresh.name, status: 'paused', version: fresh.version })
  return json({ ok: true, flow: detail(fresh) })
}

async function archive(env: Env, ctx: ExecutionContext, actor: Actor | null, id: number): Promise<Response> {
  const cur = await flowRow(env, id)
  if (!cur) return bad('not found', undefined, 404)
  if (cur.status === 'archived') return bad('flow_archived', undefined, 409)
  const now = nowSec()
  const by = actorLabel(actor)
  // One batch: the timeline row for each awaiting run, then the runs, then the flow. A run that resumes in between
  // wins its own CAS and simply is not cancelled (the status guard on the run UPDATE).
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO activity (lead_id,contact_id,actor,kind,data,created_at)
       SELECT lead_id, contact_id, ?1, 'flow_run', json_object('run_id', id, 'flow', ?2, 'status', 'cancelled', 'shadow', json(CASE WHEN shadow=1 THEN 'true' ELSE 'false' END)), ?3
         FROM flow_runs WHERE flow_id=?4 AND status='awaiting'`,
    ).bind(by, cur.name, now, id),
    env.DB.prepare(`UPDATE flow_runs SET step=step+1, status='cancelled', error='flow_archived', updated_at=?1, completed_at=?1 WHERE flow_id=?2 AND status='awaiting'`).bind(now, id),
    env.DB.prepare(`UPDATE flows SET status='archived', updated_at=?1 WHERE id=?2`).bind(now, id),
  ])
  await logEvent(env.DB, 'flow_archived', { id, by })
  publishFlowUpdated(env, ctx, { flow_id: id, name: cur.name, status: 'archived', version: cur.version })
  return json({ ok: true, flow: detail((await flowRow(env, id))!) })
}

async function duplicate(env: Env, actor: Actor | null, id: number): Promise<Response> {
  const cur = await flowRow(env, id)
  if (!cur) return bad('not found', undefined, 404)
  for (let i = 1; i < 50; i++) {
    const name = `${String(cur.name).slice(0, 70)} copy${i > 1 ? ` ${i}` : ''}`
    try {
      const r = await env.DB.prepare(`INSERT INTO flows (name,description,shadow,reentry,priority,graph,created_by) VALUES (?,?,1,?,?,?,?)`)
        .bind(name, cur.description, cur.reentry, cur.priority, cur.graph, actorId(actor)).run()
      return json({ ok: true, flow: detail((await flowRow(env, r.meta.last_row_id as number))!) }, 201)
    } catch (e) { if (!/UNIQUE/i.test(String(e))) throw e }
  }
  return bad('name_taken', 'name', 409)
}

async function remove(env: Env, actor: Actor | null, id: number): Promise<Response> {
  const r = await env.DB.prepare(`DELETE FROM flows WHERE id=? AND status='draft' AND version=0`).bind(id).run()
  if (!r.meta.changes) return (await flowRow(env, id)) ? bad('not_draft', undefined, 409) : bad('not found', undefined, 404)
  await logEvent(env.DB, 'flow_deleted', { id, by: actorLabel(actor) })
  return json({ ok: true })
}

async function runDry(req: Request, env: Env, actor: Actor | null, id: number): Promise<Response> {
  const cur = await flowRow(env, id)
  if (!cur) return bad('not found', undefined, 404)
  const b = await readBody(req)
  if (b instanceof Response) return b
  const leadId = Number(b.lead_id)
  if (!Number.isInteger(leadId) || leadId < 1) return bad('lead_id required', 'lead_id')
  const text = (v: unknown) => (typeof v === 'string' ? v.slice(0, LIMITS.MAX_MATCH_TEXT) : null)
  const evText = text((b.event as { text?: unknown } | undefined)?.text)
  const rep = typeof b.reply === 'string' ? text(b.reply) : text((b.reply as { text?: unknown } | undefined)?.text)
  if (await hit(env.DB, `flowdry:${actor?.kind === 'staff' ? actor.staff.id : 'api'}`, 10, 60)) return bad('rate_limited', undefined, 429)
  if (!(await env.DB.prepare(`SELECT 1 x FROM leads WHERE id=?`).bind(leadId).first())) return bad('lead_not_found', 'lead_id', 404)
  const g = parseGraph(cur.graph)
  if (!g) return invalid([{ node: null, msg: 'graph must be {nodes[], connections[]}' }])
  // The engine's dry-run mode: every side-effecting node records `would` and routes on; delays fast-forward.
  // 25 s ceiling around the whole thing (the loop's own budget is 20 s).
  let timer: ReturnType<typeof setTimeout> | undefined
  const out = await Promise.race([
    dryRun(env, g, { id: leadId }, { event: evText ? { text: evText } : null, reply: rep ? { kind: 'message', text: rep } : null }),
    new Promise<null>((res) => { timer = setTimeout(() => res(null), 25_000) }),
  ]).finally(() => clearTimeout(timer ?? null))
  if (!out) return bad('dry_run_timeout', undefined, 504)
  if ('errors' in out && !('trace' in out)) return invalid(out.errors)
  const r = out as Exclude<typeof out, { errors: GraphError[] }>
  const { pendingExec: _p, ...context } = r.context
  return json({ ok: true, status: r.status, error: r.error, trace: r.trace, context })
}

async function flowRuns(env: Env, url: URL, id: number): Promise<Response> {
  if (!(await env.DB.prepare(`SELECT 1 x FROM flows WHERE id=?`).bind(id).first())) return bad('not found', undefined, 404)
  return pageRuns(env, url, 'r.flow_id=?1', id)
}

async function leadRuns(env: Env, url: URL, leadId: number): Promise<Response> {
  if (!(await env.DB.prepare(`SELECT 1 x FROM leads WHERE id=?`).bind(leadId).first())) return bad('not found', undefined, 404)
  return pageRuns(env, url, 'r.lead_id=?1', leadId)
}

/** Newest first, keyset on the run id (`before`), 50 per page. */
async function pageRuns(env: Env, url: URL, where: string, key: number): Promise<Response> {
  const status = url.searchParams.get('status')
  if (status && !RUN_STATUSES.includes(status)) return bad('bad status', 'status')
  const limit = num(url.searchParams.get('limit'), 50, 1, 100)
  const beforeRaw = url.searchParams.get('before')
  const before = beforeRaw ? Number(beforeRaw) : null
  if (beforeRaw && !(Number.isInteger(before) && before! > 0)) return bad('bad cursor', 'before')
  const args: unknown[] = [key]
  const conds = [where]
  if (status) { args.push(status); conds.push(`r.status=?${args.length}`) }
  if (before) { args.push(before); conds.push(`r.id<?${args.length}`) }
  args.push(limit + 1)
  const { results } = await env.DB.prepare(
    `SELECT ${RUN_COLS}, f.name AS flow_name, c.name AS contact_name
       FROM flow_runs r JOIN flows f ON f.id = r.flow_id LEFT JOIN contacts c ON c.id = r.contact_id
      WHERE ${conds.join(' AND ')} ORDER BY r.id DESC LIMIT ?${args.length}`,
  ).bind(...args).all<Record<string, any>>()
  const more = results.length > limit
  const page = results.slice(0, limit)
  return json({ ok: true, runs: page.map(runOut), next_before: more ? page[page.length - 1].id : null })
}

async function runDetail(env: Env, id: number): Promise<Response> {
  const r = await env.DB.prepare(`SELECT ${RUN_COLS}, r.trace, r.context, f.name AS flow_name FROM flow_runs r JOIN flows f ON f.id=r.flow_id WHERE r.id=?`).bind(id).first<Record<string, any>>()
  if (!r) return bad('not found', undefined, 404)
  return json({ ok: true, run: { ...runOut(r), trace: parseJson(r.trace) ?? [], context: parseJson(r.context) ?? {} } })
}

async function cancelRun(env: Env, actor: Actor | null, id: number): Promise<Response> {
  const run = await env.DB.prepare(`SELECT r.lead_id,r.contact_id,r.shadow,f.name FROM flow_runs r JOIN flows f ON f.id=r.flow_id WHERE r.id=?`).bind(id).first<Record<string, any>>()
  if (!run) return bad('not found', undefined, 404)
  const now = nowSec()
  const by = actorLabel(actor)
  // The CAS: only a live run flips. A step in flight finishes on a row it no longer owns (its own UPDATE is guarded on 'running').
  const res = await env.DB.batch([
    env.DB.prepare(`UPDATE flow_runs SET step=step+1, status='cancelled', error='cancelled', updated_at=?1, completed_at=?1 WHERE id=?2 AND status IN ('awaiting','running')`).bind(now, id),
    env.DB.prepare(
      `INSERT INTO activity (lead_id,contact_id,actor,kind,data,created_at) SELECT ?1,?2,?3,'flow_run',?4,?5 WHERE changes() > 0`,
    ).bind(run.lead_id, run.contact_id, by, JSON.stringify({ run_id: id, flow: run.name, status: 'cancelled', shadow: run.shadow === 1 }), now),
  ])
  if (!res[0].meta.changes) return bad('not_cancellable', undefined, 409)
  await logEvent(env.DB, 'flow_run_cancelled', { id, by })
  return runDetail(env, id)
}

export async function handleFlows(req: Request, env: Env, ctx: ExecutionContext, path: string, actor: Actor | null, url: URL): Promise<Response | null> {
  const lr = /^\/api\/leads\/([^/]+)\/flow-runs$/.exec(path)
  const badId = (raw: string) => (/^[1-9]\d{0,14}$/.test(raw) ? null : bad('bad id', 'id'))
  // one write limit per staff member for everything below that changes a flow (dry-run has its own, tighter one)
  const writeLimited = async () => (req.method !== 'GET' && !path.endsWith('/dry-run') && (await hit(env.DB, `flowwrite:${actor?.kind === 'staff' ? actor.staff.id : 'api'}`, 60, 60)) ? bad('rate_limited', undefined, 429) : null)
  if (lr) return badId(lr[1]) ?? (req.method === 'GET' ? leadRuns(env, url, Number(lr[1])) : null)
  const fr = /^\/api\/flow-runs\/([^/]+)(\/cancel)?$/.exec(path)
  if (fr) {
    const e = badId(fr[1]); if (e) return e
    if (!fr[2]) return req.method === 'GET' ? runDetail(env, Number(fr[1])) : null
    if (req.method !== 'POST') return null
    return require(actor, 'admin') ?? (await writeLimited()) ?? cancelRun(env, actor, Number(fr[1]))
  }
  const m = /^\/api\/flows(?:\/([^/]+)(?:\/(publish|pause|archive|duplicate|dry-run|runs))?)?$/.exec(path)
  if (!m) return null
  const admin = () => require(actor, 'admin')
  if (!m[1]) {
    if (req.method === 'GET') return list(env, url)
    if (req.method === 'POST') return admin() ?? (await writeLimited()) ?? create(req, env, actor)
    return null
  }
  { const e = badId(m[1]); if (e) return e }
  const id = Number(m[1])
  switch (m[2]) {
    case undefined:
      if (req.method === 'GET') { const r = await flowRow(env, id); return r ? json({ ok: true, flow: detail(r) }) : bad('not found', undefined, 404) }
      if (req.method === 'PUT') return admin() ?? (await writeLimited()) ?? update(req, env, actor, id)
      if (req.method === 'DELETE') return admin() ?? (await writeLimited()) ?? remove(env, actor, id)
      return null
    case 'runs': return req.method === 'GET' ? flowRuns(env, url, id) : null
    case 'dry-run': return req.method === 'POST' ? runDry(req, env, actor, id) : null
    case 'publish': return req.method === 'POST' ? (admin() ?? (await writeLimited()) ?? publish(env, ctx, actor, id)) : null
    case 'pause': return req.method === 'POST' ? (admin() ?? (await writeLimited()) ?? pause(env, ctx, actor, id)) : null
    case 'archive': return req.method === 'POST' ? (admin() ?? (await writeLimited()) ?? archive(env, ctx, actor, id)) : null
    case 'duplicate': return req.method === 'POST' ? (admin() ?? (await writeLimited()) ?? duplicate(env, actor, id)) : null
  }
  return null
}
