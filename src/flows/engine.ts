// The flow interpreter. Lifted from an earlier graph engine (cursor loop; executors return a port or 'await') and
// reshaped for D1: a step persists ONCE at its exit (pause, terminal, or budget), in a single batch together with
// whatever lead writes the step planned. The original wrote per node, which would burn the free plan's 50 D1 calls per
// invocation on a handful of nodes.
//
// A step is one stretch of nodes between two parks. It ends in one of:
//   completed  the cursor ran off the graph (or a node had no connection on the port it chose)
//   awaiting   a delay / wait_event parked the run, or the 20 s wall-clock budget ran out (parked as a due timer)
//   failed     a node threw, the node cap tripped, the graph is broken, or the context outgrew 32 KB; the step's
//              planned writes are dropped (rolled back) and the trace says so
import { activityStmts } from '../crm'
import { publishFlowRun } from '../live'
import { getSettings, type Resolved } from '../settings'
import type { Env } from '../db'
import { buildContext, recordNodeOutput, serializeContext, type RunContext } from './context'
import type { AwaitSpec, ExecutorMap, FlowServices } from './executor'
import { findNextNode, findTriggerNode, getNode, parseGraph, validateGraph, type GraphError } from './graph'
import { meterDb, type Meter } from './meter'
import { EXECUTORS } from './nodes'
import { dispatchFlowStageChange } from './triggers'
import { LIMITS, type FlowData, type TraceEntry } from './types'

export interface FlowRow {
  id: number
  name?: string
  status: string
  shadow: number
  reentry: 'once' | 'each_event'
  version: number
  graph: string
  published_graph: string | null
}

export interface RunRow {
  id: number
  flow_id: number
  flow_version: number
  lead_id: number
  contact_id: number
  status: string
  shadow: number
  /** Bumped by every state write; a resume locks on the value it read. */
  step: number
  trigger: string
  idem_key: string | null
  current_node_id: string | null
  await_kind: 'timer' | 'reply' | null
  resume_at: number | null
  expires_at: number | null
  snapshot: string
  context: string
  trace: string
  error: string | null
  started_at: number
  updated_at: number
  completed_at: number | null
}

export interface StepOpts {
  /** Unix seconds; defaults to the wall clock. */
  now?: number
  /** Wall-clock budget for the step in ms (default LIMITS.STEP_BUDGET_MS). */
  stepBudgetMs?: number
  /** Override the node set (tests). */
  executors?: ExecutorMap
  /** Resolved settings (opening hours); loaded when absent. */
  settings?: Resolved
  /** Max D1 calls this step may make before parking (default LIMITS.STEP_DB_CALLS). */
  dbCap?: number
  /** Millisecond clock (tests). */
  clock?: () => number
  /** The request's ExecutionContext. Live frames and trigger hooks run in waitUntil; without one (cron, tests) they are awaited inline. */
  ctx?: Pick<ExecutionContext, 'waitUntil'>
}

export interface StepResult {
  status: 'completed' | 'awaiting' | 'failed'
  error: string | null
  trace: TraceEntry[]
  nodes: number
}

export const nowSec = () => Math.floor(Date.now() / 1000)

export function meteredEnv(env: Env, m: Meter): Env {
  return { ...env, DB: meterDb(env.DB, m) }
}

export type Entry =
  /** Execute this node first (the trigger on start, or a node parked by the budget). */
  | { exec: string }
  /** Route from this node's port (a delay/wait that finished). */
  | { from: string; port: string }

interface Outcome { status: 'completed' | 'awaiting' | 'failed'; currentNode: string | null; await?: AwaitSpec; error?: string; nodes: number }

