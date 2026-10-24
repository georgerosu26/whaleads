// Trigger hooks: turn product events into flow runs.
//   lead.created     filters: sources[], stages[]
//   message.received filters: match 'any' | 'keyword' (keywords[]) | 'regex' (regexPattern, safe-regex guard)
//   stage.changed    filters: from[], to[]
// Only ACTIVE flows with a published graph run. A shadow flow runs in shadow (startRun reads flow.shadow).
// Idempotency is startRun's `flow:lead:kind:key` key: wamid for messages, lead id for lead.created, activity id for
// stage.changed, so a redelivered webhook or a retried hook starts nothing twice.
//
// Loop guard (stage.changed): a stage move made by `flow:<id>` never starts flow <id> again, and every start carries
// a depth (flow A moves a stage -> flow B starts at depth 1 -> B moves a stage -> flow C at depth 2 ...) capped at
// LIMITS.MAX_TRIGGER_DEPTH, so a ring of flows moving each other's stages stops instead of spinning.
//
// Every entry point here is "never throws": a hook failure is logged and must not break the webhook / request that
// called it.
import type { Env } from '../db'
import { logEvent } from '../db'
import { startRun, type FlowRow, type StepOpts } from './engine'
import { findTriggerNode, parseGraph } from './graph'
import { clipText, compileSafeRegex } from './regex'
import { resumeOnReply } from './resume'
import { LIMITS, type FlowData } from './types'

type Hooks = StepOpts & { skipValidation?: boolean }

interface LeadRef { id: number; contact_id: number; source: string; status: string }

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [])

/** Active, published flows for a trigger kind, in priority order. */
export async function flowsFor(env: Env, kind: string): Promise<(FlowRow & { graphData: FlowData })[]> {
  const { results } = await env.DB.prepare(
    `SELECT id,name,status,shadow,reentry,version,graph,published_graph FROM flows
      WHERE status='active' AND trigger_kind=? AND published_graph IS NOT NULL ORDER BY priority, id LIMIT ?`,
  ).bind(kind, LIMITS.MAX_FLOWS_PER_EVENT).all<FlowRow>()
  const out: (FlowRow & { graphData: FlowData })[] = []
  for (const f of results) {
    const g = parseGraph(f.published_graph)
    if (g) out.push({ ...f, graphData: g })
  }
  return out
}

const triggerData = (g: FlowData): Record<string, unknown> => (findTriggerNode(g)?.data ?? {}) as Record<string, unknown>

/** Does a message body satisfy the trigger's match rule? Empty rule lists never match (fail closed). */
export function messageMatches(data: Record<string, unknown>, text: string): boolean {
  const mode = data.match === 'keyword' || data.match === 'regex' ? data.match : 'any'
  if (mode === 'any') return true
  const t = clipText(text)
  if (mode === 'keyword') {
    const low = t.toLowerCase()
    return strList(data.keywords).some((k) => low.includes(k.toLowerCase()))
  }
  const c = compileSafeRegex(data.regexPattern)
  return c.ok ? c.re.test(t) : false
}

const inList = (list: string[], v: string | null | undefined) => list.length === 0 || (v !== null && v !== undefined && list.includes(v))

async function leadRef(env: Env, leadId: number): Promise<LeadRef | null> {
  return env.DB.prepare(`SELECT id,contact_id,source,status FROM leads WHERE id=?`).bind(leadId).first<LeadRef>()
}

/**
 * Reply-loop cap: a match-any message.received flow with a message node can ping-pong with an outside auto-responder.
 * One flow starts at most MESSAGE_RUNS_PER_HOUR runs per contact per rolling hour; the excess is refused
 * (`rate_capped`) and leaves one `flow_run` activity row per hour so the refusal is visible.
 */
