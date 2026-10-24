import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { api, ApiError, setCsrf } from './api'
import { claimThisDevice, releaseThisDevice } from './push'

export interface Me {
  staff: { id: number; name: string; email: string; role: 'admin' | 'staff'; must_change_pw: boolean }
  csrf: string
  business_name: string
  default_country: string | null
  timezone: string
  whatsapp_connected?: boolean
}
type State = { status: 'loading' } | { status: 'error'; message: string } | { status: 'anon'; needsSetup: boolean } | { status: 'in'; me: Me }

const Ctx = createContext<{ state: State; reload: () => void; signedIn: (m: Me) => void; refresh: () => Promise<void>; logout: () => Promise<void> } | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: 'loading' })

  const signedIn = useCallback((me: Me) => { setCsrf(me.csrf); setState({ status: 'in', me }); if (!me.staff.must_change_pw) void claimThisDevice() }, [])

  const load = useCallback(async () => {
    setState({ status: 'loading' })
    try {
      signedIn(await api<Me>('/api/auth/me'))
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        try {
          const s = await api<{ needs_setup: boolean }>('/api/setup/status')
          setState({ status: 'anon', needsSetup: s.needs_setup })
        } catch (e2) { setState({ status: 'error', message: (e2 as Error).message }) }
      } else setState({ status: 'error', message: (e as Error).message })
    }
  }, [signedIn])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const h = () => setState((s) => (s.status === 'in' ? { status: 'anon', needsSetup: false } : s))
    window.addEventListener('wl:unauthorized', h)
    return () => window.removeEventListener('wl:unauthorized', h)
  }, [])

  const logout = useCallback(async () => {
    await releaseThisDevice()
    try { await api('/api/auth/logout', { method: 'POST' }) } catch { /* cookie is cleared server-side or already invalid */ }
    setCsrf('')
    setState({ status: 'anon', needsSetup: false })
  }, [])

  // Quiet re-fetch of /me (no boot skeleton) so header name / business name update after a save.
  const refresh = useCallback(async () => { try { signedIn(await api<Me>('/api/auth/me')) } catch { /* keep the current view */ } }, [signedIn])

  return <Ctx.Provider value={{ state, reload: load, signedIn, refresh, logout }}>{children}</Ctx.Provider>
}

export function useAuth() {
  const c = useContext(Ctx)
  if (!c) throw new Error('useAuth outside AuthProvider')
  return c
}
