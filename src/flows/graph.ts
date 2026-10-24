// Pure graph helpers and server-side validation (used on publish, and as a guard before a run starts).
import type { FlowData, FlowNode, NodePort, TriggerKind } from './types'
import { durationError } from './nodes/time'
import { compileSafeRegex } from './regex'
import { LIMITS, NODE_TYPES, OUTPUT_PORTS, TRIGGER_KINDS } from './types'

export function findNextNode(flow: FlowData, fromNodeId: string, portId: NodePort): string | null {
  const c = flow.connections.find((x) => x.fromNodeId === fromNodeId && x.fromPortId === portId)
  return c ? c.toNodeId : null
}

export const getNode = (flow: FlowData, id: string): FlowNode | null => flow.nodes.find((n) => n.id === id) ?? null
export const findTriggerNode = (flow: FlowData): FlowNode | null => flow.nodes.find((n) => n.type === 'trigger') ?? null
export const hasPort = (flow: FlowData, nodeId: string, port: string) => flow.connections.some((c) => c.fromNodeId === nodeId && c.fromPortId === port)

/** Parses a persisted graph; null when it is not a {nodes[], connections[]} object. */
export function parseGraph(text: string | null | undefined): FlowData | null {
  if (!text) return null
  try {
    const g = JSON.parse(text) as FlowData
    return g && Array.isArray(g.nodes) && Array.isArray(g.connections) ? g : null
  } catch { return null }
}

export const triggerKindOf = (g: FlowData): TriggerKind | null => {
  const k = findTriggerNode(g)?.data?.kind
  return typeof k === 'string' && (TRIGGER_KINDS as readonly string[]).includes(k) ? (k as TriggerKind) : null
}

/** `soft` errors are incompleteness a draft may carry (no trigger yet, a loose node); the rest make the graph unstorable. Publish rejects both. */
export interface GraphError { node: string | null; msg: string; soft?: true }

/**
 * Rules: one trigger with a known kind; ids unique; node types and connection ports known; every connection endpoint
 * exists; every node reachable from the trigger; a cycle must pass through a delay or wait_event (otherwise it spins
 * until the node cap); message/template text present; limits on size.
 */
export function validateGraph(g: unknown): GraphError[] {
  const errs: GraphError[] = []
  const push = (node: string | null, msg: string, soft = false) => { errs.push(soft ? { node, msg, soft: true } : { node, msg }) }
  if (!g || typeof g !== 'object' || !Array.isArray((g as FlowData).nodes) || !Array.isArray((g as FlowData).connections)) return [{ node: null, msg: 'graph must be {nodes[], connections[]}' }]
  const flow = g as FlowData
  if (flow.nodes.length > LIMITS.MAX_NODES) push(null, `a flow has at most ${LIMITS.MAX_NODES} nodes`)
  if (JSON.stringify(flow).length > LIMITS.MAX_GRAPH_BYTES) push(null, `a flow is at most ${LIMITS.MAX_GRAPH_BYTES / 1024} KB`)
  const ids = new Set<string>()
  for (const n of flow.nodes) {
    if (!n || typeof n.id !== 'string' || !n.id) { push(null, 'every node needs an id'); continue }
    if (ids.has(n.id)) push(n.id, 'duplicate node id')
    ids.add(n.id)
    if (!(NODE_TYPES as readonly string[]).includes(n.type)) push(n.id, `unknown node type "${String(n.type)}"`)
  }
  const triggers = flow.nodes.filter((n) => n?.type === 'trigger')
  if (triggers.length !== 1) push(null, triggers.length ? 'a flow has exactly one trigger' : 'a flow needs a trigger', true)
  else if (triggerKindOf(flow) === null) push(triggers[0].id, `trigger kind must be one of ${TRIGGER_KINDS.join(', ')}`, true)

  const adj = new Map<string, string[]>()
  for (const c of flow.connections) {
    if (!ids.has(c.fromNodeId) || !ids.has(c.toNodeId)) { push(null, `connection ${c.id ?? '?'} points at a missing node`); continue }
    const from = flow.nodes.find((n) => n.id === c.fromNodeId)!
    const allowed = OUTPUT_PORTS[from.type]
    if (allowed && !allowed.includes(c.fromPortId)) push(from.id, `${from.type} has no "${c.fromPortId}" port`)
    if (flow.nodes.find((n) => n.id === c.toNodeId)!.type === 'trigger') push(c.toNodeId, 'nothing connects into the trigger')
    ;(adj.get(c.fromNodeId) ?? adj.set(c.fromNodeId, []).get(c.fromNodeId)!).push(c.toNodeId)
  }
  // one connection per (node, port): the engine follows the first
  const seen = new Set<string>()
  for (const c of flow.connections) {
    const k = `${c.fromNodeId}:${c.fromPortId}`
    if (seen.has(k)) push(c.fromNodeId, `port "${c.fromPortId}" is connected twice`)
    seen.add(k)
  }
  for (const n of flow.nodes) {
    const d = n.data ?? {}
    if ((n.type === 'message' && !String(d.text ?? '').trim()) || (n.type === 'template' && !String(d.templateId ?? d.templateName ?? '').trim())) {
      push(n.id, n.type === 'message' ? 'message text is empty' : 'pick a template', true)
    }
  }
  for (const t of triggers) {
    const d = (t.data ?? {}) as Record<string, unknown>
    for (const k of ['sources', 'stages', 'keywords', 'from', 'to']) {
      if (d[k] !== undefined && (!Array.isArray(d[k]) || (d[k] as unknown[]).length > 50 || (d[k] as unknown[]).some((x) => typeof x !== 'string' || x.length > 100))) push(t.id, `trigger ${k} must be a list of up to 50 short texts`, true)
    }
    if (d.match !== undefined && d.match !== 'any' && d.match !== 'keyword' && d.match !== 'regex') push(t.id, 'trigger match must be any, keyword or regex', true)
    if (d.match === 'keyword' && !(Array.isArray(d.keywords) && d.keywords.some((x) => typeof x === 'string' && x.trim()))) push(t.id, 'add at least one keyword', true)
    if (d.match === 'regex') { const c = compileSafeRegex(d.regexPattern); if (!c.ok) push(t.id, `regex: ${c.reason}`, true) }
  }
  for (const n of flow.nodes) {
    const bad = durationError(n.type, (n.data ?? {}) as Record<string, unknown>)
    if (bad) push(n.id, bad)
  }
  // reachability + cycles
  if (triggers.length === 1) {
    const reach = new Set<string>()
    const stack = [triggers[0].id]
    while (stack.length) { const id = stack.pop()!; if (reach.has(id)) continue; reach.add(id); for (const t of adj.get(id) ?? []) stack.push(t) }
    for (const n of flow.nodes) if (!reach.has(n.id)) push(n.id, 'not connected to the trigger', true)
    // A cycle that avoids every delay/wait_event node: DFS over the graph with those nodes removed.
    const pause = new Set(flow.nodes.filter((n) => n.type === 'delay' || n.type === 'wait_event').map((n) => n.id))
    const color = new Map<string, number>()
    const dfs = (id: string): boolean => {
      color.set(id, 1)
      for (const t of adj.get(id) ?? []) {
        if (pause.has(t)) continue
        const c = color.get(t) ?? 0
        if (c === 1 || (c === 0 && dfs(t))) return true
      }
      color.set(id, 2)
      return false
    }
    for (const id of reach) if (!pause.has(id) && !color.get(id) && dfs(id)) { push(id, 'a loop must pass through a Delay or Wait for reply', true); break }
  }
  return errs
}