/** The cursor loop. Mutates ctx / trace / svc.pending; persists nothing. */
export async function runLoop(svc: FlowServices, flow: FlowData, ctx: RunContext, trace: TraceEntry[], entry: Entry, opts: StepOpts = {}): Promise<Outcome> {
  const clock = opts.clock ?? Date.now
  const deadline = clock() + (opts.stepBudgetMs ?? LIMITS.STEP_BUDGET_MS)
  const executors = opts.executors ?? EXECUTORS
  delete ctx.pendingExec

  let last: string | null = null
  let nodeId: string | null
  if ('exec' in entry) nodeId = entry.exec
  else {
    last = entry.from
    nodeId = findNextNode(flow, entry.from, entry.port)
  }
  let executed = 0
  const fail = (error: string, at: string | null, type: TraceEntry['type'] = 'engine'): Outcome => {
    trace.push({ node: at ?? '-', type, port: null, status: 'failed', at: svc.now, note: error })
    return { status: 'failed', currentNode: at ?? last, error, nodes: executed }
  }

  while (nodeId) {
    if (executed >= LIMITS.MAX_NODES_PER_STEP) return fail(svc.dryRun ? `loop detected: this flow would run forever (dry-run stops at ${LIMITS.MAX_NODES_PER_STEP} nodes)` : `node cap: ${LIMITS.MAX_NODES_PER_STEP} nodes in one step (a loop without a Delay or Wait for reply?)`, nodeId)
    if (clock() >= deadline) {
      ctx.pendingExec = nodeId
      trace.push({ node: nodeId, type: 'engine', port: null, status: 'awaiting', at: svc.now, note: 'step budget spent; continues on the next tick' })
      return { status: 'awaiting', currentNode: nodeId, await: { kind: 'timer', resumeAt: svc.now }, nodes: executed }
    }
    if (executed > 0 && svc.meter && ((svc.dbCap !== undefined && svc.meter.calls >= svc.dbCap) || (svc.meter.subrequests ?? 0) >= LIMITS.STEP_SUBREQUESTS)) {
      ctx.pendingExec = nodeId
      trace.push({ node: nodeId, type: 'engine', port: null, status: 'awaiting', at: svc.now, note: `step D1 cap (${svc.meter.calls} calls, ${svc.meter.subrequests ?? 0} fetches); continues on the next tick` })
      return { status: 'awaiting', currentNode: nodeId, await: { kind: 'timer', resumeAt: svc.now }, nodes: executed }
    }
    const node = getNode(flow, nodeId)
    if (!node) return fail(`node ${nodeId} is missing from the graph`, nodeId)
    const exec = executors[node.type]
    if (!exec) return fail(`${node.type} nodes are not available yet`, node.id, node.type)
    executed++
    let res
    try {
      res = await exec(node, ctx, svc)
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e), node.id, node.type)
    }
    const parked = res.port === 'await'
    if (parked && !res.await) return fail(`${node.type} parked without a wake-up`, node.id, node.type)
    const status = parked ? 'awaiting' : (res.status ?? 'ok')
    recordNodeOutput(ctx, node.id, node.type, res.output, status, svc.now)
    trace.push({ node: node.id, type: node.type, port: parked ? null : res.port, status, at: svc.now, ...(res.note ? { note: res.note } : {}) })
    last = node.id
    if (parked) return { status: 'awaiting', currentNode: node.id, await: res.await, nodes: executed }
    nodeId = findNextNode(flow, node.id, res.port)
  }
  return { status: 'completed', currentNode: last, nodes: executed }
}

export function makeServices(env: Env, run: { id: number | null; flow_id: number; shadow: number }, now: number, graph: FlowData, extra: Partial<Pick<FlowServices, 'dryRun' | 'dryReply' | 'ctx'>> = {}): FlowServices {
  return {
    env, now, graph, ctx: extra.ctx, shadow: run.shadow === 1, dryRun: extra.dryRun ?? false, dryReply: extra.dryReply ?? null,
    runId: run.id, flowId: run.flow_id, actor: `flow:${run.flow_id}`, pending: [],
  }
}

/**
 * Runs one step and persists it. The UPDATE is guarded by `status='running'`: a run an admin cancelled while the
 * step was in flight stays cancelled (its planned lead writes in the same batch still apply; documented edge).
 */
