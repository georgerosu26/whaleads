import { LogOut } from 'lucide-react'
import { NavLink } from 'react-router-dom'
import { useAuth, type Me } from '@/lib/auth'
import { useUnread } from '@/lib/unread'
import { cn } from '@/lib/utils'
import { NAV } from './nav'

export function Sidebar({ me }: { me: Me }) {
  const { logout } = useAuth()
  const { unread } = useUnread()
  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r bg-surface md:flex">
      <div className="truncate px-5 py-5 text-base font-bold" title={me.business_name}>{me.business_name}</div>
      <nav className="flex-1 space-y-1 px-3">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.match !== 'prefix'} className={({ isActive }) => cn('flex min-h-[40px] items-center gap-3 rounded-md px-3 text-sm font-semibold', isActive ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted')}>
            <n.icon aria-hidden className="h-4 w-4" /><span className="flex-1">{n.label}</span>{n.badge && unread > 0 && <span data-testid="unread-badge-side" aria-label={`${unread} unread`} className="flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1.5 text-xs font-bold text-accent-foreground">{unread > 99 ? '99+' : unread}</span>}
          </NavLink>
        ))}
      </nav>
      <div className="border-t p-3">
        <div className="mb-2 min-w-0 px-2"><div className="truncate text-sm font-semibold">{me.staff.name}</div><div className="truncate text-xs text-muted-foreground">{me.staff.email}</div></div>
        <button onClick={() => void logout()} className="flex min-h-[40px] w-full items-center gap-3 rounded-md px-3 text-sm font-semibold text-muted-foreground hover:bg-muted"><LogOut aria-hidden className="h-4 w-4" />Log out</button>
      </div>
    </aside>
  )
}
