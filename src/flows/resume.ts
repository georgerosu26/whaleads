// Resuming a parked run. The status CAS (`awaiting` -> `running`) is the lock: of any number of racing resumes
// (two isolates, a reply landing as the timeout fires) exactly one gets changes=1 and continues; the rest are no-ops.
import type { Env } from '../db'
import { buildContext, type RunContext } from './context'
import { executeStep, nowSec, type RunRow, type StepOpts, type StepResult } from './engine'
import { parseGraph } from './graph'
import { LIMITS, type TraceEntry } from './types'

export type ResumeEvent =
  /** A due timer, or the continuation of a step the wall-clock budget cut short. */
  | { kind: 'timer' }
  /** The contact's next message. `key` (the wamid) makes a redelivery a no-op. */
  | { kind: 'reply'; key: string; payload?: Record<string, unknown> }
  /** A reply wait whose time ran out. */
  | { kind: 'timeout' }

export type ResumeResult =
  | { resumed: true; status: StepResult['status']; error: string | null; trace: TraceEntry[] }
  | { resumed: false; reason: 'not_found' | 'not_awaiting' | 'wrong_kind' | 'not_due' | 'duplicate_event' | 'race' | 'corrupt' }

const APPLIED_KEEP = 50

export async function resumeRun(env: Env, runId: number, event: ResumeEvent, opts: StepOpts = {}): Promise<ResumeResult> {
  const now = opts.now ?? nowSec()
  const run = await env.DB.prepare(`SELECT * FROM flow_runs WHERE id = ?`).bind(runId).first<RunRow>()
  if (!run) return { resumed: false, reason: 'not_found' }
  if (run.status !== 'awaiting' || !run.current_node_id) return { resumed: false, reason: 'not_awaiting' }
  const need = event.kind === 'timer' ? 'timer' : 'reply'
  if (run.await_kind !== need) return { resumed: false, reason: 'wrong_kind' }
  if ((event.kind === 'timer' || event.kind === 'timeout') && (run.resume_at ?? 0) > now) return { resumed: false, reason: 'not_due' }

  const graph = parseGraph(run.snapshot)
  let ctx: RunContext | null = null
  try { ctx = JSON.parse(run.context) as RunContext } catch { ctx = null }
  if (!graph || !ctx || typeof ctx !== 'object' || !ctx.nodes) {
    await env.DB.prepare(`UPDATE flow_runs SET step=step+1, status='failed', error='corrupt_run', updated_at=?1, completed_at=?1 WHERE id=?2 AND status='awaiting'`).bind(now, runId).run()
    return { resumed: false, reason: 'corrupt' }
  }
  if (event.kind === 'reply' && ctx.applied?.includes(event.key)) return { resumed: false, reason: 'duplicate_event' }

  // The lock is on the step we read, not just the kind: a resume that read the run parked at w1 must lose if another
  // resume has since moved it on (and parked it at w2, same kind) - it would otherwise replay w1 with stale context.
  const cas = await env.DB.prepare(`UPDATE flow_runs SET status='running', step=step+1, updated_at=?1 WHERE id=?2 AND status='awaiting' AND await_kind=?3 AND step=?4`).bind(now, runId, run.await_kind, run.step).run()
  if (cas.meta.changes !== 1) return { resumed: false, reason: 'race' }

  const cur = run.current_node_id
  run.step += 1
  const trace = safeTrace(run.trace)
  trace.push({ node: cur, type: 'engine', port: null, status: 'ok', at: now, note: `resumed: ${event.kind}` })
  let entry: Parameters<typeof executeStep>[5]
  if (event.kind === 'timer') {
    entry = ctx.pendingExec && ctx.pendingExec === cur ? { exec: cur } : { from: cur, port: 'out' }
  } else if (event.kind === 'reply') {
    const payload = event.payload ?? {}
    ctx.lastEvent = payload
    ctx.applied = [...(ctx.applied ?? []), event.key].slice(-APPLIED_KEEP)
    const prev = ctx.nodes[cur]
    if (prev) ctx.nodes[cur] = { ...prev, output: { ...prev.output, reply: payload }, status: 'ok', at: now }
    entry = { from: cur, port: 'completed' }
  } else {
    const prev = ctx.nodes[cur]
    if (prev) ctx.nodes[cur] = { ...prev, output: { ...prev.output, timed_out: true }, status: 'ok', at: now }
    entry = { from: cur, port: 'timeout' }
  }

  try {
    // Data goes stale across waits: reload the lead (stage, tags, owner), contact and opening hours.
    const fresh = await buildContext(env, run.lead_id, now, opts.settings)
    if (!fresh) {
      await env.DB.prepare(`UPDATE flow_runs SET step=step+1, status='failed', error='lead_missing', updated_at=?1, completed_at=?1 WHERE id=?2 AND status='running'`).bind(now, runId).run()
      trace.push({ node: cur, type: 'engine', port: null, status: 'failed', at: now, note: 'lead_missing' })
      return { resumed: true, status: 'failed', error: 'lead_missing', trace }
    }
    ctx.lead = fresh.lead
    ctx.contact = fresh.contact
    ctx.business = fresh.business
    const r = await executeStep(env, run, graph, ctx, trace, entry, { ...opts, now })
    return { resumed: true, status: r.status, error: r.error, trace: r.trace }
  } catch (e) {
    // The step could not even persist. Fail the run so it does not sit in `running` until the stall sweep.
    const error = e instanceof Error ? e.message.slice(0, 300) : 'step_failed'
    await env.DB.prepare(`UPDATE flow_runs SET step=step+1, status='failed', error=?1, updated_at=?2, completed_at=?2 WHERE id=?3 AND status='running'`).bind(error, now, runId).run().catch(() => {})
    return { resumed: true, status: 'failed', error, trace }
  }
}

function safeTrace(text: string): TraceEntry[] {
  try { const t = JSON.parse(text) as TraceEntry[]; return Array.isArray(t) ? t.slice(-(LIMITS.MAX_TRACE - 1)) : [] } catch { return [] }
}

/** The live run (oldest first; shadow runs never take a real reply) waiting on this contact's next message, or null. Served by flow_runs_reply. */
export async function findAwaitingReply(env: Env, contactId: number): Promise<number | null> {
  const r = await env.DB.prepare(
    `SELECT r.id FROM flow_runs r JOIN flows f ON f.id = r.flow_id
      WHERE r.contact_id = ? AND r.status = 'awaiting' AND r.await_kind = 'reply' AND r.shadow = 0 AND f.status = 'active' ORDER BY r.id LIMIT 1`,
  ).bind(contactId).first<{ id: number }>()
  return r?.id ?? null
}

/** Inbound-message hook: hands the message to the run waiting on this contact, if any. */
export async function resumeOnReply(env: Env, contactId: number, wamid: string, payload: Record<string, unknown>, opts: StepOpts = {}): Promise<ResumeResult | null> {
  const id = await findAwaitingReply(env, contactId)
  return id === null ? null : resumeRun(env, id, { kind: 'reply', key: wamid, payload }, opts)
}
