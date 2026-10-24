import { BellOff } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { OPT_OUT_SOURCE_LABEL, STATUS_LABEL, STATUS_TONE, progressPct, useOptOut, type Broadcast, type BroadcastStatus, type OptOutFields } from '@/lib/broadcasts'

export function StatusBadge({ status }: { status: BroadcastStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>
}

export function ProgressBar({ b }: { b: Pick<Broadcast, 'total' | 'sent' | 'failed' | 'status'> }) {
  const pct = progressPct(b)
  return (
    <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Broadcast progress" className="h-2 w-full overflow-hidden rounded-full bg-muted">
      <div className={`h-full rounded-full ${b.status === 'failed' ? 'bg-danger' : 'bg-accent'} transition-[width] duration-300`} style={{ width: `${pct}%` }} />
    </div>
  )
}

/** "Opted out of broadcasts" chip plus the manual toggle (any staff). Renders nothing until the state is known. */
export function OptOutControl({ contactId, payload, compact }: { contactId: number | null; payload?: OptOutFields | null; compact?: boolean }) {
  const { st, busy, err, toggle } = useOptOut(contactId, payload)
  if (!st) return null
  if (!st.optedOut && compact) return null
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="optout-control">
      {st.optedOut && (
        <span title={st.source ? OPT_OUT_SOURCE_LABEL[st.source] : undefined} data-testid="optout-chip">
          <Badge tone="amber"><BellOff aria-hidden className="mr-1 h-3 w-3" />Opted out of broadcasts</Badge>
        </span>
      )}
      {!compact && (
        <Button variant="ghost" className="h-9 px-2 text-xs" loading={busy} onClick={() => void toggle()} data-testid="optout-toggle">
          {st.optedOut ? 'Allow broadcasts again' : 'Opt out of broadcasts'}
        </Button>
      )}
      {compact && st.optedOut && (
        <Button variant="ghost" className="h-8 px-2 text-xs" loading={busy} onClick={() => void toggle()} data-testid="optout-toggle">Allow again</Button>
      )}
      {err && <p role="alert" className="w-full text-xs text-danger">{err}</p>}
    </div>
  )
}
