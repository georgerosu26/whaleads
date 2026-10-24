// The flow editor. State: server meta + an undo history of the graph. Saving is single-flight: every flush reads the
// latest state at the moment it runs, so a debounce firing during a save, or Publish during an edit, can never send
// stale data or race itself. Publish flushes first and locks editing until it settles.
import { ArrowLeft, FlaskConical, Pause, Play, Redo2, Undo2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ErrorState } from '@/components/ErrorState'
import { Modal } from '@/components/leads/Modal'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api, ApiError } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useMeta } from '@/lib/crm'
import { flowErrorText, flowsApi, isRateLimited, issuesOf, type DryRunResult, type FlowData, type FlowDetail, type GraphIssue, type NodeType } from '@/lib/flows'
import { useLiveEvents } from '@/lib/live'
import { validateGraph } from '../../../../src/flows/graph'
import { FlowCanvas, type Selection } from './canvas/FlowCanvas'
import type { TraceTone } from './canvas/CanvasNode'
import { FLOW_VARIABLES, NODE_META, createNode } from './flow-types'
import { STATUS_LABEL, STATUS_TONE } from './FlowsList'
import {
  addNode, breakHistory, freeSpot, snap, canRedo, canUndo, createHistory, deleteConnection, deleteNodes, deserialize, issuesByNode, pushHistory, redo, sameGraph,
  serialize, setNodeData, setNodeLabel, undo, type History,
} from './graph-model'
import { NodeInspector } from './NodeInspector'
import { NodePalette } from './NodePalette'
import { RunsTab } from './RunsTab'
import { TestPanel } from './TestPanel'

type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'blocked'
const SAVE_LABEL: Record<SaveState, string> = { saved: 'Saved', dirty: 'Unsaved changes', saving: 'Saving', error: 'Could not save', blocked: 'Fix the errors to save' }
const AUTOSAVE_MS = 800
const draftKey = (id: number) => `wl:flow-draft:${id}`
interface Draft { base: number; graph: FlowData; name: string; shadow: boolean }
function readDraft(id: number, base: number): Draft | null {
  try {
    const d = JSON.parse(sessionStorage.getItem(draftKey(id)) ?? 'null') as Draft | null
    return d && d.base === base && d.graph && Array.isArray(d.graph.nodes) ? d : null
  } catch { return null }
}
const clearDraft = (id: number) => { try { sessionStorage.removeItem(draftKey(id)) } catch { /* private mode: nothing to clear */ } }

function useNarrow() {
  const q = '(max-width: 767px)'
  const [n, setN] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches)
  useEffect(() => { const m = window.matchMedia(q); const f = () => setN(m.matches); m.addEventListener('change', f); return () => m.removeEventListener('change', f) }, [])
  return n
}

const split = (list: { node: string | null; msg: string; soft?: true }[]) => ({
  errors: list.filter((i) => !i.soft).map(({ node, msg }): GraphIssue => ({ node, msg })),
  warnings: list.filter((i) => i.soft).map(({ node, msg }): GraphIssue => ({ node, msg })),
})

export default function FlowEditor() {
  const id = Number(useParams().id)
  const [flow, setFlow] = useState<FlowDetail | null>(null)
  const [loadErr, setLoadErr] = useState('')
  const load = useCallback(async () => {
    setLoadErr('')
    try { setFlow((await flowsApi.get(id)).flow) } catch (e) { setLoadErr(e instanceof ApiError && e.status === 404 ? 'This flow does not exist.' : flowErrorText(e)) }
  }, [id])
  useEffect(() => { setFlow(null); void load() }, [load])
  if (!Number.isFinite(id)) return <div className="p-6"><ErrorState message="This flow does not exist." onRetry={() => undefined} /></div>
  if (loadErr) return <div className="mx-auto max-w-md p-6"><ErrorState message={loadErr} onRetry={() => void load()} /></div>
  if (!flow) {
    return (
      <div className="flex h-full flex-col" aria-busy="true" aria-label="Loading flow">
        <div className="flex items-center gap-3 border-b bg-surface p-3"><Skeleton className="h-8 w-48" /><Skeleton className="ml-auto h-9 w-24" /></div>
        <div className="flex flex-1"><Skeleton className="m-3 hidden h-64 w-52 md:block" /><Skeleton className="m-3 flex-1" /></div>
      </div>
    )
  }
  return <Editor key={`${flow.id}:${flow.updated_at}`} initial={flow} reload={load} />
}

