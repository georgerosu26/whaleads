import { Link } from 'react-router-dom'
import { Badge } from '@/components/ui/badge'
import { dueLabel, initial, leadName, stageTone, type LeadT } from '@/lib/crm'
import { showPhone, shortTime } from '@/lib/inbox'
import { cn } from '@/lib/utils'

export function LeadRow({ lead, tz, showStage = true }: { lead: LeadT; tz: string; showStage?: boolean }) {
  const due = lead.next_action_at ? dueLabel(lead.next_action_at, tz) : null
  const name = leadName(lead)
  return (
    <Link to={`/leads/${lead.id}`} className="flex min-h-[64px] items-center gap-3 border-b px-4 py-3 hover:bg-muted/60">
      <span aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent/15 text-sm font-bold text-accent">{initial(name)}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm font-semibold">{name}</span>
          <time className="shrink-0 text-xs text-muted-foreground">{shortTime(lead.created_at)}</time>
        </span>
        <span className="block truncate text-sm text-muted-foreground">{lead.name ? showPhone(lead.phone ?? lead.wa_id) : ''}{lead.message ? `${lead.name ? ' · ' : ''}${lead.message}` : ''}</span>
        <span className="mt-1 flex flex-wrap items-center gap-1.5">
          {showStage && lead.stage_label && <Badge tone={stageTone(lead.stage_kind)}>{lead.stage_label}</Badge>}
          {lead.tags.slice(0, 3).map((t) => <Badge key={t.id} tone={t.color}>{t.label}</Badge>)}
          {lead.tags.length > 3 && <span className="text-xs text-muted-foreground">+{lead.tags.length - 3}</span>}
          {due && <span className={cn('text-xs font-semibold', due.overdue ? 'text-danger' : 'text-muted-foreground')}>{due.text}</span>}
          {lead.assigned_name && <span className="truncate text-xs text-muted-foreground">{lead.assigned_name}</span>}
        </span>
      </span>
    </Link>
  )
}

export function LeadRowSkeleton() {
  return (
    <div className="flex items-center gap-3 border-b px-4 py-3">
      <div aria-hidden className="h-10 w-10 shrink-0 animate-pulse rounded-full bg-muted" />
      <div className="flex-1 space-y-2"><div aria-hidden className="h-4 w-1/2 animate-pulse rounded-md bg-muted" /><div aria-hidden className="h-3 w-3/4 animate-pulse rounded-md bg-muted" /></div>
    </div>
  )
}
