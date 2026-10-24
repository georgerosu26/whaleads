// D20: the live channel in the browser. ONE WebSocket per tab to GET /api/live, opened after login.
// While it is OPEN, the screens drop to a slow safety poll and take their updates from events; while it is not
// (connecting, blocked, server down) the normal 4 s / 10 s / 15 s polling carries everything. Polling is never removed.
import { createContext, createElement, useContext, useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'

export type LiveEventType = 'message.new' | 'message.status' | 'conversation.update' | 'unread.total' | 'lead.new' | 'lead.update' | 'flow.run' | 'flow.updated' | 'broadcast.progress'
export interface LiveEvent { type: LiveEventType; ts: number; data: any }
/** `resync` is client-made: the socket just (re)opened, so anything published while it was down was missed. */
export type LiveSignal = LiveEvent | { type: 'resync'; ts: number; data: null }
export type LiveState = 'connecting' | 'open' | 'closed' | 'off'

export const HEARTBEAT_MS = 25_000
export const PONG_WAIT_MS = 10_000
export const BACKOFF_MIN_MS = 1_000
export const BACKOFF_MAX_MS = 30_000
/** The server closed the socket because the session was revoked (logout, deactivation, password change): never reconnect. */
export const REVOKED_CODE = 4001

/** 1 s doubling to 30 s, with jitter (50-100% of the step) so a restart does not bring every tab back in the same instant. */
export function reconnectDelay(attempt: number, rnd: () => number = Math.random): number {
  const step = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** attempt)
  return Math.round(step * (0.5 + rnd() * 0.5))
}

export class LiveClient {
  private ws: WebSocket | null = null
  private attempt = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private beat: ReturnType<typeof setInterval> | undefined
  private pongTimer: ReturnType<typeof setTimeout> | undefined
  private running = false
  private _state: LiveState = 'off'
  private readonly stateSubs = new Set<() => void>()
  private readonly eventSubs = new Set<(s: LiveSignal) => void>()
  constructor(private readonly url: () => string, private readonly make: (url: string) => WebSocket = (u) => new WebSocket(u)) {}

  get state(): LiveState { return this._state }
  private set(s: LiveState) { if (s !== this._state) { this._state = s; this.stateSubs.forEach((f) => f()) } }
  subscribeState = (f: () => void) => { this.stateSubs.add(f); return () => { this.stateSubs.delete(f) } }
  subscribe(f: (s: LiveSignal) => void) { this.eventSubs.add(f); return () => { this.eventSubs.delete(f) } }
  private emit(s: LiveSignal) { for (const f of this.eventSubs) { try { f(s) } catch { /* one bad consumer must not starve the others */ } } }

  start() { if (this.running) return; this.running = true; this.attempt = 0; this.connect() }
  stop() {
    this.running = false
    clearTimeout(this.timer); this.clearBeat()
    const w = this.ws; this.ws = null
    if (w) { w.onopen = w.onmessage = w.onclose = w.onerror = null; try { w.close(1000) } catch { /* already closed */ } }
    this.set('off')
  }

  private clearBeat() { clearInterval(this.beat); clearTimeout(this.pongTimer); this.beat = this.pongTimer = undefined }

  private connect() {
    if (!this.running) return
    this.set('connecting')
    let w: WebSocket
    try { w = this.make(this.url()) } catch { this.retry(); return }
    this.ws = w
    w.onopen = () => {
      if (this.ws !== w) return
      this.attempt = 0
      this.set('open')
      this.clearBeat()
      this.beat = setInterval(() => {
        try { w.send('ping') } catch { return }
        clearTimeout(this.pongTimer)
        // The runtime answers "pong" even while the hub hibernates. No answer in time: the link is dead, drop it and reconnect.
        this.pongTimer = setTimeout(() => { try { w.close() } catch { /* ignore */ } }, PONG_WAIT_MS)
      }, HEARTBEAT_MS)
      this.emit({ type: 'resync', ts: Date.now(), data: null })
    }
    w.onmessage = (m) => {
      if (this.ws !== w) return
      clearTimeout(this.pongTimer) // any frame proves the link is alive
      if (typeof m.data !== 'string' || m.data === 'pong') return
      let e: LiveEvent
      try { e = JSON.parse(m.data) } catch { return }
      if (e && (e.type as string) === 'revoked') { this.finish(w); return } // sent just before the 4001 close; browsers can take ~2 s to surface the close itself
      if (e && typeof e.type === 'string' && e.type !== ('hello' as string)) this.emit(e)
    }
    w.onerror = () => { /* onclose follows */ }
    w.onclose = (ev?: { code?: number }) => {
      if (this.ws !== w) return
      this.ws = null; this.clearBeat()
      if (ev?.code === REVOKED_CODE) { this.finish(w); return } // polling carries on and meets the 401
      this.set('closed')
      this.retry()
    }
  }

  /** The session behind this socket was revoked: stop for good (no reconnect). */
  private finish(w: WebSocket) {
    this.running = false; clearTimeout(this.timer); this.clearBeat()
    if (this.ws === w) this.ws = null
    w.onopen = w.onmessage = w.onclose = w.onerror = null
    try { w.close(1000) } catch { /* already closed */ }
    this.set('closed')
  }

  private retry() {
    if (!this.running) return
    this.set('closed')
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.connect(), reconnectDelay(this.attempt++))
  }
}

const defaultUrl = () => `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/live`
const Ctx = createContext<LiveClient | null>(null)

/** Mount once inside the signed-in shell: the socket lives exactly as long as the session UI does. */
export function LiveProvider({ children, client }: { children: ReactNode; client?: LiveClient }) {
  const ref = useRef<LiveClient | null>(null)
  if (!ref.current) ref.current = client ?? new LiveClient(defaultUrl)
  const c = ref.current
  useEffect(() => { c.start(); return () => c.stop() }, [c])
  return createElement(Ctx.Provider, { value: c }, children)
}

const never = new LiveClient(defaultUrl) // outside a provider: never started, state 'off'
/** 'open' only while the socket is attached; everything else means "keep polling". */
export function useLiveState(): LiveState {
  const c = useContext(Ctx) ?? never
  return useSyncExternalStore(c.subscribeState, () => c.state, () => 'off' as LiveState)
}
export const useLiveOpen = () => useLiveState() === 'open'

/** Subscribe to events (and the client-made `resync`). The handler may change every render. */
export function useLiveEvents(handler: (s: LiveSignal) => void): void {
  const c = useContext(Ctx) ?? never
  const h = useRef(handler)
  h.current = handler
  useEffect(() => c.subscribe((s) => h.current(s)), [c])
}
