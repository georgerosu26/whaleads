import { Link } from 'react-router-dom'
import { ArrowRightLeft, ClipboardList, Megaphone, MessageSquarePlus, Phone, Plus, StickyNote, Workflow, Tag as TagIcon, UserRound, type LucideIcon } from 'lucide-react'
import { safeUrl, whenLabel, type ActivityT } from '@/lib/crm'

const OUTCOME: Record<string, string> = { answered: 'Answered', no_answer: 'No answer', busy: 'Busy', voicemail: 'Voicemail', wrong_number: 'Wrong number' }

function describe(a: ActivityT, tz: string, who: (id: number | null) => string, stage: (k: string) => string): { icon: LucideIcon; text: string; body?: string } {
  const d = a.data ?? {}
  switch (a.kind) {
    case 'lead_created': return { icon: Plus, text: `Lead created (${d.source ?? 'manual'})` }
    case 'stage_changed': return { icon: ArrowRightLeft, text: `${d.reopened ? 'Reopened: ' : ''}${stage(d.from)} to ${stage(d.to)}`, body: d.lost_reason ? `Reason: ${d.lost_reason}` : undefined }
    case 'assigned': return { icon: UserRound, text: d.to ? `Assigned to ${who(d.to)}` : 'Unassigned' }
    case 'next_action': return { icon: ClipboardList, text: d.to ? `Next action set for ${whenLabel(d.to, tz)}` : 'Next action cleared' }
    case 'tag_added': return { icon: TagIcon, text: `Tag added: ${d.label ?? ''}` }
    case 'tag_removed': return { icon: TagIcon, text: `Tag removed: ${d.label ?? ''}` }
    case 'note': return { icon: StickyNote, text: 'Note', body: d.text }
    case 'call': return { icon: Phone, text: `Call: ${OUTCOME[d.outcome] ?? d.outcome}${d.duration_s ? `, ${Math.round(d.duration_s / 60) || 1} min` : ''}`, body: d.note }
    case 'flow_run': {
      const st: Record<string, string> = { running: 'started', awaiting: 'is waiting', completed: 'finished', failed: 'failed', abandoned: 'was abandoned', cancelled: 'was cancelled' }
      return { icon: Workflow, text: `${d.shadow ? 'Shadow run: ' : 'Automation: '}${d.flow ?? 'flow'} ${st[d.status] ?? d.status ?? ''}`.trim() }
    }
    case 'referral': return { icon: Megaphone, text: `Ad click${d.headline ? `: ${d.headline}` : d.ref_code ? ` (ref ${d.ref_code})` : ''}` }
    case 'contact_updated': return { icon: UserRound, text: `Contact updated (${Object.keys(d).join(', ')})` }
    default: return { icon: MessageSquarePlus, text: a.kind.replace(/_/g, ' ') }
  }
}

export function EventTimeline({ items, tz, owners, stages, messagesTo }: {
  items: ActivityT[]; tz: string; owners: { id: number; name: string }[]; stages: { key: string; label: string }[]; messagesTo?: string
}) {
  const who = (id: number | null) => owners.find((o) => o.id === id)?.name ?? 'someone'
  const stage = (k: string) => stages.find((s) => s.key === k)?.label ?? k
  if (!items.length) return <p className="py-6 text-center text-sm text-muted-foreground">No activity yet.</p>
  return (
    <ol className="space-y-3" aria-label="Activity">
      {items.map((a) => {
        const { icon: Icon, text, body } = describe(a, tz, who, stage)
        const link = a.kind === 'referral' ? safeUrl(a.data?.source_url) : null
        return (
          <li key={a.id} className="flex gap-3">
            <span aria-hidden className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"><Icon className="h-4 w-4" /></span>
            <div className="min-w-0 flex-1">
              <p className="break-words text-sm font-semibold">{text}</p>
              {body && <p className="mt-0.5 whitespace-pre-wrap break-words text-sm">{body}</p>}
              {link && <a href={link} target="_blank" rel="noopener noreferrer" className="block truncate text-xs text-accent underline">{link}</a>}
              <p className="text-xs text-muted-foreground">{a.actor_name ?? (a.actor === 'system' ? 'System' : a.actor === 'api' ? 'API' : 'Staff')} · {whenLabel(a.created_at, tz)}</p>
            </div>
          </li>
        )
      })}
      {messagesTo && <li className="text-center"><Link to={messagesTo} className="text-sm font-semibold text-accent">Open the conversation</Link></li>}
    </ol>
  )
}
