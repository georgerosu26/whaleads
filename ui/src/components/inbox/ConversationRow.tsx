import { NavLink } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { displayName, shortTime, type ConvRow } from '@/lib/inbox'

export function ConversationRow({ c }: { c: ConvRow }) {
  const unread = c.unread_count > 0
  return (
    <NavLink
      to={`/inbox/${c.contact_id}`}
      className={({ isActive }) => cn('flex min-h-[64px] items-center gap-3 border-b px-4 py-3', isActive ? 'bg-muted' : 'hover:bg-muted/60')}
    >
      <span aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent/15 text-sm font-bold text-accent">
        {displayName(c).replace(/[^\p{L}\p{N}]/gu, '').slice(0, 1).toUpperCase() || '#'}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className={cn('truncate text-sm', unread ? 'font-bold' : 'font-semibold')}>{displayName(c)}</span>
          <time className={cn('shrink-0 text-xs', unread ? 'font-semibold text-accent' : 'text-muted-foreground')}>{shortTime(c.last_message_at)}</time>
        </span>
        <span className="flex items-center justify-between gap-2">
          <span className={cn('truncate break-all text-sm', unread ? 'text-foreground' : 'text-muted-foreground')}>{c.last_preview ?? ''}</span>
          {unread && <span aria-label={`${c.unread_count} unread`} className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-accent px-1.5 text-xs font-bold text-accent-foreground">{c.unread_count > 99 ? '99+' : c.unread_count}</span>}
        </span>
        {(c.status === 'closed' || c.assigned_name) && (
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">{c.status === 'closed' ? 'Closed' : ''}{c.status === 'closed' && c.assigned_name ? ' · ' : ''}{c.assigned_name ? `Assigned to ${c.assigned_name}` : ''}</span>
        )}
      </span>
    </NavLink>
  )
}
