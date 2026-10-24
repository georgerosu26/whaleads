// The flow canvas: hand-rolled (no xyflow). World space is the graph's own x/y; the view is a pan + zoom
// transform on one inner layer. Interaction: drag the background to pan, ctrl/cmd+wheel (or pinch) to zoom, drag a card
// by its header/body to move it (10 px snap), drag from an output dot to an input dot (or onto a card) to connect,
// click a card or a line to select. Delete/undo live in the editor.
import { Maximize2, Minus, Plus } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { FlowData, GraphIssue, NodeType } from '@/lib/flows'
import { connect, deleteConnection, issuesByNode, looseOutputs, setPositions, snap } from '../graph-model'
import { NODE_W, portPos } from '../flow-types'
import { CanvasNode, type TraceTone } from './CanvasNode'

export interface Selection { node: string | null; conn: string | null }
export const NODE_DRAG_MIME = 'application/x-whaleads-node'
interface View { x: number; y: number; z: number }
const MIN_Z = 0.4, MAX_Z = 1.5

type Drag =
  | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number }
  | { kind: 'node'; id: string; sx: number; sy: number; ox: number; oy: number; moved: boolean }
  | { kind: 'link'; from: string; port: string }

export function bezier(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const dx = Math.max(40, Math.abs(b.x - a.x) / 2)
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`
}
const inPos = (n: { x: number; y: number }) => ({ x: n.x, y: n.y + 18 })

interface Props {
  graph: FlowData
  selection: Selection
  onSelect: (s: Selection) => void
  onChange: (g: FlowData, key: string | null) => void
  onDragEnd: () => void
  onNotice: (msg: string) => void
  onDropNode?: (type: NodeType, x: number, y: number) => void
  errors: GraphIssue[]
  warnings: GraphIssue[]
  trace?: Record<string, TraceTone>
  /** No moving, connecting or deleting (view-only: narrow screens, or a non-admin). */
  readOnly: boolean
  className?: string
}

export function FlowCanvas({ graph, selection, onSelect, onChange, onDragEnd, onNotice, onDropNode, errors, warnings, trace, readOnly, className }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<View>({ x: 40, y: 40, z: 1 })
  const viewRef = useRef(view); viewRef.current = view
  const graphRef = useRef(graph); graphRef.current = graph
  // The parent re-renders on every selection and passes fresh callbacks; the window listeners below must stay the very same
  // functions from pointerdown to pointerup, so they read the callbacks through a ref instead of closing over them.
  const cb = useRef({ onChange, onDragEnd, onNotice }); cb.current = { onChange, onDragEnd, onNotice }
  const drag = useRef<Drag | null>(null)
  const [noodle, setNoodle] = useState<{ from: string; port: string; x: number; y: number } | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const fitted = useRef(false)
  const touched = useRef(false) // the user panned or zoomed: stop re-fitting on resize

  const toWorld = useCallback((cx: number, cy: number) => {
    const r = box.current!.getBoundingClientRect(); const v = viewRef.current
    return { x: (cx - r.left - v.x) / v.z, y: (cy - r.top - v.y) / v.z }
  }, [])

  const fit = useCallback(() => {
    touched.current = false
    const el = box.current; const g = graphRef.current
    if (!el || !g.nodes.length) return
    const minX = Math.min(...g.nodes.map((n) => n.x)), minY = Math.min(...g.nodes.map((n) => n.y))
    const maxX = Math.max(...g.nodes.map((n) => n.x + n.width)), maxY = Math.max(...g.nodes.map((n) => n.y + n.height))
    const w = el.clientWidth, h = el.clientHeight; if (!w || !h) return
    const pad = 40
    const z = Math.min(1, Math.max(MIN_Z, Math.min((w - pad * 2) / (maxX - minX), (h - pad * 2) / (maxY - minY))))
    // Small flows sit at the top left, where steps are added; only a flow wider than the box is centred.
    const fits = (maxX - minX) * z <= w - pad * 2
    setView({ z, x: fits ? pad - minX * z : (w - (maxX - minX) * z) / 2 - minX * z, y: Math.max(pad / 2, (h - (maxY - minY) * z) / 2 - 0) - minY * z })
  }, [])
  // Adding or removing a step re-fits, so a new step is never off-screen behind the side panel.
  const nodeCount = graph.nodes.length
  const prevCount = useRef(nodeCount)
  useEffect(() => { if (prevCount.current !== nodeCount) { prevCount.current = nodeCount; fit() } }, [nodeCount, fit])
  useLayoutEffect(() => { if (!fitted.current && box.current?.clientWidth) { fitted.current = true; fit() } }, [fit, graph.nodes.length])
  useEffect(() => {
    const el = box.current; if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => { if (el.clientWidth && (!fitted.current || !touched.current)) { fitted.current = true; fit() } })
    ro.observe(el); return () => ro.disconnect()
  }, [fit])

  const zoomAt = useCallback((cx: number, cy: number, factor: number) => {
    const el = box.current; if (!el) return
    const r = el.getBoundingClientRect(); const v = viewRef.current
    const z = Math.min(MAX_Z, Math.max(MIN_Z, v.z * factor)); if (z === v.z) return
    const px = cx - r.left, py = cy - r.top
    touched.current = true
    setView({ z, x: px - ((px - v.x) / v.z) * z, y: py - ((py - v.y) / v.z) * z })
  }, [])
  useEffect(() => {
    const el = box.current; if (!el) return
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01))
      else { touched.current = true; setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY })) }
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [zoomAt])

  const move = useCallback((e: PointerEvent) => {
    const d = drag.current; if (!d) return
    if (d.kind === 'pan') { touched.current = true; setView((v) => ({ ...v, x: d.vx + e.clientX - d.sx, y: d.vy + e.clientY - d.sy })); return }
    if (d.kind === 'node') {
      const z = viewRef.current.z
      const dx = (e.clientX - d.sx) / z, dy = (e.clientY - d.sy) / z
      if (!d.moved && Math.hypot(dx, dy) * z < 3) return
      d.moved = true
      cb.current.onChange(setPositions(graphRef.current, { [d.id]: { x: Math.max(0, snap(d.ox + dx)), y: Math.max(0, snap(d.oy + dy)) } }), `drag:${d.id}`)
      return
    }
    const w = toWorld(e.clientX, e.clientY)
    setNoodle({ from: d.from, port: d.port, x: w.x, y: w.y })
    const t = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-node-id]')
    setHover(t && t.dataset.nodeType !== 'trigger' && t.dataset.nodeId !== d.from ? t.dataset.nodeId! : null)
  }, [toWorld])

  const up = useCallback((e: PointerEvent) => {
    const d = drag.current; drag.current = null
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up)
    if (!d) return
    if (d.kind === 'node') { if (d.moved) cb.current.onDragEnd(); return }
    if (d.kind === 'link') {
      setNoodle(null); setHover(null)
      const t = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-node-id]')
      const to = t?.dataset.nodeId
      if (!to) return
      const r = connect(graphRef.current, d.from, d.port, to)
      if ('error' in r) cb.current.onNotice(r.error); else { cb.current.onChange(r.graph, null); if (r.moved) cb.current.onNotice(r.moved) }
    }
  }, [move])
  useEffect(() => () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }, [move, up])

  const begin = (d: Drag) => { drag.current = d; window.addEventListener('pointermove', move); window.addEventListener('pointerup', up) }

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    box.current?.focus({ preventScroll: true })
    const t = e.target as HTMLElement
    const out = t.closest<HTMLElement>('[data-port-out]')
    if (out) {
      e.stopPropagation()
      if (readOnly) return
      const [from, port] = out.dataset.portOut!.split(':') as [string, string]
      const w = toWorld(e.clientX, e.clientY)
      setNoodle({ from, port, x: w.x, y: w.y }); begin({ kind: 'link', from, port }); return
    }
    const nodeEl = t.closest<HTMLElement>('[data-node-id]')
    if (nodeEl) {
      const id = nodeEl.dataset.nodeId!
      onSelect({ node: id, conn: null })
      const n = graphRef.current.nodes.find((x) => x.id === id)
      if (n && !readOnly) begin({ kind: 'node', id, sx: e.clientX, sy: e.clientY, ox: n.x, oy: n.y, moved: false })
      return
    }
    const conn = t.closest<HTMLElement>('[data-conn]')
    if (conn) { onSelect({ node: null, conn: conn.dataset.conn! }); return }
    onSelect({ node: null, conn: null })
    begin({ kind: 'pan', sx: e.clientX, sy: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y })
  }

  const errMap = useMemo(() => issuesByNode(errors), [errors])
  const warnMap = useMemo(() => issuesByNode(warnings), [warnings])
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph.nodes])

  const lines = graph.connections.map((c) => {
    const a = byId.get(c.fromNodeId), b = byId.get(c.toNodeId)
    const p = a?.ports.find((x) => x.id === c.fromPortId)
    if (!a || !b || !p) return null
    const from = portPos(a, p), to = inPos(b)
    return { c, from, to, d: bezier(from, to), mid: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 } }
  })
  const fromNode = noodle ? byId.get(noodle.from) : undefined
  const fromPort = fromNode?.ports.find((p) => p.id === noodle?.port)

  return (
    <div
      ref={box}
      tabIndex={0}
      role="application"
      aria-label="Flow canvas"
      data-testid="flow-canvas"
      className={`relative min-h-0 touch-none overflow-hidden bg-background outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent ${className ?? ''}`}
      style={{ backgroundImage: 'radial-gradient(circle, hsl(var(--border)) 1px, transparent 1px)', backgroundSize: `${20 * view.z}px ${20 * view.z}px`, backgroundPosition: `${view.x}px ${view.y}px` }}
      onPointerDown={onPointerDown}
      onDragOver={(e) => { if (onDropNode && e.dataTransfer.types.includes(NODE_DRAG_MIME)) e.preventDefault() }}
      onDrop={(e) => {
        const type = e.dataTransfer.getData(NODE_DRAG_MIME) as NodeType
        if (!onDropNode || !type) return
        e.preventDefault(); const w = toWorld(e.clientX, e.clientY)
        onDropNode(type, Math.max(0, snap(w.x - NODE_W / 2)), Math.max(0, snap(w.y - 20)))
      }}
    >
      <div className="absolute left-0 top-0 origin-top-left" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}>
        <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width={1} height={1} aria-hidden>
          {lines.map((l) => l && (
            <g key={l.c.id}>
              <path d={l.d} fill="none" stroke="hsl(var(--border))" strokeWidth={selection.conn === l.c.id ? 5 : 3} className={selection.conn === l.c.id ? 'opacity-0' : ''} />
              <path d={l.d} fill="none" stroke={selection.conn === l.c.id ? 'hsl(var(--accent))' : 'hsl(var(--muted-foreground))'} strokeWidth={selection.conn === l.c.id ? 2.5 : 1.75} />
              <path d={l.d} data-conn={l.c.id} fill="none" stroke="transparent" strokeWidth={16} style={{ pointerEvents: 'stroke', cursor: 'pointer' }} />
            </g>
          ))}
          {noodle && fromNode && fromPort && <path d={bezier(portPos(fromNode, fromPort), { x: noodle.x, y: noodle.y })} fill="none" stroke="hsl(var(--accent))" strokeWidth={2} strokeDasharray="6 4" />}
        </svg>
        {graph.nodes.map((n) => (
          <CanvasNode
            key={n.id}
            node={n}
            selected={selection.node === n.id}
            errors={errMap.get(n.id) ?? []}
            warnings={warnMap.get(n.id) ?? []}
            loose={looseOutputs(graph, n.id).map((p) => p.id)}
            dropTarget={hover === n.id}
            trace={trace?.[n.id]}
            readOnly={readOnly}
          />
        ))}
        {!readOnly && selection.conn && lines.map((l) => l && l.c.id === selection.conn && (
          <button
            key="del"
            type="button"
            aria-label="Delete connection"
            data-testid="delete-connection"
            className="absolute flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border bg-surface text-danger shadow hover:bg-muted"
            style={{ left: l.mid.x, top: l.mid.y }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => { onChange(deleteConnection(graphRef.current, l.c.id), null); onSelect({ node: null, conn: null }) }}
          ><Minus aria-hidden className="h-4 w-4" /></button>
        ))}
      </div>
      <div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-lg border bg-surface p-1 shadow-sm" onPointerDown={(e) => e.stopPropagation()}>
        <button type="button" aria-label="Zoom out" className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted" onClick={() => { const r = box.current!.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 0.8) }}><Minus aria-hidden className="h-4 w-4" /></button>
        <span className="w-10 text-center text-xs text-muted-foreground" data-testid="zoom-level">{Math.round(view.z * 100)}%</span>
        <button type="button" aria-label="Zoom in" className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted" onClick={() => { const r = box.current!.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.25) }}><Plus aria-hidden className="h-4 w-4" /></button>
        <button type="button" aria-label="Fit to screen" className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted" onClick={fit}><Maximize2 aria-hidden className="h-4 w-4" /></button>
      </div>
    </div>
  )
}
