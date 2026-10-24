// the Automations API client and shared types. The graph contract is the server's (src/flows/types.ts), imported
// so the editor and the engine can never drift on node types, ports or limits.
import { ApiError, api } from './api'
import type { FlowConnection, FlowData, FlowNode, FlowNodePort, NodeType, TraceEntry } from '../../../src/flows/types'

export type { FlowConnection, FlowData, FlowNode, FlowNodePort, NodeType, TraceEntry }
export type FlowStatus = 'draft' | 'active' | 'paused' | 'archived'
export type RunStatus = 'running' | 'awaiting' | 'completed' | 'failed' | 'abandoned' | 'cancelled'
export const RUN_STATUSES: RunStatus[] = ['running', 'awaiting', 'completed', 'failed', 'abandoned', 'cancelled']

export interface GraphIssue { node: string | null; msg: string }

export interface FlowSummary {
  id: number; name: string; description: string | null; status: FlowStatus; shadow: boolean; reentry: string; trigger_kind: string | null
  version: number; priority: number; created_at: number; updated_at: number; published_at: number | null; unpublished_changes: boolean
  active_runs: number; runs_7d: number; failed_7d: number; outcomes_7d: Record<string, number>
}
export interface FlowDetail extends Omit<FlowSummary, 'active_runs' | 'runs_7d' | 'failed_7d' | 'outcomes_7d'> {
  graph: FlowData; published_graph: FlowData | null
}
export interface RunRow {
  id: number; flow_id: number; flow_version: number; lead_id: number; contact_id: number | null; status: RunStatus; shadow: boolean
  trigger: string | null; current_node_id: string | null; await_kind: string | null; resume_at: number | null; expires_at: number | null
  error: string | null; started_at: number; updated_at: number; completed_at: number | null; flow_name?: string; contact_name?: string | null
}
export interface RunDetail extends RunRow { trace: TraceEntry[]; context: RunContext }
export interface RunContext { nodes?: Record<string, { output?: Record<string, unknown>; status?: string }>; vars?: Record<string, unknown> }
export interface DryRunResult { ok: boolean; status: string; error: string | null; trace: TraceEntry[]; context: RunContext }
/** The `flow.run` live frame. */
export interface FlowRunFrame { run_id: number; flow_id: number; flow: string; lead_id: number; status: RunStatus; shadow: boolean; node: string | null }

type Warn = { warnings?: GraphIssue[] }

export const flowsApi = {
  list: () => api<{ flows: FlowSummary[] }>('/api/flows'),
  get: (id: number) => api<{ flow: FlowDetail }>(`/api/flows/${id}`),
  create: (name: string) => api<{ flow: FlowDetail } & Warn>('/api/flows', { method: 'POST', body: { name } }),
  save: (id: number, body: { name?: string; shadow?: boolean; graph?: FlowData; description?: string | null }) =>
    api<{ flow: FlowDetail } & Warn>(`/api/flows/${id}`, { method: 'PUT', body }),
  publish: (id: number) => api<{ flow: FlowDetail } & Warn>(`/api/flows/${id}/publish`, { method: 'POST' }),
  pause: (id: number) => api<{ flow: FlowDetail }>(`/api/flows/${id}/pause`, { method: 'POST' }),
  archive: (id: number) => api<{ flow: FlowDetail }>(`/api/flows/${id}/archive`, { method: 'POST' }),
  duplicate: (id: number) => api<{ flow: FlowDetail }>(`/api/flows/${id}/duplicate`, { method: 'POST' }),
  dryRun: (id: number, body: { lead_id: number; event?: { text: string }; reply?: string }) =>
    api<DryRunResult>(`/api/flows/${id}/dry-run`, { method: 'POST', body }),
  runs: (id: number, o: { status?: string; before?: number | null } = {}) => {
    const q = new URLSearchParams()
    if (o.status) q.set('status', o.status)
    if (o.before) q.set('before', String(o.before))
    return api<{ runs: RunRow[]; next_before: number | null }>(`/api/flows/${id}/runs${q.size ? `?${q}` : ''}`)
  },
  run: (id: number) => api<{ run: RunDetail }>(`/api/flow-runs/${id}`),
  cancelRun: (id: number) => api<{ run: RunDetail }>(`/api/flow-runs/${id}/cancel`, { method: 'POST' }),
}

/** The `errors` list of a 422 invalid_graph, or null for any other failure. */
export function issuesOf(e: unknown): GraphIssue[] | null {
  if (e instanceof ApiError && e.status === 422 && Array.isArray(e.data?.errors)) return e.data!.errors as GraphIssue[]
  return null
}

const CODE_TEXT: Record<string, string> = {
  rate_limited: 'Too many changes in a minute. Wait a few seconds and try again.',
  name_taken: 'Another flow already has that name.',
  not_cancellable: 'This run has already finished, so it cannot be cancelled.',
  dry_run_timeout: 'The test took too long and was stopped. Simplify the flow or try again.',
  not_active: 'This flow is not active, so there is nothing to pause.',
  payload_too_large: 'This flow is too large to save. Remove some steps or shorten their text.',
  flow_archived: 'This flow was archived.',
  flow_changed: 'The flow changed while you were working. Review it and try again.',
}
/** Plain words for the flow API's coded errors; a bare code never reaches the screen. */
export function flowErrorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 400 && e.data?.field === 'id') return 'That flow id is not valid. Go back to the list and open the flow again.'
    const code = typeof e.data?.error === 'string' ? e.data.error : e.message
    if (CODE_TEXT[code]) return CODE_TEXT[code]!
    if (e.status === 429) return CODE_TEXT.rate_limited!
    if (e.status === 413) return CODE_TEXT.payload_too_large!
    if (e.status === 504) return CODE_TEXT.dry_run_timeout!
    if (/^[a-z0-9_]+$/.test(e.message)) return 'Something went wrong. Try again.'
    return e.message
  }
  const m = (e as Error)?.message
  return m && !/^[a-z0-9_]+$/.test(m) ? m : 'Something went wrong. Try again.'
}
export const isRateLimited = (e: unknown): boolean => e instanceof ApiError && e.status === 429
