// Flow graph types. Lifted from an earlier graph engine and trimmed to WhaLeads' palette:
// one channel (text/template over the active adaptor), no voice. The persisted graph is exactly a FlowData.

export type NodeType =
  | 'trigger' | 'message' | 'template' | 'condition' | 'action' | 'delay'
  | 'ai' | 'variable' | 'http_request' | 'wait_event' | 'lead_writeback'

/** Every node type the editor may place. */
export const NODE_TYPES: readonly NodeType[] = [
  'trigger', 'message', 'template', 'condition', 'action', 'delay', 'ai', 'variable', 'http_request', 'wait_event', 'lead_writeback',
]

export interface FlowNodePort { id: string; label: string; type: 'input' | 'output' }

export interface FlowNode {
  id: string
  type: NodeType
  label: string
  x: number
  y: number
  width: number
  height: number
  /** Node-type-specific config. */
  data: Record<string, unknown>
  ports: FlowNodePort[]
}

export interface FlowConnection {
  id: string
  fromNodeId: string
  /** Semantic output port id the engine routes by. */
  fromPortId: string
  toNodeId: string
  toPortId: string
}

export interface FlowData { nodes: FlowNode[]; connections: FlowConnection[]; /** editor bookkeeping: next free step number per node type, so a deleted step's id is never reused */ next_ids?: Record<string, number> }

/** A port id a node routed to, or 'await' meaning the run parks here. */
export type NodePort = string

export const SEMANTIC_PORTS = ['out', 'yes', 'no', 'success', 'error', 'completed', 'timeout', 'default'] as const

/** Output ports each node type may route from. Used by validateGraph. */
export const OUTPUT_PORTS: Record<NodeType, readonly string[]> = {
  trigger: ['out'],
  // window_closed is optional: a text send outside the 24 h window routes there when connected, else the run fails cleanly.
  message: ['out', 'error', 'window_closed'],
  template: ['out', 'error'],
  condition: ['yes', 'no'],
  action: ['out'],
  delay: ['out'],
  ai: ['out', 'error'],
  variable: ['out'],
  http_request: ['success', 'error'],
  wait_event: ['completed', 'timeout'],
  lead_writeback: ['out'],
}

export type TriggerKind = 'lead_created' | 'message_received' | 'stage_changed'
export const TRIGGER_KINDS: readonly TriggerKind[] = ['lead_created', 'message_received', 'stage_changed']

export type RunStatus = 'running' | 'awaiting' | 'completed' | 'failed' | 'abandoned' | 'cancelled'
export type AwaitKind = 'timer' | 'reply'

/** The limits the engine enforces. Free plan: 50 subrequests and 50 D1 queries per invocation, 30 s of waitUntil. */
export const LIMITS = {
  /** Nodes executed in one step before the run is failed (a loop without a delay or wait). */
  MAX_NODES_PER_STEP: 50,
  /** Wall clock for one step; past it the run parks as a due timer and the next tick continues it. */
  STEP_BUDGET_MS: 20_000,
  /** D1 calls one step may make before it parks as a due timer (the free plan allows 50 per invocation in total). */
  STEP_DB_CALLS: 30,
  /** Outbound fetches one step may make before it parks as a due timer (free plan: 50 subrequests per invocation in total). */
  STEP_SUBREQUESTS: 30,
  /** Reserved for a resume's own bookkeeping outside the step loop (read, CAS, reload, final batch, sweeps). */
  RESUME_RESERVE: 13,
  /** Due runs resumed per cron tick, oldest first. */
  RESUMES_PER_TICK: 10,
  /** D1 calls a tick may spend (the free plan allows 50 per invocation, the rest is headroom for schema + cron jobs). */
  TICK_DB_CALLS: 40,
  /** Same, on the minutes the 15-minute jobs also run in. */
  TICK_DB_CALLS_SHARED: 20,
  MAX_CONTEXT_BYTES: 32 * 1024,
  MAX_TRACE: 100,
  DELAY_MIN_S: 60,
  DELAY_MAX_S: 30 * 86400,
  WAIT_DEFAULT_S: 24 * 3600,
  WAIT_MAX_S: 7 * 86400,
  RUN_TTL_S: 30 * 86400,
  /** A run left `running` this long is a crashed step; the tick fails it. */
  STALL_S: 600,
  MAX_GRAPH_BYTES: 64 * 1024,
  MAX_NODES: 60,
  MAX_REGEX: 200,
  /** A message.received regex only ever sees this many characters of the text. */
  MAX_MATCH_TEXT: 1000,
  /** Chain depth: a flow's own stage change may start other flows up to this many hops deep. */
  MAX_TRIGGER_DEPTH: 3,
  /** Flows one event may start (the free plan allows 50 subrequests per invocation). */
  MAX_FLOWS_PER_EVENT: 5,
  /** Reply-loop cap: message.received runs one flow may start for one contact in a rolling hour. */
  MESSAGE_RUNS_PER_HOUR: 10,
  /** AI node: hard timeout and output cap. */
  AI_TIMEOUT_MS: 8_000,
  AI_MAX_TOKENS: 300,
  AI_MAX_TOKENS_CEILING: 1024,
  AI_MAX_INPUT_CHARS: 8_000,
  RETENTION_DAYS: 90,
} as const

export interface TraceEntry { node: string; type: NodeType | 'engine'; port: string | null; status: 'ok' | 'awaiting' | 'skipped' | 'failed'; at: number; note?: string }