async function rateCapped(env: Env, f: FlowRow, lead: LeadRef, key: string | number, opts: Hooks): Promise<boolean> {
  const now = opts.now ?? Math.floor(Date.now() / 1000)
  const since = now - 3600
  const n = await env.DB.prepare(`SELECT count(*) AS n FROM flow_runs WHERE flow_id=? AND contact_id=? AND trigger='message_received' AND started_at>=?`).bind(f.id, lead.contact_id, since).first<{ n: number }>()
  if ((n?.n ?? 0) < LIMITS.MESSAGE_RUNS_PER_HOUR) return false
  if (await env.DB.prepare(`SELECT 1 x FROM flow_runs WHERE idem_key=?`).bind(`${f.id}:${lead.id}:message_received:${key}`).first()) return false // a redelivery: startRun reports the duplicate
  const seen = await env.DB.prepare(`SELECT 1 x FROM activity WHERE lead_id=? AND kind='flow_run' AND actor=? AND created_at>=? AND data LIKE '%rate_capped%'`).bind(lead.id, `flow:${f.id}`, since).first()
  if (!seen) {
    await env.DB.prepare(`INSERT INTO activity (lead_id,contact_id,actor,kind,data,created_at) VALUES (?,?,?,?,?,?)`)
      .bind(lead.id, lead.contact_id, `flow:${f.id}`, 'flow_run', JSON.stringify({ run_id: null, flow: f.name, status: 'rate_capped', reason: 'rate_capped', limit: LIMITS.MESSAGE_RUNS_PER_HOUR, shadow: f.shadow === 1 }), now).run()
  }
  return true
}

async function run(env: Env, f: FlowRow, lead: LeadRef, kind: string, key: string | number, payload: Record<string, unknown>, opts: Hooks): Promise<boolean> {
  try {
    if (kind === 'message_received' && (await rateCapped(env, f, lead, key, opts))) return false
    const r = await startRun(env, f, lead, { kind, key, payload }, opts)
    return r.started
  } catch (e) {
    await logEvent(env.DB, 'flow_trigger_error', { flow: f.id, kind, error: String(e) })
    return false
  }
}

// ---- lead.created ----------------------------------------------------------------------------------------------

export async function dispatchLeadCreated(env: Env, leadId: number, opts: Hooks = {}, depth = 0): Promise<number> {
  const lead = await leadRef(env, leadId)
  if (!lead || depth > LIMITS.MAX_TRIGGER_DEPTH) return 0
  let n = 0
  for (const f of await flowsFor(env, 'lead_created')) {
    const d = triggerData(f.graphData)
    if (!inList(strList(d.sources), lead.source) || !inList(strList(d.stages), lead.status)) continue
    if (await run(env, f, lead, 'lead_created', lead.id, { source: lead.source, depth }, opts)) n++
  }
  return n
}

// ---- message.received ------------------------------------------------------------------------------------------

export async function dispatchMessageReceived(env: Env, lead: LeadRef, wamid: string, text: string, opts: Hooks = {}): Promise<number> {
  let n = 0
  for (const f of await flowsFor(env, 'message_received')) {
    if (!messageMatches(triggerData(f.graphData), text)) continue
    if (await run(env, f, lead, 'message_received', wamid, { wamid, text: clipText(text) }, opts)) n++
  }
  return n
}

// ---- stage.changed ---------------------------------------------------------------------------------------------

/**
 * Starts the stage.changed flows for one stage-change activity row. `actor` is who made the move: a flow actor
 * (`flow:<id>`) never re-triggers that same flow.
 */
export async function dispatchStageChange(env: Env, lead: LeadRef, activityId: number, from: string | null, to: string, actor: string, depth: number, opts: Hooks = {}, flows?: Awaited<ReturnType<typeof flowsFor>>): Promise<number> {
  if (depth > LIMITS.MAX_TRIGGER_DEPTH) return 0
  let n = 0
  for (const f of flows ?? await flowsFor(env, 'stage_changed')) {
    if (actor === `flow:${f.id}`) continue
    const d = triggerData(f.graphData)
    if (!inList(strList(d.from), from) || !inList(strList(d.to), to)) continue
    if (await run(env, f, lead, 'stage_changed', activityId, { from, to, actor, depth }, opts)) n++
  }
  return n
}

interface StageAct { id: number; actor: string; data: string | null }

/**
 * Finds the stage_changed activity rows to dispatch for a lead: those written by `actor` (a flow, when it moved the
 * stage) at or after `since`, or just the newest one (staff / API edits). Never throws.
 */
