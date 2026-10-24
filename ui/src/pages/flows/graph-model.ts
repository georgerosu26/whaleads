// Pure editor model: the graph <-> API contract, edits as immutable updates, and the undo/redo stack. No React.
import { LIMITS, NODE_TYPES, OUTPUT_PORTS } from '../../../../src/flows/types'
import type { FlowConnection, FlowData, FlowNode, GraphIssue, NodeType } from '../../lib/flows'
import { NODE_W, createNode, inputPort, nodeHeight, outputsOf, portsFor } from './flow-types'

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)

/** API graph -> editor graph. Missing geometry and ports are rebuilt from the node type; unknown fields are kept. */
export function deserialize(raw: unknown): FlowData {
  const g = (raw && typeof raw === 'object' ? raw : {}) as Partial<FlowData>
  const nodes = (Array.isArray(g.nodes) ? g.nodes : []).filter((n): n is FlowNode => !!n && typeof n.id === 'string').map((n) => {
    const known = (NODE_TYPES as readonly string[]).includes(n.type)
    const ports = Array.isArray(n.ports) && n.ports.length ? n.ports : known ? portsFor(n.type) : []
    const out: FlowNode = {
      ...n, label: typeof n.label === 'string' && n.label ? n.label : String(n.type), x: num(n.x, 0), y: num(n.y, 0),
      width: num(n.width, NODE_W), height: 0, data: n.data && typeof n.data === 'object' ? { ...n.data } : {}, ports,
    }
    out.height = nodeHeight(out)
    return out
  })
  const connections = (Array.isArray(g.connections) ? g.connections : []).filter((c): c is FlowConnection => !!c && typeof c.fromNodeId === 'string' && typeof c.toNodeId === 'string')
    .map((c) => ({ id: String(c.id ?? `${c.fromNodeId}:${c.fromPortId}`), fromNodeId: c.fromNodeId, fromPortId: String(c.fromPortId ?? 'out'), toNodeId: c.toNodeId, toPortId: String(c.toPortId ?? 'in') }))
  const ids = g.next_ids && typeof g.next_ids === 'object' ? Object.fromEntries(Object.entries(g.next_ids).filter(([, v]) => Number.isInteger(v) && v > 0)) : undefined
  return ids && Object.keys(ids).length ? { nodes, connections, next_ids: ids } : { nodes, connections }
}

/** Editor graph -> API body: whole-pixel positions, derived heights, only the fields the contract names. */
export function serialize(g: FlowData): FlowData {
  return {
    nodes: g.nodes.map((n) => ({
      id: n.id, type: n.type, label: n.label, x: Math.round(n.x), y: Math.round(n.y), width: Math.round(n.width), height: nodeHeight(n),
      data: n.data, ports: n.ports.map((p) => ({ id: p.id, label: p.label, type: p.type })),
    })),
    connections: g.connections.map((c) => ({ id: c.id, fromNodeId: c.fromNodeId, fromPortId: c.fromPortId, toNodeId: c.toNodeId, toPortId: c.toPortId })),
    ...(g.next_ids && Object.keys(g.next_ids).length ? { next_ids: g.next_ids } : {}),
  }
}

export const sameGraph = (a: FlowData, b: FlowData) => JSON.stringify(serialize(a)) === JSON.stringify(serialize(b))
export const graphBytes = (g: FlowData) => JSON.stringify(serialize(g)).length

// ---- edits ------------------------------------------------------------------------------------------------------

export const SNAP = 10
export const snap = (v: number) => Math.round(v / SNAP) * SNAP

export function addNode(g: FlowData, type: NodeType, x: number, y: number): { graph: FlowData; id: string } | null {
  if (type === 'trigger' || g.nodes.length >= LIMITS.MAX_NODES) return null
  const n = createNode(type, g.nodes, snap(x), snap(y), g.next_ids?.[type] ?? 1)
  const used = Number(n.id.slice(type.length + 1)) // ids are `${type}_${n}`; the counter only moves forward, so a deleted id is never reused
  return { graph: { ...g, nodes: [...g.nodes, n], next_ids: { ...g.next_ids, [type]: used + 1 } }, id: n.id }
}

/** Nearest spot to (x, y) where a new card (w x h) overlaps no existing card: first as asked, then to the right of the
 *  right-most card, then stepped down in rows. Keeps a 30 px gap so ports stay reachable. */
export function freeSpot(nodes: FlowNode[], x: number, y: number, w: number, h: number): { x: number; y: number } {
  const GAP = 30
  const hit = (px: number, py: number) => nodes.some((n) => px < n.x + n.width + GAP && n.x < px + w + GAP && py < n.y + n.height + GAP && n.y < py + h + GAP)
  if (!hit(x, y)) return { x, y }
  const right = snap(Math.max(...nodes.map((n) => n.x + n.width)) + 80)
  for (let row = 0; row < 50; row++) {
    const py = y + row * snap(h + GAP)
    if (!hit(right, py)) return { x: right, y: py }
  }
  return { x: right, y: snap(Math.max(...nodes.map((n) => n.y + n.height)) + 60) }
}

export const moveNodes = (g: FlowData, ids: string[], dx: number, dy: number): FlowData =>
  ({ ...g, nodes: g.nodes.map((n) => (ids.includes(n.id) ? { ...n, x: n.x + dx, y: n.y + dy } : n)) })

