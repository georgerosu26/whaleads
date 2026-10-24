// Browser side of Web Push: capability checks, subscribe/unsubscribe against /api/push/*, and the install prompt.
import { useCallback, useEffect, useState } from 'react'
import { api } from './api'

export type PushState =
  | { kind: 'checking' }
  | { kind: 'unsupported'; reason: 'ios_needs_install' | 'no_support' }
  | { kind: 'denied' }
  | { kind: 'off' }
  | { kind: 'on'; endpoint: string }

export const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
export const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true

const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64url.length % 4)) % 4))
  const out = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration('/')
  if (!existing) await navigator.serviceWorker.register('/sw.js')
  return navigator.serviceWorker.ready
}

async function read(): Promise<PushState> {
  if (!supported()) return { kind: 'unsupported', reason: isIos() && !isStandalone() ? 'ios_needs_install' : 'no_support' }
  if (Notification.permission === 'denied') return { kind: 'denied' }
  try {
    const sub = await (await registration()).pushManager.getSubscription()
    return sub && Notification.permission === 'granted' ? { kind: 'on', endpoint: sub.endpoint } : { kind: 'off' }
  } catch { return { kind: 'off' } }
}

/** The browser's current subscription, or null (also null when push is unsupported or anything throws). */
async function currentSub(): Promise<PushSubscription | null> {
  try {
    if (!supported() || Notification.permission !== 'granted') return null
    const reg = await navigator.serviceWorker.getRegistration('/')
    return reg ? await reg.pushManager.getSubscription() : null
  } catch { return null }
}

/** Logout: drop this device's subscription server-side (needs the still-valid session). Best-effort, bounded to 3 s. */
export async function releaseThisDevice(): Promise<void> {
  try {
    await Promise.race([
      (async () => {
        const sub = await currentSub()
        if (sub) await api('/api/push/subscribe', { method: 'DELETE', body: { endpoint: sub.endpoint } })
      })(),
      new Promise((r) => setTimeout(r, 3000)),
    ])
  } catch { /* never block logout */ }
}

/** Sign-in / boot: if this browser is subscribed, re-register it so the server moves the endpoint to the signed-in person. */
export async function claimThisDevice(): Promise<void> {
  try {
    const sub = await currentSub()
    if (sub) await api('/api/push/subscribe', { method: 'POST', body: sub.toJSON() })
  } catch { /* the card still lets them turn it on by hand */ }
}

export function usePush() {
  const [state, setState] = useState<PushState>({ kind: 'checking' })
  const refresh = useCallback(async () => setState(await read()), [])
  useEffect(() => { void refresh() }, [refresh])

  /** Asks permission, subscribes this browser and registers it with the server. Throws a readable Error. */
  const enable = useCallback(async () => {
    const perm = await Notification.requestPermission()
    if (perm !== 'granted') { await refresh(); throw new Error(perm === 'denied' ? 'Notifications are blocked for this site in your browser settings.' : 'Permission was not granted.') }
    const { public_key } = await api<{ public_key: string | null }>('/api/push/vapid')
    if (!public_key) throw new Error('Push is not set up on this server yet.')
    const reg = await registration()
    let sub = await reg.pushManager.getSubscription()
    if (!sub) {
      try { sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(public_key) }) }
      catch { throw new Error('This browser could not subscribe to push. Check your connection and try again.') }
    }
    await api('/api/push/subscribe', { method: 'POST', body: sub.toJSON() })
    await refresh()
  }, [refresh])

  const disable = useCallback(async () => {
    const sub = await (await registration()).pushManager.getSubscription()
    if (sub) {
      await api('/api/push/subscribe', { method: 'DELETE', body: { endpoint: sub.endpoint } })
      await sub.unsubscribe()
    }
    await refresh()
  }, [refresh])

  const test = useCallback(async () => (await api<{ sent: number; devices: number }>('/api/push/test', { method: 'POST', body: {} })), [])
  return { state, enable, disable, test, refresh }
}

// ---- install prompt (Android / desktop Chromium) -------------------------------------------------------------

let deferred: any = null
const listeners = new Set<() => void>()
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; listeners.forEach((f) => f()) })
  window.addEventListener('appinstalled', () => { deferred = null; listeners.forEach((f) => f()) })
}

export function useInstallPrompt() {
  const [, tick] = useState(0)
  useEffect(() => { const f = () => tick((n) => n + 1); listeners.add(f); return () => { listeners.delete(f) } }, [])
  return {
    canPrompt: deferred !== null,
    prompt: async () => { const d = deferred; if (!d) return; deferred = null; await d.prompt(); listeners.forEach((f) => f()) },
  }
}
