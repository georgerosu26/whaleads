import { ArrowLeft, Pause, Play, RotateCw, Trash2, XCircle } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ErrorState } from '@/components/ErrorState'
import { Modal } from '@/components/leads/Modal'
import { PageHeader } from '@/components/PageHeader'
import { ProgressBar, StatusBadge } from '@/components/broadcasts/parts'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuth } from '@/lib/auth'
import {
  RECIPIENT_LABEL, RECIPIENT_STATUSES, RECIPIENT_TONE, applyProgress, broadcastErrorText, broadcastsApi, canCancel, canDelete, canPause, excludedLine, isTerminal, progressPct, waiting,
  type Broadcast, type Recipient,
} from '@/lib/broadcasts'
import { whenLabel } from '@/lib/crm'
import { useLiveEvents, useLiveOpen } from '@/lib/live'
import { usePoller } from '@/lib/poll'

type St = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; b: Broadcast }
type Rec = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; rows: Recipient[]; next: string | null }

export default function BroadcastDetail() {
  const { id = '' } = useParams()
  const { state: auth } = useAuth()
  const nav = useNavigate()
  const isAdmin = auth.status === 'in' && auth.me.staff.role === 'admin'
  const tz = auth.status === 'in' ? auth.me.timezone : 'UTC'
  const live = useLiveOpen()
  const [st, setSt] = useState<St>({ status: 'loading' })
  const [rec, setRec] = useState<Rec>({ status: 'loading' })
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [note, setNote] = useState('')
  const [confirm, setConfirm] = useState<'cancel' | 'delete' | null>(null)
  const [moreBusy, setMoreBusy] = useState(false)

  const loadB = useCallback(async () => {
    try { const r = await broadcastsApi.get(id); setSt({ status: 'ready', b: r.broadcast }) }
    catch (e) { setSt((p) => (p.status === 'ready' ? p : { status: 'error', message: broadcastErrorText(e) })); throw e }
  }, [id])
  const loadRec = useCallback(async () => {
    try { const r = await broadcastsApi.recipients(id, filter || null); setRec({ status: 'ready', rows: r.recipients, next: r.next }) }
    catch (e) { setRec((p) => (p.status === 'ready' ? p : { status: 'error', message: broadcastErrorText(e) })); throw e }
  }, [id, filter])

  useEffect(() => { setSt({ status: 'loading' }); void loadB().catch(() => {}) }, [loadB])
  useEffect(() => { setRec({ status: 'loading' }); void loadRec().catch(() => {}) }, [loadRec])

  useLiveEvents((s) => {
    if (s.type === 'resync') { void loadB().catch(() => {}); void loadRec().catch(() => {}) }
    else if (s.type === 'broadcast.progress' && s.data?.id === id) setSt((p) => (p.status === 'ready' ? { status: 'ready', b: applyProgress(p.b, s.data) } : p))
  })
  const active = st.status === 'ready' && !isTerminal(st.b.status) && st.b.status !== 'draft'
  usePoller(async () => { await loadB(); await loadRec() }, live ? 60_000 : 10_000, active)

  async function run(key: string, fn: () => Promise<unknown>, after?: () => void) {
    setBusy(key); setErr(''); setNote('')
    try { await fn(); after?.(); await loadB().catch(() => {}); void loadRec().catch(() => {}) }
    catch (e) { setErr(broadcastErrorText(e)) } finally { setBusy(null); setConfirm(null) }
  }
  async function more() {
    if (rec.status !== 'ready' || !rec.next) return
    setMoreBusy(true)
    try { const r = await broadcastsApi.recipients(id, filter || null, rec.next); setRec((p) => (p.status === 'ready' ? { status: 'ready', rows: [...p.rows, ...r.recipients], next: r.next } : p)) }
    catch (e) { setErr(broadcastErrorText(e)) } finally { setMoreBusy(false) }
  }

  const header = <PageHeader title={st.status === 'ready' ? st.b.name : 'Broadcast'} actions={<Link to="/broadcasts"><Button variant="ghost"><ArrowLeft aria-hidden className="h-4 w-4" />Back</Button></Link>} />
  if (st.status === 'loading') return <div className="mx-auto max-w-3xl space-y-3 p-4 md:p-6" aria-busy="true" aria-label="Loading broadcast"><Skeleton className="h-7 w-48" /><Skeleton className="h-32" /><Skeleton className="h-48" /></div>
  if (st.status === 'error') return <div className="mx-auto max-w-3xl p-4 md:p-6">{header}<ErrorState message={st.message} onRetry={() => { setSt({ status: 'loading' }); void loadB().catch(() => {}) }} /></div>
  const b = st.b
  const wait = waiting(b)
  const n = (x: number) => x.toLocaleString('en')
  return (
    <div className="mx-auto max-w-3xl p-4 md:p-6">
      {header}
      <section className="rounded-lg border bg-surface p-3" data-testid="bc-summary">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={b.status} />
          <span className="text-sm text-muted-foreground">{b.template_name} · {b.language}</span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">Created {whenLabel(b.created_at, tz)}{b.started_at ? ` · started ${whenLabel(b.started_at, tz)}` : ''}{b.finished_at ? ` · finished ${whenLabel(b.finished_at, tz)}` : ''}</p>
        {b.status !== 'draft' && (
          <>
            <div className="mt-3"><ProgressBar b={b} /></div>
            <p className="mt-1 text-sm font-semibold" data-testid="bc-pct">{progressPct(b)}% handled</p>
            <dl className="mt-2 grid grid-cols-2 gap-2 text-sm sm:grid-cols-5" data-testid="bc-counts">
              <Stat k="Audience" v={n(b.total)} />
              <Stat k="Sent" v={n(b.sent)} />
              <Stat k="Delivered" v={n(b.delivered)} />
              <Stat k="Read" v={n(b.read)} />
              <Stat k="Failed" v={n(b.failed)} danger={b.failed > 0} />
              {!isTerminal(b.status) && <Stat k="Waiting" v={n(wait)} />}
              {b.unknown > 0 && <Stat k="Unknown" v={n(b.unknown)} />}
            </dl>
            {b.excluded > 0 && b.excluded_detail && <p className="mt-2 text-xs text-muted-foreground">Left out: {excludedLine(b.excluded_detail)}</p>}
          </>
        )}
        {b.status === 'paused' && <p role="status" className="mt-3 rounded-md bg-amber-500/10 p-2 text-sm text-amber-800 dark:text-amber-200" data-testid="pause-banner">Paused{b.pause_reason ? `: ${b.pause_reason}` : '.'}</p>}
        {b.status === 'failed' && <p role="alert" className="mt-3 rounded-md bg-danger/10 p-2 text-sm text-danger">This broadcast stopped with an error{b.pause_reason ? `: ${b.pause_reason}` : '.'}</p>}
        {isAdmin && (
          <div className="mt-3 flex flex-wrap gap-2" data-testid="bc-actions">
            {b.status === 'draft' && <Link to={`/broadcasts/${b.id}/edit`}><Button>Continue editing</Button></Link>}
            {canPause(b.status) && <Button variant="secondary" loading={busy === 'pause'} onClick={() => void run('pause', () => broadcastsApi.act(b.id, 'pause'))}><Pause aria-hidden className="h-4 w-4" />Pause</Button>}
            {b.status === 'paused' && <Button loading={busy === 'resume'} onClick={() => void run('resume', () => broadcastsApi.act(b.id, 'resume'))}><Play aria-hidden className="h-4 w-4" />Resume</Button>}
            {canCancel(b.status) && b.status !== 'draft' && <Button variant="secondary" onClick={() => setConfirm('cancel')}><XCircle aria-hidden className="h-4 w-4" />Cancel</Button>}
            {b.unknown > 0 && (
              <Button variant="secondary" loading={busy === 'requeue'} onClick={() => void run('requeue', async () => { const r = await broadcastsApi.requeueUnknown(b.id); setNote(`${n(r.requeued)} put back in the queue.`) })} data-testid="requeue-unknown"><RotateCw aria-hidden className="h-4 w-4" />Retry unknown</Button>
            )}
            {canDelete(b.status) && <Button variant="ghost" onClick={() => setConfirm('delete')}><Trash2 aria-hidden className="h-4 w-4" />Delete</Button>}
          </div>
        )}
        {b.unknown > 0 && isAdmin && <p className="mt-2 text-xs text-muted-foreground">Unknown means the send may or may not have gone out. Retrying can message someone twice, so check the table first.</p>}
        {err && <p role="alert" className="mt-2 text-sm text-danger" data-testid="bc-error">{err}</p>}
        {note && <p role="status" className="mt-2 text-sm text-muted-foreground">{note}</p>}
      </section>

      {b.status !== 'draft' && (
        <section className="mt-4" data-testid="bc-recipients">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="text-base font-bold">Recipients</h2>
            <Select aria-label="Filter recipients" className="w-40" value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="">All</option>
              {RECIPIENT_STATUSES.map((s) => <option key={s} value={s}>{RECIPIENT_LABEL[s]}</option>)}
            </Select>
          </div>
          {rec.status === 'loading' ? <div aria-busy="true" aria-label="Loading recipients" className="space-y-2"><Skeleton className="h-14" /><Skeleton className="h-14" /><Skeleton className="h-14" /></div>
            : rec.status === 'error' ? <ErrorState message={rec.message} onRetry={() => { setRec({ status: 'loading' }); void loadRec().catch(() => {}) }} />
            : rec.rows.length === 0 ? <p className="rounded-lg border bg-surface p-4 text-sm text-muted-foreground" data-testid="no-recipients">{filter ? 'No recipients with this status.' : 'No recipients yet.'}</p>
            : (
              <ul className="space-y-1.5">
                {rec.rows.map((r) => (
                  <li key={r.contact_id} className="rounded-lg border bg-surface p-2.5" data-testid="recipient-row">
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-sm font-semibold">{r.lead_id ? <Link to={`/leads/${r.lead_id}`} className="hover:underline">{r.name || r.phone || 'Unnamed'}</Link> : (r.name || r.phone || 'Unnamed')}</span>
                      <Badge tone={RECIPIENT_TONE[r.status]}>{RECIPIENT_LABEL[r.status]}</Badge>
                    </div>
                    <p className="truncate text-xs text-muted-foreground">{r.phone ?? ''}{r.sent_at ? ` · ${whenLabel(r.sent_at, tz)}` : ''}{r.attempts > 1 ? ` · ${r.attempts} attempts` : ''}</p>
                    {(r.status === 'failed' || r.status === 'skipped' || r.status === 'unknown') && (r.error_message || r.error_code) && (
                      <p className="mt-0.5 text-xs text-danger [overflow-wrap:anywhere]" data-testid="recipient-error">{r.error_message ?? 'Failed'}{r.error_code ? ` (code ${r.error_code})` : ''}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          {rec.status === 'ready' && rec.next && <div className="mt-3 text-center"><Button variant="secondary" loading={moreBusy} onClick={() => void more()}>Load more</Button></div>}
        </section>
      )}

      {confirm && (
        <Modal title={confirm === 'cancel' ? 'Cancel this broadcast?' : 'Delete this broadcast?'} onClose={() => setConfirm(null)}>
          <p className="mb-3 text-sm text-muted-foreground">{confirm === 'cancel' ? 'Messages not yet sent will not go out. Ones already sent cannot be recalled.' : 'The broadcast and its recipient list are removed. This cannot be undone.'}</p>
          <Button className="w-full" loading={busy === confirm} onClick={() => void (confirm === 'cancel' ? run('cancel', () => broadcastsApi.act(b.id, 'cancel')) : run('delete', () => broadcastsApi.remove(b.id), () => nav('/broadcasts', { replace: true })))}>{confirm === 'cancel' ? 'Cancel broadcast' : 'Delete'}</Button>
        </Modal>
      )}
    </div>
  )
}

function Stat({ k, v, danger }: { k: string; v: string; danger?: boolean }) {
  return <div className="rounded-md bg-muted/50 p-2"><dt className="text-xs text-muted-foreground">{k}</dt><dd className={`text-base font-bold ${danger ? 'text-danger' : ''}`}>{v}</dd></div>
}