export async function executeStep(env: Env, run: RunRow, flow: FlowData, ctx: RunContext, trace: TraceEntry[], entry: Entry, opts: StepOpts = {}): Promise<StepResult> {
  const now = opts.now ?? nowSec()
  // The step's own meter: its D1 calls (reads in executors, the final batch) count toward the per-step cap.
  const sm: Meter = { calls: 0 }
  const senv = meteredEnv(env, sm)
  const svc = makeServices(senv, run, now, flow, { ctx: opts.ctx })
  svc.meter = sm
  svc.dbCap = opts.dbCap ?? LIMITS.STEP_DB_CALLS
  const out = await runLoop(svc, flow, ctx, trace, entry, opts)

  let status = out.status
  let error = out.error ?? null
  let pending = svc.pending
  let ctxJson = serializeContext(ctx)
  if (status === 'failed' || ctxJson === null) {
    if (ctxJson === null && status !== 'failed') {
      status = 'failed'; error = 'context_too_large'
      trace.push({ node: out.currentNode ?? '-', type: 'engine', port: null, status: 'failed', at: now, note: `run data exceeded ${LIMITS.MAX_CONTEXT_BYTES / 1024} KB` })
    }
    if (pending.length) trace.push({ node: out.currentNode ?? '-', type: 'engine', port: null, status: 'skipped', at: now, note: `step rolled back: ${pending.length} planned write statements dropped` })
    pending = []
    ctxJson = serializeContext({ ...ctx, nodes: {}, vars: {} }) ?? '{}'
  }
  const kept = trace.slice(-LIMITS.MAX_TRACE)
  const terminal = status !== 'awaiting'
  const aw = status === 'awaiting' ? out.await! : null
  // A run that parks while its flow is archived (archive raced the step) is cancelled instead: resume only looks at
  // active flows, so it would otherwise sit awaiting until it expires.
  const archived = `(?1='awaiting' AND (SELECT status FROM flows WHERE id=flow_runs.flow_id)='archived')`
  const update = senv.DB.prepare(
    `UPDATE flow_runs SET step=step+1, status=CASE WHEN ${archived} THEN 'cancelled' ELSE ?1 END, current_node_id=?2, await_kind=?3, resume_at=?4, context=?5, trace=?6,
       error=CASE WHEN ${archived} THEN 'flow_archived' ELSE ?7 END, updated_at=?8, completed_at=CASE WHEN ${archived} THEN ?8 ELSE ?9 END WHERE id=?10 AND status='running'`,
  ).bind(status, out.currentNode, aw?.kind ?? null, aw?.resumeAt ?? null, ctxJson, JSON.stringify(kept), error, now, terminal ? now : null, run.id)

  // the run's own timeline rows. One when it starts, one when it ends (awaiting is not an end). The data is what
  // a card needs without a join: run, flow name, status, shadow.
  const isStart = run.step === 0
  const flowName = ctx.flowName ?? `flow ${run.flow_id}`
  const row = (st: string) => activityStmts(senv, run.lead_id, run.contact_id, svc.actor, 'flow_run', { run_id: run.id, flow: flowName, status: st, shadow: run.shadow === 1 }, now)
  const timeline = [...(isStart ? row('started') : []), ...(terminal ? row(status) : [])]
  const res = await senv.DB.batch([...pending, ...timeline, update])
  const committed = (res[res.length - 1]?.meta.changes ?? 0) > 0

  if (committed) {
    const frame = (st: string) => ({ run_id: run.id, flow_id: run.flow_id, flow: flowName, lead_id: run.lead_id, status: st, shadow: run.shadow === 1, node: out.currentNode })
    publishFlowRun(senv, opts.ctx, [...(isStart ? [frame('started')] : []), frame(status)])
    // A stage the flow just moved (committed above) may start other flows; never the one that moved it (triggers.ts).
    if (svc.stageChanged && status !== 'failed' && run.shadow !== 1) {
      const job = dispatchFlowStageChange(senv, { leadId: run.lead_id, actor: svc.actor, since: now, depth: (ctx.depth ?? 0) + 1 }, { ...opts, now: undefined })
      if (opts.ctx) opts.ctx.waitUntil(job); else await job
    }
  }
  return { status, error, trace: kept, nodes: out.nodes }
}

// ---- start -------------------------------------------------------------------------------------------------

export interface TriggerEvent {
  kind: string
  /** Identifies the event (lead id, wamid, ...). With the flow id and kind it forms the idempotency key. */
  key?: string | number | null
  payload?: Record<string, unknown>
}

export type StartResult =
  | { started: true; runId: number; status: StepResult['status']; error: string | null; trace: TraceEntry[] }
  | { started: false; reason: 'duplicate' | 'live' | 'once' | 'no_graph' | 'invalid_graph' | 'lead_missing' | 'missing_key'; errors?: GraphError[]; error?: string }

/**
 * Starts a run of a flow's published graph for a lead and executes its first step. Idempotent: the same
 * (flow, trigger kind, event key) starts at most one run (UNIQUE idem_key + INSERT OR IGNORE), at most one run per
 * (flow, lead) is live, and a `once` flow never re-enters a lead it has already run for.
 */
