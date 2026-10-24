import { Outlet, useLocation } from 'react-router-dom'
import type { Me } from '@/lib/auth'
import { LiveProvider, useLiveState } from '@/lib/live'
import { UnreadProvider } from '@/lib/unread'
import { BottomTabBar } from './BottomTabBar'
import { Sidebar } from './Sidebar'
import { InstallAppHint } from './InstallAppHint'
import { ConnectBanner } from './ConnectBanner'
import { ConnectionProvider } from '@/lib/connection'

/** The signed-in shell. D20: owns the one live socket for this tab; `data-live` reports its state (open | connecting | closed). */
export function AppShell({ me }: { me: Me }) {
  return <LiveProvider><ConnectionProvider me={me}><Shell me={me} /></ConnectionProvider></LiveProvider>
}

function Shell({ me }: { me: Me }) {
  const live = useLiveState()
  const path = useLocation().pathname
  const full = path.startsWith('/inbox') || /^\/automations\/\d+/.test(path) // the editor is full-bleed
  return (
    <UnreadProvider>
    <div className="flex h-full" data-live={live}>
      <Sidebar me={me} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-[48px] items-center border-b bg-surface px-4 md:hidden">
          <span className="truncate text-base font-bold">{me.business_name}</span>
        </header>
        <ConnectBanner />
        <InstallAppHint />
        {full
          ? <main className="min-h-0 flex-1 pb-[calc(48px+env(safe-area-inset-bottom))] md:pb-0"><Outlet /></main>
          : <main className="flex-1 overflow-y-auto px-4 pb-24 pt-5 md:px-8 md:pb-8"><div className="mx-auto max-w-5xl"><Outlet /></div></main>}
      </div>
      <BottomTabBar />
    </div>
    </UnreadProvider>
  )
}
