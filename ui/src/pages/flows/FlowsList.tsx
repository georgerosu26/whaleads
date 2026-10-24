import { Copy, Archive, Plus, Workflow } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { EmptyState } from '@/components/EmptyState'
import { ErrorState } from '@/components/ErrorState'
import { Modal } from '@/components/leads/Modal'
import { PageHeader } from '@/components/PageHeader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuth } from '@/lib/auth'
import { whenLabel } from '@/lib/crm'
import { flowErrorText, flowsApi, type FlowStatus, type FlowSummary } from '@/lib/flows'
import { useLive } from './useFlowList'

export const STATUS_TONE: Record<FlowStatus, string> = { draft: 'neutral', active: 'green', paused: 'amber', archived: 'neutral' }
export const STATUS_LABEL: Record<FlowStatus, string> = { draft: 'Draft', active: 'Active', paused: 'Paused', archived: 'Archived' }

export default function FlowsList() {
  const { state } = useAuth()
  const isAdmin = state.status === 'in' && state.me.staff.role === 'admin'
  const tz = state.status === 'in' ? state.me.timezone : 'UTC'
  const { st, reload } = useLive()
  const nav = useNavigate()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [confirm, setConfirm] = useState<FlowSummary | null>(null)

  async function create() {
    if (!name.trim()) { setErr('Give the flow a name.'); return }
    setBusy('create'); setErr('')
    try { const r = await flowsApi.create(name.trim()); nav(`/automations/${r.flow.id}`) } catch (e) { setErr(flowErrorText(e)) } finally { setBusy(null) }
  }
  async function dup(f: FlowSummary) {
    setBusy(`dup${f.id}`); setErr('')
    try { const r = await flowsApi.duplicate(f.id); nav(`/automations/${r.flow.id}`) } catch (e) { setErr(flowErrorText(e)) } finally { setBusy(null) }
  }
  async function archive(f: FlowSummary) {
    setBusy(`arc${f.id}`); setErr('')
    try { await flowsApi.archive(f.id); setConfirm(null); await reload() } catch (e) { setErr(flowErrorText(e)) } finally { setBusy(null) }
  }

  const flows = st.status === 'ready' ? st.data.flows.filter((f) => f.status !== 'archived') : []
  return (
    <div className="mx-auto max-w-3xl p-4 md:p-6">
      <PageHeader title="Automations" subtitle="Flows that answer and route leads for you" actions={isAdmin ? <Button onClick={() => { setCreating(true); setErr('') }} data-testid="new-flow"><Plus aria-hidden className="h-4 w-4" />New flow</Button> : undefined} />
      {err && !creating && <p role="alert" className="mb-3 text-sm text-danger">{err}</p>}
      {st.status === 'loading' ? <div aria-busy="true" aria-label="Loading flows" className="space-y-2"><Skeleton className="h-24" /><Skeleton className="h-24" /><Skeleton className="h-24" /></div>
        : st.status === 'error' ? <ErrorState message={st.message} onRetry={() => void reload()} />
        : flows.length === 0 ? <EmptyState icon={Workflow} title="No flows yet" body={isAdmin ? 'Start with a trigger, add a reply, and test it on a real lead before it goes live.' : 'An admin can create the first flow.'} action={isAdmin ? <Button onClick={() => setCreating(true)}>Create a flow</Button> : undefined} />
        : (
          <ul className="space-y-2" data-testid="flow-list">
            {flows.map((f) => (
              <li key={f.id} data-testid="flow-row" data-flow-name={f.name} className="rounded-lg border bg-surface p-3">
                <div className="flex items-start gap-3">
                  <Link to={`/automations/${f.id}`} className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-base font-bold">{f.name}</span>
                      <Badge tone={STATUS_TONE[f.status]}>{STATUS_LABEL[f.status]}</Badge>
                      {f.shadow && <Badge tone="violet">Shadow</Badge>}
                      {f.unpublished_changes && f.status !== 'draft' && <Badge tone="amber">Unpublished changes</Badge>}
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">{f.runs_7d} {f.runs_7d === 1 ? 'run' : 'runs'} in 7 days · {f.active_runs} live · {f.failed_7d} failed · edited {whenLabel(f.updated_at, tz)}</span>
                  </Link>
                  {isAdmin && (
                    <div className="flex shrink-0 gap-1">
                      <Button variant="ghost" className="h-11 w-11 px-0" aria-label={`Duplicate ${f.name}`} loading={busy === `dup${f.id}`} onClick={() => void dup(f)}><Copy aria-hidden className="h-4 w-4" /></Button>
                      <Button variant="ghost" className="h-11 w-11 px-0" aria-label={`Archive ${f.name}`} onClick={() => setConfirm(f)}><Archive aria-hidden className="h-4 w-4" /></Button>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      {creating && (
        <Modal title="New flow" onClose={() => setCreating(false)}>
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void create() }}>
            <div><Label htmlFor="flow-name">Name</Label><Input id="flow-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Welcome new enquiries" /></div>
            {err && <p role="alert" className="text-sm text-danger">{err}</p>}
            <Button type="submit" className="w-full" loading={busy === 'create'} data-testid="create-flow">Create</Button>
          </form>
        </Modal>
      )}
      {confirm && (
        <Modal title={`Archive ${confirm.name}?`} onClose={() => setConfirm(null)}>
          <p className="mb-3 text-sm text-muted-foreground">It stops starting runs and waiting runs are cancelled. This cannot be undone.</p>
          <Button className="w-full" loading={busy === `arc${confirm.id}`} onClick={() => void archive(confirm)}>Archive</Button>
        </Modal>
      )}
    </div>
  )
}
