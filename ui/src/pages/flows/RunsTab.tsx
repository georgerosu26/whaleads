import { History } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { EmptyState } from '@/components/EmptyState'
import { ErrorState } from '@/components/ErrorState'
import { Modal } from '@/components/leads/Modal'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { CopyButton } from '@/components/CopyButton'
import { useAuth } from '@/lib/auth'
import { whenLabel } from '@/lib/crm'
import { flowErrorText, flowsApi, RUN_STATUSES, type FlowRunFrame, type RunDetail, type RunRow } from '@/lib/flows'
import { useLiveEvents } from '@/lib/live'
import { applyFlowRunFrame, mergeRunsFirstPage, runTerminal } from '@/lib/liveReduce'
import { TraceList } from './TraceList'

const TONE: Record<string, string> = { running: 'blue', awaiting: 'amber', completed: 'green', failed: 'coral', abandoned: 'neutral', cancelled: 'neutral' }
const LABEL: Record<string, string> = { running: 'Running', awaiting: 'Waiting', completed: 'Completed', failed: 'Failed', abandoned: 'Abandoned', cancelled: 'Cancelled' }

export function RunsTab({ flowId, labelOf, isAdmin }: { flowId: number; labelOf: (id: string) => string; isAdmin: boolean }) {
  const { state } = useAuth()
  const tz = state.status === 'in' ? state.me.timezone : 'UTC'
  const [status, setStatus] = useState('')
  const [rows, setRows] = useState<RunRow[] | null>(null)
  const [next, setNext] = useState<number | null>(null)
  const [err, setErr] = useState('')
  const [more, setMore] = useState(false)
  const [open, setOpen] = useState<number | null>(null)
  const rowsRef = useRef<RunRow[] | null>(null); rowsRef.current = rows
  const seq = useRef(0)

  const first = useCallback(async (keep: boolean) => {
    const my = ++seq.current
    if (!keep) { setRows(null); setErr('') }
    try {
      const r = await flowsApi.runs(flowId, { status: status || undefined })
      if (my !== seq.current) return
      setRows((cur) => (keep && cur ? mergeRunsFirstPage(cur, r.runs) : r.runs))
      if (!keep) setNext(r.next_before)
      setErr('')
    } catch (e) { if (my === seq.current && !keep) setErr(flowErrorText(e)) }
  }, [flowId, status])
  useEffect(() => { void first(false) }, [first])

  useLiveEvents((s) => {
    if (s.type === 'resync') { void first(true); return }
    if (s.type !== 'flow.run' || s.data?.flow_id !== flowId) return
    const f = s.data as FlowRunFrame
    const cur = rowsRef.current
    if (!cur) return
    const patched = applyFlowRunFrame(cur, f)
    if (patched === null) void first(true) // a run we have not seen: fetch the first page and merge
    else if (patched !== cur) setRows(status && f.status !== status ? patched.filter((r) => r.id !== f.run_id) : patched)
  })

  async function loadMore() {
    if (!next) return
    setMore(true)
    try { const r = await flowsApi.runs(flowId, { status: status || undefined, before: next }); setRows((c) => mergeRunsFirstPage(c ?? [], r.runs)); setNext(r.next_before) } catch (e) { setErr(flowErrorText(e)) } finally { setMore(false) }
  }

  return (
    <div className="mx-auto max-w-3xl p-4" data-testid="runs-tab">
      <div className="mb-3 flex items-center gap-2">
        <label htmlFor="runs-status" className="text-sm font-semibold">Status</label>
        <Select id="runs-status" className="w-44" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All</option>
          {RUN_STATUSES.map((s) => <option key={s} value={s}>{LABEL[s]}</option>)}
        </Select>
      </div>
      {err && rows === null ? <ErrorState message={err} onRetry={() => void first(false)} />
        : rows === null ? <div aria-busy="true" aria-label="Loading runs" className="space-y-2"><Skeleton className="h-16" /><Skeleton className="h-16" /><Skeleton className="h-16" /></div>
        : rows.length === 0 ? <EmptyState icon={History} title={status ? 'No runs with that status' : 'No runs yet'} body={status ? 'Clear the filter to see every run.' : 'A run appears here the moment a lead starts this flow.'} action={status ? <Button variant="secondary" onClick={() => setStatus('')}>Clear filter</Button> : undefined} />
        : (
          <>
            <ul className="space-y-2">
              {rows.map((r) => (
                <li key={r.id} data-testid="run-row" data-run-id={r.id} data-run-status={r.status} className="rounded-lg border bg-surface">
                  <div className="flex items-center gap-3 px-3 py-2">
                    <button type="button" className="min-h-[44px] min-w-0 flex-1 text-left" onClick={() => setOpen(r.id)}>
                      <span className="block truncate text-sm font-semibold">{r.contact_name || `Lead ${r.lead_id}`}</span>
                      <span className="block truncate text-xs text-muted-foreground">Started {whenLabel(r.started_at, tz)} · v{r.flow_version}{r.trigger ? ` · ${r.trigger}` : ''}{r.error ? ` · ${r.error}` : ''}</span>
                    </button>
                    {r.shadow && <Badge tone="violet">Shadow</Badge>}
                    <Badge tone={TONE[r.status]}>{LABEL[r.status] ?? r.status}</Badge>
                    {isAdmin && !runTerminal(r.status) && <CancelBtn id={r.id} onDone={() => void first(true)} />}
                  </div>
                </li>
              ))}
            </ul>
            {err && <p role="alert" className="mt-2 text-sm text-danger">{err}</p>}
            {next && <Button variant="secondary" className="mt-3 w-full" loading={more} onClick={() => void loadMore()}>Load more</Button>}
          </>
        )}
      {open !== null && <RunModal id={open} labelOf={labelOf} onClose={() => setOpen(null)} />}
    </div>
  )
}