export async function startRun(env: Env, flow: FlowRow, lead: { id: number; contact_id: number }, event: TriggerEvent, opts: StepOpts & { skipValidation?: boolean; settings?: Resolved } = {}): Promise<StartResult> {
  const graph = parseGraph(flow.published_graph)
  if (!graph) return { started: false, reason: 'no_graph' }
  if (!opts.skipValidation) {
    const errors = validateGraph(graph)
    if (errors.length) return { started: false, reason: 'invalid_graph', errors }
  }
  const trigger = findTriggerNode(graph)
  if (!trigger) return { started: false, reason: 'no_graph' }

  const m: Meter = { calls: 0 }
  const menv = meteredEnv(env, m)
  const now = opts.now ?? nowSec()
  // Plan section B: flow:lead:kind:key. The lead is in the key so two leads sharing an event key never collide.
  if (event.key === undefined || event.key === null || event.key === '') return { started: false, reason: 'missing_key', error: 'a trigger event needs a key (lead id, wamid, ...); without one the start would not be idempotent' }
  const idem = `${flow.id}:${lead.id}:${event.kind}:${event.key}`

  const ins = await menv.DB.prepare(
    `INSERT OR IGNORE INTO flow_runs (flow_id, flow_version, lead_id, contact_id, status, shadow, trigger, idem_key, current_node_id, expires_at, snapshot, context, trace, started_at, updated_at)
     SELECT ?1, ?2, ?3, ?4, 'running', ?5, ?6, ?7, ?8, ?9, ?10, '{}', '[]', ?11, ?11
      WHERE (?12 = 'each_event' OR NOT EXISTS (SELECT 1 FROM flow_runs WHERE flow_id = ?1 AND lead_id = ?3 AND shadow = ?5))`,
  ).bind(flow.id, flow.version, lead.id, lead.contact_id, flow.shadow ? 1 : 0, event.kind, idem, trigger.id, now + LIMITS.RUN_TTL_S, flow.published_graph, now, flow.reentry).run()

  if (!ins.meta.changes) {
    if (idem && (await menv.DB.prepare(`SELECT 1 x FROM flow_runs WHERE idem_key = ?`).bind(idem).first())) return { started: false, reason: 'duplicate' }
    const prev = await menv.DB.prepare(`SELECT status FROM flow_runs WHERE flow_id = ? AND lead_id = ? AND shadow = ? ORDER BY id DESC LIMIT 1`).bind(flow.id, lead.id, flow.shadow ? 1 : 0).first<{ status: string }>()
    return { started: false, reason: prev && (prev.status === 'running' || prev.status === 'awaiting') ? 'live' : 'once' }
  }
  const runId = ins.meta.last_row_id
  const run: RunRow = {
    id: runId, flow_id: flow.id, flow_version: flow.version, lead_id: lead.id, contact_id: lead.contact_id, status: 'running', shadow: flow.shadow ? 1 : 0, step: 0,
    trigger: event.kind, idem_key: idem, current_node_id: trigger.id, await_kind: null, resume_at: null, expires_at: now + LIMITS.RUN_TTL_S,
    snapshot: flow.published_graph ?? '', context: '{}', trace: '[]', error: null, started_at: now, updated_at: now, completed_at: null,
  }

  const settings = opts.settings ?? (await getSettings(env))
  const ctx = await buildContext(menv, lead.id, now, settings)
  if (!ctx) {
    await menv.DB.prepare(`UPDATE flow_runs SET status='failed', error='lead_missing', updated_at=?1, completed_at=?1 WHERE id=?2`).bind(now, runId).run()
    return { started: false, reason: 'lead_missing' }
  }
  const { depth, ...payload } = event.payload ?? {}
  ctx.lastEvent = { kind: event.kind, ...payload }
  ctx.depth = typeof depth === 'number' && depth > 0 ? depth : 0
  ctx.flowName = flow.name ?? `flow ${flow.id}`
  const r = await executeStep(menv, run, graph, ctx, [], { exec: trigger.id }, { ...opts, now })
  return { started: true, runId, status: r.status, error: r.error, trace: r.trace }
}

// ---- dry run -----------------------------------------------------------------------------------------------

export interface DryRunResult { status: StepResult['status']; error: string | null; trace: TraceEntry[]; context: RunContext; errors?: GraphError[] }

/**
 * Executes a graph in memory for the editor's Test panel: nothing is written (no run row, no lead change),
 * delays fast-forward, and a wait_event completes with `opts.reply` or follows `timeout`.
 */
export async function dryRun(env: Env, graph: FlowData, lead: { id: number }, opts: StepOpts & { reply?: Record<string, unknown> | null; event?: Record<string, unknown> | null; settings?: Resolved } = {}): Promise<DryRunResult | { errors: GraphError[] }> {
  const errors = validateGraph(graph)
  if (errors.length) return { errors }
  const now = opts.now ?? nowSec()
  const ctx = await buildContext(env, lead.id, now, opts.settings)
  if (!ctx) return { errors: [{ node: null, msg: 'lead not found' }] }
  const trigger = findTriggerNode(graph)!
  ctx.lastEvent = { ...(opts.event ?? {}), kind: 'dry_run' }
  const svc = makeServices(env, { id: null, flow_id: 0, shadow: 1 }, now, graph, { dryRun: true, dryReply: opts.reply ?? null })
  const trace: TraceEntry[] = []
  const out = await runLoop(svc, graph, ctx, trace, { exec: trigger.id }, opts)
  return { status: out.status, error: out.error ?? null, trace, context: ctx }
}
