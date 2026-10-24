import { BarChart3, Megaphone, Workflow, Building2, Bot, Database, FileText, ChevronRight, ClipboardList, KanbanSquare, MessageCircle, Zap, UserCircle, Users } from 'lucide-react'
import { Link } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { useAuth } from '@/lib/auth'

const SECTIONS = [
  { to: '/automations', label: 'Automations', body: 'Flows that reply and route leads for you', icon: Workflow, admin: false },
  { to: '/broadcasts', label: 'Broadcasts', body: 'Send a template to a group of contacts', icon: Megaphone, admin: false },
  { to: '/reports', label: 'Reports', body: 'Leads, sources, response times, messages', icon: BarChart3, admin: false },
  { to: '/settings/data', label: 'Data', body: 'Export leads, import a CSV', icon: Database, admin: true },
  { to: '/settings/business', label: 'Business', body: 'Name, country, timezone, working hours', icon: Building2, admin: true },
  { to: '/settings/team', label: 'Team', body: 'Add staff, roles, password resets', icon: Users, admin: true },
  { to: '/settings/pipeline', label: 'Pipeline', body: 'Stages, sources and tags', icon: KanbanSquare, admin: true },
  { to: '/settings/forms', label: 'Lead forms', body: 'Allowed websites and the intake endpoint', icon: ClipboardList, admin: true },
  { to: '/settings/whatsapp', label: 'WhatsApp', body: 'Connect to WhaBuzz or the Cloud API', icon: MessageCircle, admin: true },
  { to: '/settings/ai', label: 'AI', body: 'Optional Anthropic key', icon: Bot, admin: true },
  { to: '/settings/quick-replies', label: 'Quick replies', body: 'Saved answers for the composer', icon: Zap, admin: false },
  { to: '/settings/templates', label: 'Templates', body: 'Approved messages for outside the 24 hour window', icon: FileText, admin: false },
  { to: '/settings/profile', label: 'My profile', body: 'Name, password, theme', icon: UserCircle, admin: false },
]

export default function SettingsHome() {
  const { state } = useAuth()
  const isAdmin = state.status === 'in' && state.me.staff.role === 'admin'
  const items = SECTIONS.filter((s) => isAdmin || !s.admin)
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="Settings" subtitle={isAdmin ? undefined : 'Your account'} />
      <ul className="divide-y rounded-lg border bg-surface">
        {items.map((s) => (
          <li key={s.to}>
            <Link to={s.to} className="flex min-h-[56px] items-center gap-3 px-4 py-3 hover:bg-muted">
              <s.icon aria-hidden className="h-5 w-5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1"><span className="block truncate text-base font-semibold">{s.label}</span><span className="block truncate text-xs text-muted-foreground">{s.body}</span></span>
              <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
