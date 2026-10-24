// Dry run: the saved draft runs against a real lead, nothing is sent or changed, and the trace comes back in order.
import { FlaskConical, Search } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { CopyButton } from '@/components/CopyButton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { leadName, type LeadT } from '@/lib/crm'
import { flowErrorText, flowsApi, issuesOf, type DryRunResult, type GraphIssue } from '@/lib/flows'
import { TraceList } from './TraceList'

export interface TestPanelProps {
  flowId: number
  /** Persist the draft first: the server tests what is saved. Resolves false when it could not be saved. */
  beforeRun: () => Promise<boolean>
  labelOf: (id: string) => string
  hasWait: boolean
  onResult: (r: DryRunResult | null) => void
}

export function TestPanel({ flowId, beforeRun, labelOf, hasWait, onResult }: TestPanelProps) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<LeadT[] | null>(null)
  const [searchErr, setSearchErr] = useState('')
  const [lead, setLead] = useState<LeadT | null>(null)
  const [text, setText] = useState('')
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [issues, setIssues] = useState<GraphIssue[]>([])
  const [res, setRes] = useState<DryRunResult | null>(null)
  const seq = useRef(0)

  useEffect(() => {
    const my = ++seq.current
    const t = setTimeout(async () => {
      setSearchErr('')
      try {
        const r = await api<{ leads: LeadT[] }>(`/api/leads?${q.trim() ? `q=${encodeURIComponent(q.trim())}&` : ''}limit=8`)
        if (my === seq.current) setHits(r.leads)
      } catch (e) { if (my === seq.current) { setHits([]); setSearchErr(flowErrorText(e)) } }
    }, 200)
    return () => clearTimeout(t)
  }, [q])
  useEffect(() => () => onResult(null), []) // eslint-disable-line react-hooks/exhaustive-deps

  async function run() {
    if (!lead) return
    setBusy(true); setErr(''); setIssues([])
    try {
      if (!(await beforeRun())) { setErr('Fix the errors on the canvas first. The saved draft is what gets tested.'); return }
      const r = await flowsApi.dryRun(flowId, { lead_id: lead.id, ...(text.trim() ? { event: { text: text.trim() } } : {}), ...(reply.trim() ? { reply: reply.trim() } : {}) })
      setRes(r); onResult(r)
    } catch (e) {
      const list = issuesOf(e)
      if (list) setIssues(list)
      setErr(list ? 'The draft is not valid yet.' : flowErrorText(e))
    } finally { setBusy(false) }
  }

  return (
    <div className="space-y-4" data-testid="test-panel">
      <div>
        <h2 className="flex items-center gap-2 text-base font-bold"><FlaskConical aria-hidden className="h-4 w-4 text-accent" />Test this flow</h2>
        <p className="mt-1 text-xs text-muted-foreground">A dry run. Nothing is sent and no lead changes. Delays are skipped.</p>
      </div>
      <div>
        <Label htmlFor="test-lead-q">Lead</Label>
        {lead ? (
          <div className="flex items-center gap-2 rounded-md border bg-surface px-3 py-2">
            <span className="min-w-0 flex-1 truncate text-sm font-semibold" data-testid="test-lead-chosen">{leadName(lead)}</span>
            <button type="button" className="text-xs font-semibold text-accent" onClick={() => { setLead(null); setRes(null); onResult(null) }}>Change</button>
          </div>
        ) : (
          <>
            <div className="relative"><Search aria-hidden className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><Input id="test-lead-q" className="pl-9" placeholder="Search name or phone" value={q} onChange={(e) => setQ(e.target.value)} /></div>
            <div className="mt-2" aria-live="polite">
              {hits === null ? <div aria-busy="true" aria-label="Searching" className="space-y-1.5"><Skeleton className="h-10" /><Skeleton className="h-10" /></div>
                : searchErr ? <p role="alert" className="text-xs text-danger">{searchErr}</p>
                : hits.length === 0 ? <p className="text-xs text-muted-foreground">{q.trim() ? 'No lead matches.' : 'There are no leads to test with yet.'}</p>
                : <ul className="divide-y rounded-md border bg-surface" data-testid="test-lead-results">{hits.map((l) => <li key={l.id}><button type="button" className="flex min-h-[44px] w-full items-center gap-2 px-3 text-left hover:bg-muted" onClick={() => setLead(l)}><span className="min-w-0 flex-1 truncate text-sm font-semibold">{leadName(l)}</span><span className="shrink-0 text-xs text-muted-foreground">{l.stage_label ?? l.status}</span></button></li>)}</ul>}
            </div>
          </>
        )}
      </div>
      <div>
        <Label htmlFor="test-event">Incoming message (optional)</Label>
        <Input id="test-event" placeholder="hi" value={text} maxLength={500} onChange={(e) => setText(e.target.value)} />
      </div>
      {hasWait && <div><Label htmlFor="test-reply">Their reply at Wait for reply (optional)</Label><Input id="test-reply" placeholder="Leave empty to test the No reply path" value={reply} maxLength={500} onChange={(e) => setReply(e.target.value)} /></div>}
      <Button className="w-full" disabled={!lead} loading={busy} onClick={() => void run()} data-testid="run-dry">Run dry run</Button>
      {err && <p role="alert" className="break-words text-sm text-danger">{err}</p>}
      {issues.length > 0 && <ul className="space-y-1 text-xs text-danger">{issues.map((i, k) => <li key={k}>{i.node ? `${labelOf(i.node)}: ` : ''}{i.msg}</li>)}</ul>}
      {busy && !res && <div aria-busy="true" aria-label="Running" className="space-y-1.5"><Skeleton className="h-12" /><Skeleton className="h-12" /></div>}
      {res && (
        <div className="space-y-3" data-testid="test-result">
          <div className="rounded-md border border-dashed bg-muted/50 px-3 py-2 text-xs font-semibold" data-testid="dry-banner">Dry run: nothing was sent.</div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold" data-testid="test-status">Ended: {res.status}{res.error ? ` (${res.error})` : ''}</p>
            <CopyButton value={JSON.stringify(res, null, 2)} label="Copy as JSON" />
          </div>
          <TraceList trace={res.trace} context={res.context} labelOf={labelOf} />
        </div>
      )}
    </div>
  )
}
