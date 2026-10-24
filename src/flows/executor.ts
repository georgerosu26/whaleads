// The executor contract. An executor returns the output port to route by, or 'await' (with an `await` descriptor)
// to park the run. It may push D1 statements onto `svc.pending`; the engine flushes them together with the run's
// state in ONE batch, so a lead write and the cursor move can never disagree.
import type { Env } from '../db'
import type { RunContext } from './context'
import type { Meter } from './meter'
import type { AwaitKind, FlowData, FlowNode, NodePort, NodeType } from './types'

export interface FlowServices {
  /** Metered env: every D1 call made through it is counted. */
  env: Env
  /** Unix seconds for this step (fixed so a step is internally consistent and tests can pin it). */
  now: number
  /** Shadow: the run is real (real waits, real branching) but writes and sends are recorded as `would_*`. */
  shadow: boolean
  /** Dry run: nothing is persisted, delays fast-forward, a reply is supplied by the caller. */
  dryRun: boolean
  runId: number | null
  flowId: number
  /** Actor label on every write the flow makes. */
  actor: string
  /** The graph being run, so a node can ask which of its ports are connected (message: window_closed). */
  graph: FlowData
  /** The request's ExecutionContext, when there is one (live publishes inside a send run in waitUntil). */
  ctx?: Pick<ExecutionContext, 'waitUntil'>
  /** Set by an executor that planned a stage change this step. The engine dispatches stage.changed hooks after the step commits. */
  stageChanged?: boolean
  /** Statements to commit with the run state at the end of the step. */
  pending: D1PreparedStatement[]
  /** The reply a dry run's wait_event completes with; null follows `timeout`. */
  dryReply: Record<string, unknown> | null
  /** D1 calls made by this step (own meter); the engine parks the run when it reaches `dbCap`. Absent in dry runs. */
  meter?: Meter
  dbCap?: number
  /** Tag state loaded once per step: every tag (id -> label) and the lead's tag ids, kept current as tag nodes plan. */
  tagState?: { known: Map<number, string>; have: Set<number> }
  /** Lazily loaded lead row used to plan writes; patched after each planned write in the same step. */
  leadRow?: { id: number; contact_id: number; status: string; assigned_to: number | null; next_action_at: number | null; won_at: number | null; closed_at: number | null; lost_reason: string | null }
}

export interface AwaitSpec { kind: AwaitKind; resumeAt: number }

export interface ExecResult {
  port: NodePort
  output: Record<string, unknown>
  status?: 'ok' | 'skipped' | 'failed'
  await?: AwaitSpec
  note?: string
}

export type NodeExecutor = (node: FlowNode, ctx: RunContext, svc: FlowServices) => Promise<ExecResult>
export type ExecutorMap = Partial<Record<NodeType, NodeExecutor>>