function Editor({ initial, reload }: { initial: FlowDetail; reload: () => Promise<void> }) {
  const { state } = useAuth()
  const isAdmin = state.status === 'in' && state.me.staff.role === 'admin'
  const narrow = useNarrow()
  const meta = useMeta()
  const [info, setInfo] = useState(initial)
  // A draft the editor could not save (blocking errors) when it was left; restored if the server copy is unchanged since.
  const draft = useRef<Draft | null | undefined>(undefined)
  if (draft.current === undefined) draft.current = readDraft(initial.id, initial.updated_at)
  const [hist, setHist] = useState<History<FlowData>>(() => createHistory(deserialize(draft.current?.graph ?? initial.graph)))
  const [name, setName] = useState(draft.current?.name ?? initial.name)
  const [shadow, setShadow] = useState(draft.current?.shadow ?? initial.shadow)
  const [sel, setSel] = useState<Selection>({ node: null, conn: null })
  const [tab, setTab] = useState<'canvas' | 'runs'>('canvas')
  const [testOpen, setTestOpen] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [saveErr, setSaveErr] = useState('')
  const [serverIssues, setServerIssues] = useState<GraphIssue[]>([])
  const [notice, setNotice] = useState(() => (draft.current ? 'Restored your unsaved draft. It still has errors to fix before it can save.' : ''))
  const [publishing, setPublishing] = useState(false)
  const [pubDlg, setPubDlg] = useState<null | { phase: 'checking' } | { phase: 'failed'; errors: GraphIssue[]; message?: string } | { phase: 'done'; warnings: GraphIssue[] }>(null)
  const [aiConfigured, setAiConfigured] = useState<boolean | null>(null)
  const [dry, setDry] = useState<DryRunResult | null>(null)

  const graph = hist.present
  const histRef = useRef(hist); histRef.current = hist
  const nameRef = useRef(name); nameRef.current = name
  const shadowRef = useRef(shadow); shadowRef.current = shadow
  const infoRef = useRef(info); infoRef.current = info
  // What the server holds, so a flush knows what changed.
  const saved = useRef({ graph: deserialize(initial.graph), name: initial.name, shadow: initial.shadow })
  const chain = useRef<Promise<boolean>>(Promise.resolve(true))
  const mounted = useRef(true)
  const skipUnmountFlush = useRef(false)

  const dirty = !sameGraph(graph, saved.current.graph) || name.trim() !== saved.current.name || shadow !== saved.current.shadow
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty

  const local = useMemo(() => split(validateGraph(serialize(graph))), [graph])
  const blockingRef = useRef(false); blockingRef.current = local.errors.length > 0
  const errors = useMemo(() => [...local.errors, ...serverIssues], [local.errors, serverIssues])
  const generalErrors = useMemo(() => [...new Set(errors.filter((i) => !i.node).map((i) => i.msg))], [errors])
  const errMap = useMemo(() => issuesByNode(errors), [errors])
  const warnMap = useMemo(() => issuesByNode(local.warnings), [local.warnings])
  const labelOf = useCallback((nid: string) => graph.nodes.find((n) => n.id === nid)?.label ?? nid, [graph.nodes])

  const doSave = useCallback(async (): Promise<boolean> => {
    const g = histRef.current.present
    const n = nameRef.current.trim()
    const s = shadowRef.current
    const body: { name?: string; shadow?: boolean; graph?: FlowData } = {}
    if (!sameGraph(g, saved.current.graph)) body.graph = serialize(g)
    if (n && n !== saved.current.name) body.name = n
    if (s !== saved.current.shadow) body.shadow = s
    if (!Object.keys(body).length) { if (mounted.current) setSaveState('saved'); return true }
    if (body.graph && split(validateGraph(body.graph)).errors.length) { if (mounted.current) setSaveState('blocked'); return false }
    if (mounted.current) { setSaveState('saving'); setSaveErr('') }
    try {
      const r = await flowsApi.save(infoRef.current.id, body)
      saved.current = { graph: body.graph ? deserialize(body.graph) : saved.current.graph, name: body.name ?? saved.current.name, shadow: body.shadow ?? saved.current.shadow }
      clearDraft(infoRef.current.id)
      if (mounted.current) {
        setInfo((cur) => ({ ...cur, ...r.flow, graph: cur.graph }))
        setServerIssues([])
        // Edits made while this save was in flight are not saved yet.
        setSaveState(dirtyRef.current && (!sameGraph(histRef.current.present, saved.current.graph) || nameRef.current.trim() !== saved.current.name || shadowRef.current !== saved.current.shadow) ? 'dirty' : 'saved')
      }
      return true
    } catch (e) {
      if (!mounted.current) return false
      const list = issuesOf(e)
      if (list) { setServerIssues(list); setSaveState('blocked') }
      else {
        setSaveState('error')
        setSaveErr(flowErrorText(e))
        if (e instanceof ApiError && e.message === 'flow_archived') setInfo((cur) => ({ ...cur, status: 'archived' }))
        // Rate limited: the edits are still local; try again shortly instead of leaving the draft unsaved.
        if (isRateLimited(e)) setTimeout(() => { if (mounted.current) void flush() }, 8000)
      }
      return false
    }
  }, [])
  /** Single-flight: each flush waits for the previous one, then re-reads the latest state. */
  const flush = useCallback((): Promise<boolean> => {
    const p = chain.current.then(doSave, doSave)
    chain.current = p.catch(() => false)
    return p
  }, [doSave])

  // Leaving the editor (in-app navigation) inside the autosave wait must not lose edits: flush on unmount. Edits that
  // cannot save (blocking errors) are kept in sessionStorage and restored on reopen.
  const flushRef = useRef(flush); flushRef.current = flush
  const adminRef = useRef(isAdmin); adminRef.current = isAdmin
  const writeDraft = useCallback(() => {
    try { sessionStorage.setItem(draftKey(infoRef.current.id), JSON.stringify({ base: infoRef.current.updated_at, graph: serialize(histRef.current.present), name: nameRef.current, shadow: shadowRef.current } satisfies Draft)) } catch { /* storage unavailable: the draft is simply lost */ }
  }, [])
  useEffect(() => {
    mounted.current = true
    return () => {
      if (!skipUnmountFlush.current && adminRef.current && infoRef.current.status !== 'archived' && dirtyRef.current) {
        if (blockingRef.current) writeDraft(); else void flushRef.current()
      }
      mounted.current = false
    }
  }, [writeDraft])

  // Autosave (debounced). Skipped while a save already failed for a reason the user must fix.
  useEffect(() => {
    if (!isAdmin || info.status === 'archived' || publishing) return
    if (!dirty) { setSaveState((s) => (s === 'dirty' ? 'saved' : s)); return }
    if (local.errors.length) { setSaveState('blocked'); return }
    setSaveState((s) => (s === 'saving' ? s : 'dirty'))
    const t = setTimeout(() => { void flush() }, AUTOSAVE_MS)
    return () => clearTimeout(t)
  }, [graph, name, shadow, dirty, local.errors.length, isAdmin, info.status, publishing, flush])

  useEffect(() => {
    if (!dirty) return
    const f = (e: BeforeUnloadEvent) => { if (blockingRef.current) writeDraft(); e.preventDefault() }
    window.addEventListener('beforeunload', f)
    return () => window.removeEventListener('beforeunload', f)
  }, [dirty, writeDraft])

  useEffect(() => {
    if (!isAdmin) return
    api<{ settings: { ai?: { configured: boolean } } }>('/api/settings').then((r) => setAiConfigured(!!r.settings.ai?.configured)).catch(() => undefined)
  }, [isAdmin])

  // Another admin published or paused this flow: adopt it when we have nothing unsaved.
  useLiveEvents((s) => {
    if (s.type === 'flow.updated' && s.data?.flow_id === infoRef.current.id) {
      if (publishing) return
      void flowsApi.get(infoRef.current.id).then(({ flow: f }) => {
        if (!mounted.current) return
        setInfo((cur) => ({ ...cur, ...f, graph: cur.graph }))
        if (!dirtyRef.current) {
          const g = deserialize(f.graph)
          if (!sameGraph(g, histRef.current.present)) { saved.current = { graph: g, name: f.name, shadow: f.shadow }; setHist(createHistory(g)); setName(f.name); setShadow(f.shadow); setSel({ node: null, conn: null }); setNotice('Updated by someone else.') }
        }
      }).catch(() => undefined)
    }
  })

  const readOnly = !isAdmin || info.status === 'archived' || publishing
  const canvasReadOnly = readOnly || narrow

  const edit = useCallback((g: FlowData, key: string | null = null) => { if (!readOnly) setHist((h) => pushHistory(h, g, key)) }, [readOnly])
  const doUndo = useCallback(() => { if (readOnly) return; setHist((h) => undo(h)) }, [readOnly])
  const doRedo = useCallback(() => { if (readOnly) return; setHist((h) => redo(h)) }, [readOnly])
  // Drop a selection whose node vanished (undo, delete).
  useEffect(() => {
    if (sel.node && !graph.nodes.some((n) => n.id === sel.node)) setSel((s) => ({ ...s, node: null }))
    if (sel.conn && !graph.connections.some((c) => c.id === sel.conn)) setSel((s) => ({ ...s, conn: null }))
  }, [graph, sel])
  useEffect(() => { if (!notice) return; const t = setTimeout(() => setNotice(''), 4000); return () => clearTimeout(t) }, [notice])

  const addAt = useCallback((type: NodeType, x?: number, y?: number) => {
    if (readOnly) return
    const nodes = graph.nodes
    const anchor = nodes.find((n) => n.id === sel.node) ?? nodes.reduce<typeof nodes[number] | null>((a, n) => (!a || n.x > a.x ? n : a), null)
    const px = x ?? (anchor ? anchor.x + 300 : 80)
    const py = y ?? (anchor ? anchor.y : 80)
    // A new step never lands on top of an existing one (adding twice from the same selected card, or dropping onto a card).
    const probe = createNode(type, nodes, 0, 0)
    const at = freeSpot(nodes, Math.max(0, snap(px)), Math.max(0, snap(py)), probe.width, probe.height)
    const r = addNode(graph, type, at.x, at.y)
    if (!r) { setNotice('This flow has reached the step limit.'); return }
    setHist((h) => pushHistory(breakHistory(h), r.graph))
    setSel({ node: r.id, conn: null })
  }, [graph, readOnly, sel.node])

  const removeSelection = useCallback(() => {
    if (readOnly) return
    if (sel.conn) { setHist((h) => pushHistory(breakHistory(h), deleteConnection(h.present, sel.conn!))); setSel({ node: null, conn: null }); return }
    const n = graph.nodes.find((x) => x.id === sel.node)
    if (n && n.type !== 'trigger') { setHist((h) => pushHistory(breakHistory(h), deleteNodes(h.present, [n.id]))); setSel({ node: null, conn: null }) }
  }, [graph.nodes, readOnly, sel])

  // Keyboard. Ignored while typing or when a dialog is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      const typing = !!t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); if (!readOnly) void flush(); return }
      if (typing || document.querySelector('[role="dialog"]')) return
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); return }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); doRedo(); return }
      if (e.key === 'Delete' || e.key === 'Backspace') { if (sel.node || sel.conn) { e.preventDefault(); removeSelection() } return }
      if (e.key === 'Escape') setSel({ node: null, conn: null })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [doRedo, doUndo, flush, readOnly, removeSelection, sel])

  async function publish() {
    setPublishing(true); setPubDlg({ phase: 'checking' })
    try {
      if (!(await flush())) {
        const list = [...split(validateGraph(serialize(histRef.current.present))).errors, ...serverIssues]
        setPubDlg({ phase: 'failed', errors: list, message: list.length ? undefined : saveErr || 'The draft could not be saved.' })
        return
      }
      try {
        const r = await flowsApi.publish(infoRef.current.id)
        setInfo((cur) => ({ ...cur, ...r.flow, graph: cur.graph }))
        setPubDlg({ phase: 'done', warnings: r.warnings ?? [] })
      } catch (e) {
        const list = issuesOf(e)
        if (list) setPubDlg({ phase: 'failed', errors: list })
        else if (e instanceof ApiError && e.status === 409 && e.message === 'flow_changed') {
          skipUnmountFlush.current = true // the draft we saved was already replaced by someone else's; do not overwrite it on remount
          await reload()
          setPubDlg({ phase: 'failed', errors: [], message: 'The flow changed while publishing. Nothing was published. Review it and try again.' })
        } else setPubDlg({ phase: 'failed', errors: [], message: flowErrorText(e) })
      }
    } finally { setPublishing(false) }
  }
  async function pause() {
    setPublishing(true)
    try { if (!(await flush())) return; const r = await flowsApi.pause(infoRef.current.id); setInfo((cur) => ({ ...cur, ...r.flow, graph: cur.graph })) } catch (e) { setNotice(flowErrorText(e)) } finally { setPublishing(false) }
  }

  const selectedNode = graph.nodes.find((n) => n.id === sel.node) ?? null
  const upstream = useMemo(() => {
    const out: string[] = []
    for (const n of graph.nodes) {
      if (n.type === 'variable' && typeof n.data.variableName === 'string' && n.data.variableName) out.push(n.data.variableName)
      if (n.type === 'ai') out.push(`${n.id}.answer`)
    }
    return out
  }, [graph.nodes])
  const knownRoots = useMemo(() => {
    const s = new Set<string>(FLOW_VARIABLES.map((v) => v.token.split('.')[0]!))
    for (const n of graph.nodes) { s.add(n.id); if (n.type === 'variable' && typeof n.data.variableName === 'string') s.add(n.data.variableName) }
    return s
  }, [graph.nodes])
  const trace = useMemo(() => {
    if (!dry) return undefined
    const m: Record<string, TraceTone> = {}
    for (const t of dry.trace) if (t.type !== 'engine') m[t.node] = t.status
    return m
  }, [dry])
  const hasWait = graph.nodes.some((n) => n.type === 'wait_event')

  const inspector = selectedNode && (
    <NodeInspector
      key={selectedNode.id} node={selectedNode} readOnly={readOnly} errors={(errMap.get(selectedNode.id) ?? [])} warnings={(warnMap.get(selectedNode.id) ?? [])}
      onData={(data, key) => edit(setNodeData(graph, selectedNode.id, data), `data:${selectedNode.id}:${key}`)}
      onLabel={(l) => edit(setNodeLabel(graph, selectedNode.id, l), `label:${selectedNode.id}`)}
      onDelete={removeSelection}
      flowReentry={info.reentry} meta={meta.state.status === 'ready' ? meta.state.data : null} aiConfigured={aiConfigured} upstream={upstream} knownRoots={knownRoots}
    />
  )
  const status = info.status
  const unpublished = status !== 'draft' && info.unpublished_changes

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="flow-editor">
      <header className="flex flex-wrap items-center gap-2 border-b bg-surface px-3 py-2">
        <Link to="/automations" aria-label="Back to automations" onClick={(e) => { if (isAdmin && dirty && local.errors.length && !window.confirm('This flow has errors, so your latest changes cannot be saved yet. Leave anyway? They are kept on this device and restored when you reopen the flow.')) e.preventDefault() }} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md hover:bg-muted"><ArrowLeft aria-hidden className="h-5 w-5" /></Link>
        <input
          aria-label="Flow name" data-testid="flow-name-input" value={name} maxLength={80} disabled={readOnly} onChange={(e) => setName(e.target.value)}
          className="min-h-[40px] min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 text-base font-bold hover:border-border focus-visible:border-border focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent md:max-w-xs md:flex-none"
        />
        <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>
        {unpublished && <Badge tone="amber">Unpublished changes</Badge>}
        <span className="text-xs text-muted-foreground" role="status" aria-live="polite" data-testid="save-state" data-state={saveState}>{isAdmin ? SAVE_LABEL[saveState] : 'View only'}</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {!narrow && isAdmin && (
            <>
              <Button variant="ghost" className="h-10 w-10 px-0" aria-label="Undo" disabled={readOnly || !canUndo(hist)} onClick={doUndo}><Undo2 aria-hidden className="h-4 w-4" /></Button>
              <Button variant="ghost" className="h-10 w-10 px-0" aria-label="Redo" disabled={readOnly || !canRedo(hist)} onClick={doRedo}><Redo2 aria-hidden className="h-4 w-4" /></Button>
            </>
          )}
          {isAdmin && (
            <label className="flex min-h-[40px] cursor-pointer items-center gap-2 text-sm font-semibold" title="Shadow mode records what would happen and sends nothing">
              <input type="checkbox" data-testid="shadow-toggle" checked={shadow} disabled={readOnly} onChange={(e) => setShadow(e.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />Shadow
            </label>
          )}
          <Button variant="secondary" onClick={() => { setTestOpen((v) => !v); setTab('canvas') }} aria-pressed={testOpen} data-testid="open-test"><FlaskConical aria-hidden className="h-4 w-4" />Test</Button>
          {isAdmin && status === 'active' && <Button variant="secondary" loading={publishing && !pubDlg} disabled={readOnly} onClick={() => void pause()} data-testid="pause-flow"><Pause aria-hidden className="h-4 w-4" />Pause</Button>}
          {isAdmin && status !== 'archived' && (status !== 'active' || unpublished) && (
            <Button disabled={readOnly || saveState === 'blocked'} loading={publishing} onClick={() => void publish()} data-testid="publish-flow"><Play aria-hidden className="h-4 w-4" />{status === 'paused' ? 'Resume' : unpublished ? 'Publish changes' : 'Publish'}</Button>
          )}
        </div>
      </header>
      <div className="flex border-b bg-surface px-3" role="tablist">
        {(['canvas', 'runs'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} data-testid={`tab-${t}`} onClick={() => setTab(t)} className={`min-h-[44px] border-b-2 px-4 text-sm font-semibold ${tab === t ? 'border-accent text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>{t === 'canvas' ? 'Canvas' : 'Runs'}</button>
        ))}
      </div>
      {(saveErr || notice || generalErrors.length > 0 || (narrow && tab === 'canvas')) && (
        <div className="space-y-1 border-b bg-muted/50 px-3 py-2 text-xs" role="status">
          {generalErrors.map((m) => <p key={m} className="text-danger" data-testid="graph-error">{m}</p>)}
          {saveErr && <p className="text-danger">{saveErr}</p>}
          {notice && <p>{notice}</p>}
          {narrow && tab === 'canvas' && <p className="text-muted-foreground">Editing the canvas needs a wider screen. Here you can read the flow and change a step&apos;s settings.</p>}
        </div>
      )}
      {tab === 'runs' ? (
        <div className="min-h-0 flex-1 overflow-y-auto"><RunsTab flowId={info.id} labelOf={labelOf} isAdmin={isAdmin} /></div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {!narrow && <aside className="w-56 shrink-0 overflow-y-auto border-r bg-surface"><NodePalette onAdd={(t) => addAt(t)} disabled={readOnly} aiConfigured={aiConfigured} /></aside>}
          <div className="relative min-h-0 min-w-0 flex-1">
            {narrow ? (
              <div className="flex h-full flex-col">
                <FlowCanvas graph={graph} selection={sel} onSelect={setSel} onChange={edit} onDragEnd={() => setHist((h) => breakHistory(h))} onNotice={setNotice} errors={errors} warnings={local.warnings} trace={trace} readOnly className="h-56 shrink-0 border-b" />
                <ul className="min-h-0 flex-1 divide-y overflow-y-auto" aria-label="Steps">
                  {graph.nodes.map((n) => (
                    <li key={n.id}><button type="button" className="flex min-h-[48px] w-full items-center gap-2 px-3 text-left hover:bg-muted" onClick={() => setSel({ node: n.id, conn: null })}>
                      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{n.label}</span><span className="block truncate text-xs text-muted-foreground">{NODE_META[n.type]?.label}</span></span>
                      {errMap.has(n.id) && <Badge tone="coral">Needs a fix</Badge>}
                    </button></li>
                  ))}
                </ul>
              </div>
            ) : (
              <FlowCanvas
                graph={graph} selection={sel} onSelect={setSel} onChange={edit} onDragEnd={() => setHist((h) => breakHistory(h))} onNotice={setNotice}
                onDropNode={(t, x, y) => addAt(t, x, y)} errors={errors} warnings={local.warnings} trace={trace} readOnly={canvasReadOnly} className="h-full"
              />
            )}
          </div>
          {!narrow && (testOpen || selectedNode) && (
            <aside className="w-80 shrink-0 overflow-y-auto border-l bg-surface p-3" data-testid="side-panel">
              {testOpen
                ? <TestPanel flowId={info.id} beforeRun={flush} labelOf={labelOf} hasWait={hasWait} onResult={setDry} />
                : inspector}
            </aside>
          )}
        </div>
      )}
      {narrow && tab === 'canvas' && selectedNode && <Modal title={selectedNode.label} onClose={() => setSel({ node: null, conn: null })}>{inspector}</Modal>}
      {narrow && tab === 'canvas' && testOpen && <Modal title="Test this flow" onClose={() => setTestOpen(false)}><TestPanel flowId={info.id} beforeRun={flush} labelOf={labelOf} hasWait={hasWait} onResult={setDry} /></Modal>}
      {pubDlg && (
        <Modal title={pubDlg.phase === 'done' ? 'Published' : pubDlg.phase === 'failed' ? 'Not published' : 'Checking the flow'} onClose={() => { if (pubDlg.phase !== 'checking') setPubDlg(null) }}>
          <div data-testid="publish-result" data-phase={pubDlg.phase}>
            {pubDlg.phase === 'checking' && <div aria-busy="true" aria-label="Checking" className="space-y-2"><Skeleton className="h-5" /><Skeleton className="h-5 w-2/3" /></div>}
            {pubDlg.phase === 'done' && (
              <div className="space-y-3">
                <p className="text-sm">The flow is {shadow ? 'running in shadow mode.' : 'live.'}</p>
                {pubDlg.warnings.length > 0 && <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">{pubDlg.warnings.map((w, i) => <li key={i}>{w.msg}</li>)}</ul>}
                <Button className="w-full" onClick={() => setPubDlg(null)}>Done</Button>
              </div>
            )}
            {pubDlg.phase === 'failed' && (
              <div className="space-y-3">
                {pubDlg.message && <p role="alert" className="text-sm text-danger">{pubDlg.message}</p>}
                {pubDlg.errors.length > 0 && (
                  <>
                    <p className="text-sm">Fix these, then publish again.</p>
                    <ul className="space-y-1" data-testid="publish-errors">
                      {pubDlg.errors.map((e, i) => (
                        <li key={i}>{e.node ? <button type="button" className="w-full rounded-md px-2 py-2 text-left text-sm hover:bg-muted" onClick={() => { setSel({ node: e.node, conn: null }); setPubDlg(null) }}><span className="font-semibold">{labelOf(e.node)}</span>: {e.msg}</button> : <span className="block px-2 py-2 text-sm">{e.msg}</span>}</li>
                      ))}
                    </ul>
                  </>
                )}
                <Button variant="secondary" className="w-full" onClick={() => setPubDlg(null)}>Close</Button>
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  )
}