function CancelBtn({ id, onDone }: { id: number; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  return (
    <>
      <Button variant="secondary" className="min-h-[44px]" loading={busy} aria-label={`Cancel run ${id}`} data-testid="cancel-run" onClick={async () => { setBusy(true); setErr(''); try { await flowsApi.cancelRun(id); onDone() } catch (e) { setErr(flowErrorText(e)) } finally { setBusy(false) } }}>Cancel</Button>
      {err && <span role="alert" className="text-xs text-danger">{err}</span>}
    </>
  )
}

function RunModal({ id, labelOf, onClose }: { id: number; labelOf: (id: string) => string; onClose: () => void }) {
  const [run, setRun] = useState<RunDetail | null>(null)
  const [err, setErr] = useState('')
  const load = useCallback(() => { setErr(''); flowsApi.run(id).then((r) => setRun(r.run)).catch((e) => setErr(flowErrorText(e))) }, [id])
  useEffect(load, [load])
  return (
    <Modal title={`Run ${id}`} onClose={onClose}>
      {err ? <div role="alert" className="space-y-2"><p className="text-sm text-danger">{err}</p><Button variant="secondary" onClick={load}>Retry</Button></div>
        : !run ? <div aria-busy="true" aria-label="Loading run" className="space-y-2"><Skeleton className="h-12" /><Skeleton className="h-12" /></div>
        : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex items-center gap-2"><Badge tone={TONE[run.status]}>{LABEL[run.status]}</Badge>{run.shadow && <Badge tone="violet">Shadow</Badge>}</span>
              <CopyButton value={JSON.stringify(run, null, 2)} label="Copy as JSON" />
            </div>
            {run.error && <p className="break-words text-sm text-danger">{run.error}</p>}
            <Link to={`/leads/${run.lead_id}`} className="block text-sm font-semibold text-accent">Open the lead</Link>
            <TraceList trace={run.trace} context={run.context} labelOf={labelOf} />
          </div>
        )}
    </Modal>
  )
}