export const setPositions = (g: FlowData, pos: Record<string, { x: number; y: number }>): FlowData =>
  ({ ...g, nodes: g.nodes.map((n) => (pos[n.id] ? { ...n, x: snap(pos[n.id]!.x), y: snap(pos[n.id]!.y) } : n)) })

export const setNodeData = (g: FlowData, id: string, data: Record<string, unknown>): FlowData =>
  ({ ...g, nodes: g.nodes.map((n) => (n.id === id ? { ...n, data } : n)) })

export const setNodeLabel = (g: FlowData, id: string, label: string): FlowData =>
  ({ ...g, nodes: g.nodes.map((n) => (n.id === id ? { ...n, label } : n)) })

/** The trigger is never deleted. Connections touching a deleted node go with it. */
export function deleteNodes(g: FlowData, ids: string[]): FlowData {
  const kill = new Set(ids.filter((id) => g.nodes.find((n) => n.id === id)?.type !== 'trigger'))
  if (!kill.size) return g
  return { ...g, nodes: g.nodes.filter((n) => !kill.has(n.id)), connections: g.connections.filter((c) => !kill.has(c.fromNodeId) && !kill.has(c.toNodeId)) }
}

export const deleteConnection = (g: FlowData, id: string): FlowData => ({ ...g, connections: g.connections.filter((c) => c.id !== id) })

export type ConnectResult = { graph: FlowData; moved?: string } | { error: string }
/** One connection per output port (connecting again moves it). No self-loops, nothing into the trigger. */
export function connect(g: FlowData, fromNodeId: string, fromPortId: string, toNodeId: string): ConnectResult {
  const from = g.nodes.find((n) => n.id === fromNodeId)
  const to = g.nodes.find((n) => n.id === toNodeId)
  if (!from || !to) return { error: 'That node no longer exists.' }
  if (from.id === to.id) return { error: 'A node cannot connect to itself.' }
  if (to.type === 'trigger') return { error: 'Nothing connects into the trigger.' }
  if (!OUTPUT_PORTS[from.type]?.includes(fromPortId)) return { error: `${from.label} has no "${fromPortId}" port.` }
  const old = g.connections.find((c) => c.fromNodeId === fromNodeId && c.fromPortId === fromPortId && c.toNodeId !== toNodeId)
  const oldTo = old ? g.nodes.find((n) => n.id === old.toNodeId) : undefined
  const moved = old ? `That output already led to ${oldTo?.label ?? 'another step'}. It now goes to ${to.label}.` : undefined
  const kept = g.connections.filter((c) => !(c.fromNodeId === fromNodeId && c.fromPortId === fromPortId))
  let id = `${fromNodeId}:${fromPortId}`
  for (let i = 2; kept.some((c) => c.id === id); i++) id = `${fromNodeId}:${fromPortId}:${i}`
  return { graph: { ...g, connections: [...kept, { id, fromNodeId, fromPortId, toNodeId, toPortId: inputPort().id }] }, ...(moved ? { moved } : {}) }
}

export const hasHardErrors = (issues: GraphIssue[]) => issues.length > 0
export function issuesByNode(issues: GraphIssue[]): Map<string, string[]> {
  const m = new Map<string, string[]>()
  for (const i of issues) if (i.node) m.set(i.node, [...(m.get(i.node) ?? []), i.msg])
  return m
}
export const looseOutputs = (g: FlowData, id: string) => {
  const n = g.nodes.find((x) => x.id === id)
  return n ? outputsOf(n).filter((p) => !g.connections.some((c) => c.fromNodeId === id && c.fromPortId === p.id)) : []
}

// ---- history ----------------------------------------------------------------------------------------------------

export const HISTORY_LIMIT = 50
export interface History<T> { past: T[]; present: T; future: T[]; key: string | null }
export const createHistory = <T,>(present: T): History<T> => ({ past: [], present, future: [], key: null })

/**
 * Records `next` as the new present. Edits sharing a `key` (typing in one field, dragging one node) fold into one undo
 * step. At most HISTORY_LIMIT steps are kept; the oldest fall off.
 */
export function pushHistory<T>(h: History<T>, next: T, key: string | null = null): History<T> {
  if (Object.is(next, h.present)) return h
  if (key !== null && key === h.key) return { ...h, present: next, future: [] }
  return { past: [...h.past, h.present].slice(-HISTORY_LIMIT), present: next, future: [], key }
}
export function undo<T>(h: History<T>): History<T> {
  if (!h.past.length) return h
  return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1]!, future: [h.present, ...h.future], key: null }
}
export function redo<T>(h: History<T>): History<T> {
  if (!h.future.length) return h
  return { past: [...h.past, h.present].slice(-HISTORY_LIMIT), present: h.future[0]!, future: h.future.slice(1), key: null }
}
export const canUndo = (h: History<unknown>) => h.past.length > 0
export const canRedo = (h: History<unknown>) => h.future.length > 0
/** A history break: the next edit starts a new step even if it shares the previous key (e.g. after blur or drag end). */
export const breakHistory = <T,>(h: History<T>): History<T> => (h.key === null ? h : { ...h, key: null })
