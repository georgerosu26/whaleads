import { Columns3, List, Plus, Search, Users } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { EmptyState } from '@/components/EmptyState'
import { ErrorState } from '@/components/ErrorState'
import { PageHeader } from '@/components/PageHeader'
import { BoardSkeleton, LeadBoard, type BoardColumn } from '@/components/leads/LeadBoard'
import { LeadRow, LeadRowSkeleton } from '@/components/leads/LeadRow'
import { LostDialog } from '@/components/leads/LostDialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useMeta, type LeadT, type Stage } from '@/lib/crm'
import { cn } from '@/lib/utils'

const FILTER_KEYS = ['stage', 'source', 'owner', 'tag', 'campaign'] as const // campaign

export default function Leads() {
  const { state } = useAuth()
  const tz = state.status === 'in' ? state.me.timezone : 'UTC'
  const [sp, setSp] = useSearchParams()
  const view = sp.get('view') === 'board' ? 'board' : 'list'
  const [qText, setQText] = useState(sp.get('q') ?? '')
  const { state: meta, reload: reloadMeta } = useMeta()
  const [rows, setRows] = useState<LeadT[] | null>(null)
  const [cols, setCols] = useState<BoardColumn[] | null>(null)
  const [next, setNext] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [more, setMore] = useState(false)
  const [lostFor, setLostFor] = useState<{ lead: LeadT; stage: Stage } | null>(null)
  const seq = useRef(0)

  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n, { replace: true }) }
  useEffect(() => { const t = setTimeout(() => { if ((sp.get('q') ?? '') !== qText.trim()) set('q', qText.trim()) }, 250); return () => clearTimeout(t) }, [qText]) // eslint-disable-line react-hooks/exhaustive-deps

  // Everything except view and the board's own stage filter.
  const base = new URLSearchParams()
  for (const k of [...FILTER_KEYS, 'q'] as const) { const v = sp.get(k); if (v && !(view === 'board' && k === 'stage')) base.set(k, v) }
  const query = base.toString()

  const load = useCallback(async () => {
    const my = ++seq.current
    setErr(null); setRows(null); setCols(null); setNext(null)
    try {
      if (view === 'board') {
        const r = await api<{ columns: BoardColumn[] }>(`/api/leads/board?${query}`)
        if (my === seq.current) setCols(r.columns)
      } else {
        const r = await api<{ leads: LeadT[]; next_before: string | null }>(`/api/leads?${query}&limit=30`)
        if (my === seq.current) { setRows(r.leads); setNext(r.next_before) }
      }
    } catch (e) { if (my === seq.current) setErr((e as Error).message) }
  }, [view, query])
  useEffect(() => { void load() }, [load])

  const loadMore = async () => {
    if (!next) return
    setMore(true)
    try {
      const r = await api<{ leads: LeadT[]; next_before: string | null }>(`/api/leads?${query}&limit=30&before=${next}`)
      setRows((p) => [...(p ?? []), ...r.leads]); setNext(r.next_before)
    } catch (e) { setErr((e as Error).message) } finally { setMore(false) }
  }

  const move = async (lead: LeadT, to: Stage, reason?: string) => {
    await api(`/api/leads/${lead.id}`, { method: 'PATCH', body: { status: to.key, ...(to.kind === 'lost' && reason ? { lost_reason: reason } : {}) } })
    await load()
  }
  const onMove = (lead: LeadT, to: Stage) => { if (to.kind === 'lost') setLostFor({ lead, stage: to }); else void move(lead, to).catch((e) => setErr((e as Error).message)) }

  const m = meta.status === 'ready' ? meta.data : null
  const filtered = FILTER_KEYS.some((k) => sp.get(k)) || !!sp.get('q')

  return (
    <>
      <PageHeader title="Leads" subtitle="Everyone who has asked about your business"
        actions={<Link to="/leads/new"><Button><Plus className="h-4 w-4" aria-hidden />New lead</Button></Link>} />
      <div className="mb-3 flex items-center gap-2">
        <div className="relative flex-1">
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label="Search leads" placeholder="Search name, email, phone" className="pl-9" value={qText} onChange={(e) => setQText(e.target.value)} />
        </div>
        <div role="group" aria-label="View" className="flex shrink-0 overflow-hidden rounded-md border">
          {([['list', List, 'List'], ['board', Columns3, 'Board']] as const).map(([v, Icon, label]) => (
            <button key={v} type="button" aria-pressed={view === v} aria-label={`${label} view`} onClick={() => set('view', v === 'list' ? '' : v)}
              className={cn('flex min-h-[40px] min-w-[44px] items-center justify-center', view === v ? 'bg-accent text-accent-foreground' : 'bg-surface hover:bg-muted')}><Icon className="h-4 w-4" /></button>
          ))}
        </div>
      </div>
      <div className="mb-4 flex gap-2 overflow-x-auto pb-1" aria-label="Filters">
        {view === 'list' && <Select aria-label="Stage" className="w-auto shrink-0" value={sp.get('stage') ?? ''} onChange={(e) => set('stage', e.target.value)}>
          <option value="">All stages</option>{m?.stages.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </Select>}
        <Select aria-label="Source" className="w-auto shrink-0" value={sp.get('source') ?? ''} onChange={(e) => set('source', e.target.value)}>
          <option value="">All sources</option>{m?.sources.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </Select>
        <Select aria-label="Owner" className="w-auto shrink-0" value={sp.get('owner') ?? ''} onChange={(e) => set('owner', e.target.value)}>
          <option value="">Any owner</option><option value="me">Mine</option><option value="none">Unassigned</option>
          {m?.owners.map((o) => <option key={o.id} value={String(o.id)}>{o.name}</option>)}
        </Select>
        <Select aria-label="Tag" className="w-auto shrink-0" value={sp.get('tag') ?? ''} onChange={(e) => set('tag', e.target.value)}>
          <option value="">Any tag</option>{m?.tags.map((t) => <option key={t.id} value={String(t.id)}>{t.label}</option>)}
        </Select>
      </div>
      {sp.get('campaign') && ( // ad campaign chip, set from the Reports page
        <div className="mb-3"><button type="button" onClick={() => set('campaign', '')} aria-label={`Clear ad filter ${sp.get('campaign')}`} className="inline-flex min-h-[32px] max-w-full items-center gap-2 rounded-full border bg-muted px-3 text-xs font-semibold"><span className="truncate">Ad {sp.get('campaign')}</span><span aria-hidden>x</span></button></div>
      )}
      {meta.status === 'error' && <p role="alert" className="mb-3 text-sm text-danger">Filters failed to load. <button className="font-semibold underline" onClick={reloadMeta}>Retry</button></p>}

      {err ? <ErrorState message={err} onRetry={() => void load()} /> : view === 'board' ? (
        cols ? <LeadBoard columns={cols} stages={m?.stages ?? cols.map((c) => c.stage as Stage)} tz={tz} query={query} onMove={onMove} onChange={setCols} /> : <BoardSkeleton />
      ) : rows === null ? (
        <div aria-busy="true" aria-label="Loading leads" className="overflow-hidden rounded-lg border bg-surface">{[0, 1, 2, 3, 4].map((i) => <LeadRowSkeleton key={i} />)}</div>
      ) : rows.length === 0 ? (
        <EmptyState icon={Users} title={filtered ? 'No leads match these filters' : 'No leads yet'}
          body={filtered ? 'Try clearing a filter.' : 'Leads arrive from WhatsApp, your forms and ads. You can also add one by hand.'}
          action={filtered ? <Button variant="secondary" onClick={() => { setQText(''); setSp({}, { replace: true }) }}>Clear filters</Button> : <Link to="/leads/new"><Button>New lead</Button></Link>} />
      ) : (
        <>
          <div className="overflow-hidden rounded-lg border bg-surface">{rows.map((l) => <LeadRow key={l.id} lead={l} tz={tz} />)}</div>
          {next && <div className="mt-3 flex justify-center"><Button variant="secondary" loading={more} onClick={() => void loadMore()}>Load more</Button></div>}
        </>
      )}
      {lostFor && <LostDialog stageLabel={lostFor.stage.label} onClose={() => setLostFor(null)} onConfirm={async (reason) => { await move(lostFor.lead, lostFor.stage, reason); setLostFor(null) }} />}
    </>
  )
}
