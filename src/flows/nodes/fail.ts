import { hasPort } from '../graph'
import type { ExecResult, FlowServices } from '../executor'
import type { FlowNode } from '../types'

/**
 * A send-type node that could not do its job. If the author connected the node's `error` port (or, for a message
 * refused by the 24 h window, `window_closed`), the run goes there with the reason in the node's output. With no port
 * connected the run fails: a thrown Error becomes the run's `error` and a failed trace row (the step's writes roll back).
 * `code` is stable ('window_closed', 'ai_not_configured', ...); `message` is for people.
 */
export function failOrRoute(svc: FlowServices, node: FlowNode, code: string, message: string, port: 'error' | 'window_closed' = 'error', extra: Record<string, unknown> = {}): ExecResult {
  if (hasPort(svc.graph, node.id, port)) return { port, status: 'failed', output: { ok: false, error: code, message, ...extra }, note: `${code}: ${message}`.slice(0, 200) }
  throw new Error(`${code}: ${message}`)
}

/** `{{path}}` templated, trimmed list of strings from node data (a non-array or non-strings give an empty list). */
export const templated = (v: unknown, render: (s: string) => string): string[] => (Array.isArray(v) ? v.map((x) => render(typeof x === 'string' ? x : x == null ? '' : String(x))) : [])

/** `__`-prefixed names are the engine's own; same rule as the variable node. */
export const SAFE_VAR = /^(?!__)(?!constructor$)(?!prototype$)[\w-]{1,60}$/
