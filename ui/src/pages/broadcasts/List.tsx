import { Megaphone, Plus } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { EmptyState } from '@/components/EmptyState'
import { ErrorState } from '@/components/ErrorState'
import { PageHeader } from '@/components/PageHeader'
import { ProgressBar, StatusBadge } from '@/components/broadcasts/parts'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuth } from '@/lib/auth'
import { STATUS_FILTERS, STATUS_LABEL, applyProgress, broadcastErrorText, broadcastsApi, isTerminal, type Broadcast, type BroadcastStatus } from '@/lib/broadcasts'
import { whenLabel } from '@/lib/crm'
import { useLiveEvents, useLiveOpen } from '@/lib/live'
import { usePoller } from '@/lib/poll'
import { cn } from '@/lib/utils'

type St = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; rows: Broadcast[]; next: string | null }

export default function BroadcastsList() {
  const { state } = useAuth()
  const isAdmin = state.status === 'in' && state.me.staff.role === 'admin'
  const tz = state.status === 'in' ? state.me.timezone : 'UTC'
  const [st, setSt] = useState<St>({ status: 'loading' })
  const [filter, setFilter] = useState<BroadcastStatus | null>(null)
  const [more, setMore] = useState(false)
  const [moreErr, setMoreErr] = useState('')
  const live = useLiveOpen()

  const load = useCallback(async () => {
    try {
      const r = await broadcastsApi.list()
      // Pages already loaded below the first stay; only the newest page is refreshed.
      setSt((prev) => {
        if (prev.status !== 'ready') return { status: 'ready', rows: r.broadcasts, next: r.next }
        const fresh = new Set(r.broadcasts.map((b) => b.id))
        const older = prev.rows.slice(r.broadcasts.length).filter((b) => !fresh.has(b.id))
        return { status: 'ready', rows: [...r.broadcasts, ...older], next: older.length ? prev.next : r.next }
      })
    } catch (e) { setSt((prev) => (prev.status === 'ready' ? prev : { status: 'error', message: (e as Error).message })); throw e }
  }, [])
  useEffect(() => { void load().catch(() => {}) }, [load])
  useLiveEvents((s) => {
    if (s.type === 'resync') void load().catch(() => {})
    else if (s.type === 'broadcast.progress') {
      setSt((prev) => (prev.status === 'ready' ? { ...prev, rows: prev.rows.map((b) => applyProgress(b, s.data)) } : prev))
    }
  })
  const anyActive = st.status === 'ready' && st.rows.some((b) => !isTerminal(b.status) && b.status !== 'draft')
  usePoller(load, live ? 60_000 : anyActive ? 10_000 : 30_000)

  async function loadMore() {
    if (st.status !== 'ready' || !st.next) return
    setMore(true); setMoreErr('')
    try {
      const r = await broadcastsApi.list(st.next)
      setSt((prev) => (prev.status === 'ready' ? { status: 'ready', rows: [...prev.rows, ...r.broadcasts.filter((b) => !prev.rows.some((x) => x.id === b.id))], next: r.next } : prev))
    } catch (e) { setMoreErr(broadcastErrorText(e)) } finally { setMore(false) }
  }

  const rows = st.status === 'ready' ? (filter ? st.rows.filter((b) => b.status === filter) : st.rows) : []
  return (
    <div className="mx-auto max-w-3xl p-4 md:p-6">
      <PageHeader title="Broadcasts" subtitle="Send an approved template to a group of contacts"
        actions={isAdmin ? <Link to="/broadcasts/new" data-testid="new-broadcast"><Button><Plus aria-hidden className="h-4 w-4" />New broadcast</Button></Link> : undefined} />
      {st.status === 'ready' && st.rows.length > 0 && (
        <div className="mb-3 flex gap-1.5 overflow-x-auto pb-1" role="group" aria-label="Filter by status">
          <Chip active={!filter} onClick={() => setFilter(null)}>All</Chip>
          {STATUS_FILTERS.map((s) => <Chip key={s} active={filter === s} onClick={() => setFilter(s)}>{STATUS_LABEL[s]}</Chip>)}
        </div>
      )}
      {st.status === 'loading' ? <div aria-busy="true" aria-label="Loading broadcasts" className="space-y-2"><Skeleton className="h-24" /><Skeleton className="h-24" /><Skeleton className="h-24" /></div>
        : st.status === 'error' ? <ErrorState message={st.message} onRetry={() => { setSt({ status: 'loading' }); void load().catch(() => {}) }} />
        : st.rows.length === 0 ? <EmptyState icon={Megaphone} title="No broadcasts yet" body={isAdmin ? 'Pick an audience by tag or stage, choose an approved template and send it at a safe pace. People who opted out are skipped automatically.' : 'An admin can create the first broadcast.'}
            action={isAdmin ? <Link to="/broadcasts/new"><Button>Create a broadcast</Button></Link> : undefined} />
        : rows.length === 0 ? <p className="rounded-lg border bg-surface p-4 text-sm text-muted-foreground" data-testid="no-match">No {filter ? STATUS_LABEL[filter].toLowerCase() : ''} broadcasts{st.next ? ' in what is loaded so far' : ''}.</p>
        : (
          <ul className="space-y-2" data-testid="broadcast-list">
            {rows.map((b) => (
              <li key={b.id} data-testid="broadcast-row" className="rounded-lg border bg-surface p-3">
                <Link to={b.status === 'draft' && isAdmin ? `/broadcasts/${b.id}/edit` : `/broadcasts/${b.id}`} className="block min-w-0">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 truncate text-base font-bold [overflow-wrap:anywhere]">{b.name}</span>
                    <StatusBadge status={b.status} />
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">{b.template_name} · {b.language} · {whenLabel(b.created_at, tz)}</span>
                  {b.status !== 'draft' && (
                    <>
                      <span className="mt-2 block"><ProgressBar b={b} /></span>
                      <span className="mt-1.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                        <span>{b.sent.toLocaleString('en')} of {b.total.toLocaleString('en')} sent</span>
                        <span>{b.delivered.toLocaleString('en')} delivered</span>
                        <span>{b.read.toLocaleString('en')} read</span>
                        {b.failed > 0 && <span className="text-danger">{b.failed.toLocaleString('en')} failed</span>}
                      </span>
                    </>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      {st.status === 'ready' && st.next && (
        <div className="mt-3 text-center">
          <Button variant="secondary" loading={more} onClick={() => void loadMore()} data-testid="load-more">Load more</Button>
          {moreErr && <p role="alert" className="mt-2 text-sm text-danger">{moreErr}</p>}
        </div>
      )}
    </div>
  )
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return <button type="button" aria-pressed={active} onClick={onClick} className={cn('min-h-[36px] shrink-0 rounded-full border px-3 text-sm', active ? 'border-accent bg-accent/10 font-semibold text-accent' : 'bg-surface text-foreground')}>{children}</button>
}
