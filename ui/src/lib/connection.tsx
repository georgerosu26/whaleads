import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { api } from './api'
import type { Me } from './auth'

interface Conn { connected: boolean; isAdmin: boolean }
const Ctx = createContext<Conn>({ connected: true, isAdmin: false })

/** Whether a WhatsApp number is configured. Seeded from /me; re-checked on route change while it is false (and right after leaving settings/whatsapp). */
export function ConnectionProvider({ me, children }: { me: Me; children: ReactNode }) {
  const [connected, setConnected] = useState(me.whatsapp_connected !== false)
  const path = useLocation().pathname
  const prev = useRef(path)
  const check = useCallback(async () => {
    try { setConnected((await api<Me>('/api/auth/me')).whatsapp_connected !== false) } catch { /* keep the last known value */ }
  }, [])
  useEffect(() => {
    const left = prev.current !== path && prev.current === '/settings/whatsapp'
    prev.current = path
    if (!connected || left) void check()
  }, [path]) // eslint-disable-line react-hooks/exhaustive-deps
  return <Ctx.Provider value={{ connected, isAdmin: me.staff.role === 'admin' }}>{children}</Ctx.Provider>
}

export const useConnection = () => useContext(Ctx)
