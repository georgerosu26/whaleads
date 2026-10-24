import { CalendarCheck, MessageSquare } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { ReactNode } from 'react'
import { ConnectButton } from '@/components/ConnectButton'
import { EmptyState } from '@/components/EmptyState'
import { ErrorState } from '@/components/ErrorState'
import { PageHeader } from '@/components/PageHeader'
import { LeadRow, LeadRowSkeleton } from '@/components/leads/LeadRow'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuth } from '@/lib/auth'
import { useConnection } from '@/lib/connection'
import { displayName, shortTime } from '@/lib/inbox'
import type { LeadT } from '@/lib/crm'
import { useLoad } from '@/lib/useLoad'

interface Waiting { contact_id: number; name: string | null; phone: string | null; wa_id: string | null; last_preview: string | null; waiting_since: number; unread_count: number }
interface TodayT {
  timezone: string; overdue: LeadT[]; due_today: LeadT[]; new: LeadT[]; unanswered: Waiting[]
  counts: { overdue: number; due_today: number; new: number; unanswered: number }
}

function Bucket({ title, count, shown, tone, children }: { title: string; count: number; shown: number; tone?: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="mb-6">
      <h2 className="mb-2 flex items-center gap-2 text-sm font-bold">
        <span className={tone}>{title}</span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{count}</span>
      </h2>
      <div className="overflow-hidden rounded-lg border bg-surface">{children}</div>
      {count > shown && <p className="mt-1 text-xs text-muted-foreground">Showing the first {shown} of {count}.</p>}
    </section>
  )
}

export default function Today() {
  const { state: auth } = useAuth()
  const tz = auth.status === 'in' ? auth.me.timezone : 'UTC'
  const { state, reload } = useLoad<TodayT>('/api/today')
  const { connected, isAdmin } = useConnection()

  if (state.status === 'loading') {
    return (
      <>
        <PageHeader title="Today" subtitle="Follow-ups due and new leads" />
        <div aria-busy="true" aria-label="Loading today" className="space-y-6">
          {[0, 1].map((i) => <div key={i}><Skeleton className="mb-2 h-5 w-32" /><div className="overflow-hidden rounded-lg border bg-surface">{[0, 1, 2].map((j) => <LeadRowSkeleton key={j} />)}</div></div>)}
        </div>
      </>
    )
  }
  if (state.status === 'error') return <><PageHeader title="Today" /><ErrorState message={state.message} onRetry={() => void reload()} /></>
  const t = state.data
  const total = t.counts.overdue + t.counts.due_today + t.counts.new + t.counts.unanswered

  return (
    <>
      <PageHeader title="Today" subtitle="Follow-ups due and new leads" />
      {total === 0 && !connected ? (
        <EmptyState icon={CalendarCheck} title="Connect a WhatsApp number to get started" body={isAdmin ? 'Leads and chats show up here once your number is connected.' : 'Ask an administrator to connect a WhatsApp number. Leads and chats show up here after that.'} action={isAdmin ? <ConnectButton /> : undefined} />
      ) : total === 0 ? (
        <EmptyState icon={CalendarCheck} title="Nothing to follow up yet" body="Nothing is overdue or due today, and there are no new leads or unanswered chats." />
      ) : (
        <>
          {t.overdue.length > 0 && <Bucket title="Overdue" tone="text-danger" count={t.counts.overdue} shown={t.overdue.length}>{t.overdue.map((l) => <LeadRow key={l.id} lead={l} tz={tz} />)}</Bucket>}
          {t.due_today.length > 0 && <Bucket title="Due today" count={t.counts.due_today} shown={t.due_today.length}>{t.due_today.map((l) => <LeadRow key={l.id} lead={l} tz={tz} />)}</Bucket>}
          {t.new.length > 0 && <Bucket title="New leads" count={t.counts.new} shown={t.new.length}>{t.new.map((l) => <LeadRow key={l.id} lead={l} tz={tz} showStage={false} />)}</Bucket>}
          {t.unanswered.length > 0 && (
            <Bucket title="Waiting for a reply" count={t.counts.unanswered} shown={t.unanswered.length}>
              {t.unanswered.map((c) => (
                <Link key={c.contact_id} to={`/inbox/${c.contact_id}`} className="flex min-h-[56px] items-center gap-3 border-b px-4 py-3 hover:bg-muted/60">
                  <MessageSquare aria-hidden className="h-5 w-5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{displayName(c)}</span><span className="block truncate text-sm text-muted-foreground">{c.last_preview}</span></span>
                  <time className="shrink-0 text-xs text-muted-foreground">{shortTime(c.waiting_since)}</time>
                </Link>
              ))}
            </Bucket>
          )}
        </>
      )}
    </>
  )
}