export async function dispatchFlowStageChange(env: Env, a: { leadId: number; actor?: string; since?: number; afterId?: number; depth: number }, opts: Hooks = {}): Promise<number> {
  try {
    if (a.depth > LIMITS.MAX_TRIGGER_DEPTH) return 0
    // One cheap read first: with no stage.changed flow there is nothing to look up (the common case, and it keeps a step's D1 cost flat).
    const flows = await flowsFor(env, 'stage_changed')
    if (!flows.length) return 0
    const lead = await leadRef(env, a.leadId)
    if (!lead) return 0
    const q = a.actor
      ? env.DB.prepare(`SELECT id,actor,data FROM activity WHERE lead_id=? AND kind='stage_changed' AND actor=? AND created_at>=? ORDER BY id DESC LIMIT 3`).bind(a.leadId, a.actor, a.since ?? 0)
      : a.afterId !== undefined
        // A staff / API edit: every stage change written since the id the PATCH saw before its batch, so two quick edits both fire.
        ? env.DB.prepare(`SELECT id,actor,data FROM activity WHERE lead_id=? AND kind='stage_changed' AND id>? ORDER BY id DESC LIMIT 3`).bind(a.leadId, a.afterId)
        : env.DB.prepare(`SELECT id,actor,data FROM activity WHERE lead_id=? AND kind='stage_changed' ORDER BY id DESC LIMIT 1`).bind(a.leadId)
    const { results } = await q.all<StageAct>()
    let n = 0
    for (const r of results.reverse()) {
      let data: { from?: unknown; to?: unknown } = {}
      try { data = JSON.parse(r.data ?? '{}') } catch { /* empty */ }
      if (typeof data.to !== 'string') continue
      n += await dispatchStageChange(env, lead, r.id, typeof data.from === 'string' ? data.from : null, data.to, r.actor, a.depth, { ...opts, now: undefined }, flows)
    }
    return n
  } catch (e) {
    await logEvent(env.DB, 'flow_trigger_error', { kind: 'stage_changed', lead: a.leadId, error: String(e) })
    return 0
  }
}

// ---- hook entry points -----------------------------------------------------------------------------------------

type Ctx = Pick<ExecutionContext, 'waitUntil'> | undefined

function defer(ctx: Ctx, job: Promise<unknown>): Promise<unknown> | void {
  const safe = job.catch(() => undefined)
  if (ctx) { ctx.waitUntil(safe); return }
  return safe
}

/** A new lead exists (intake form, manual create). */
export function onLeadCreated(env: Env, ctx: Ctx, leadId: number, opts: Hooks = {}): Promise<unknown> | void {
  return defer(ctx, hookGuard(env, 'lead_created', () => dispatchLeadCreated(env, leadId, { ...opts, ctx })))
}

/** A staff / API stage edit just committed on this lead. */
export function onStageEdited(env: Env, ctx: Ctx, leadId: number, afterId?: number, opts: Hooks = {}): Promise<unknown> | void {
  return defer(ctx, dispatchFlowStageChange(env, { leadId, afterId, depth: 1 }, { ...opts, ctx }))
}

/**
 * An inbound message was stored (new wamid only). A run waiting on a reply takes it first; if one resumed, the
 * message is consumed and no message.received flow starts for it. Otherwise message.received flows match, then
 * lead.created when this message created the lead.
 */
export function onInboundMessage(env: Env, ctx: Ctx, m: { contactId: number; wamid: string; text: string | null; newLeadId?: number }, opts: Hooks = {}): Promise<unknown> | void {
  return defer(ctx, hookGuard(env, 'inbound', async () => {
    const o = { ...opts, ctx }
    const text = m.text ?? ''
    const resumed = await resumeOnReply(env, m.contactId, m.wamid, { text: clipText(text), wamid: m.wamid }, o)
    const consumed = !!resumed && (resumed.resumed || resumed.reason === 'duplicate_event')
    if (!consumed) {
      const lead = m.newLeadId
        ? await leadRef(env, m.newLeadId)
        : await env.DB.prepare(
            `SELECT id,contact_id,source,status FROM leads WHERE contact_id=?1 AND status IN (SELECT key FROM stages WHERE kind = 'open')
              ORDER BY created_at DESC, id DESC LIMIT 1`,
          ).bind(m.contactId).first<LeadRef>()
      if (lead) await dispatchMessageReceived(env, lead, m.wamid, text, o)
    }
    if (m.newLeadId) await dispatchLeadCreated(env, m.newLeadId, o)
  }))
}

async function hookGuard(env: Env, kind: string, fn: () => Promise<unknown>): Promise<void> {
  try { await fn() } catch (e) { await logEvent(env.DB, 'flow_trigger_error', { kind, error: String(e) }) }
}
