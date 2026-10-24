import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api } from './api'
import { useLiveEvents, useLiveOpen } from './live'
import { usePoller } from './poll'

const Ctx = createContext<{ unread: number; refresh: () => void; set: (n: number) => void }>({ unread: 0, refresh: () => {}, set: () => {} })

/**
 * Unread conversation count for the nav badge. Polls every 15 s while the tab is visible (backs off to 30 s on failures)
 * until the live socket is open: then `unread.total` events drive it and the poll is off. A (re)connect refreshes once.
 */
export function UnreadProvider({ children }: { children: ReactNode }) {
  const [unread, set] = useState(0)
  const refresh = useCallback(() => { api<{ unread: number }>('/api/inbox/unread').then((r) => set(r.unread)).catch(() => {}) }, [])
  useEffect(() => { refresh() }, [refresh])
  const live = useLiveOpen()
  usePoller(async () => { set((await api<{ unread: number }>('/api/inbox/unread')).unread) }, 15_000, !live)
  useLiveEvents((s) => {
    if (s.type === 'unread.total' && typeof s.data?.unread === 'number') set(s.data.unread)
    else if (s.type === 'resync') refresh()
  })
  const v = useMemo(() => ({ unread, refresh, set }), [unread, refresh])
  return <Ctx.Provider value={v}>{children}</Ctx.Provider>
}
export const useUnread = () => useContext(Ctx)
