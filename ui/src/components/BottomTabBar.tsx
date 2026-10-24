import { LogOut } from 'lucide-react'
import { NavLink } from 'react-router-dom'
import { useAuth } from '@/lib/auth'
import { useUnread } from '@/lib/unread'
import { cn } from '@/lib/utils'
import { NAV } from './nav'

export function BottomTabBar() {
  const { logout } = useAuth()
  const { unread } = useUnread()
  const tab = 'flex min-h-[48px] flex-1 flex-col items-center justify-center gap-0.5 text-xs font-semibold'
  return (
    <nav className="pb-safe fixed inset-x-0 bottom-0 z-20 flex border-t bg-surface md:hidden" aria-label="Main">
      {NAV.filter((n) => !n.desktopOnly).map((n) => (
        <NavLink key={n.to} to={n.to} end={n.match !== 'prefix'} className={({ isActive }) => cn(tab, isActive ? 'text-accent' : 'text-muted-foreground')}>
          <span className="relative"><n.icon aria-hidden className="h-5 w-5" />{n.badge && unread > 0 && <span data-testid="unread-badge" aria-label={`${unread} unread`} className="absolute -right-3 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-accent-foreground">{unread > 99 ? '99+' : unread}</span>}</span>{n.label}
        </NavLink>
      ))}
      <button onClick={() => void logout()} className={cn(tab, 'text-muted-foreground')}><LogOut aria-hidden className="h-5 w-5" />Log out</button>
    </nav>
  )
}
