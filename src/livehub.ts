// D20: the live channel. ONE SQLite-backed Durable Object per deployment (idFromName('hub')) fans events out to
// the staff browsers that have a WebSocket open. It holds no data: no messages, no SQL, nothing to migrate.
// Hibernation API: sockets are accepted with ctx.acceptWebSocket, so an idle hub is evicted from memory and costs
// nothing; the keep-alive "ping" is answered by the runtime (setWebSocketAutoResponse) without waking it.
import { DurableObject } from 'cloudflare:workers'
import type { Env } from './db'

/** Sockets older than this are closed so a revoked session cannot stay connected; the browser reconnects through the auth gate. */
export const MAX_SOCKET_AGE_MS = 12 * 3600 * 1000
/** Hard cap on simultaneous sockets (5 staff x a few tabs). The oldest goes first. */
export const MAX_SOCKETS = 100

/** Close code the browser treats as final: the session behind the socket was revoked. */
export const REVOKED_CODE = 4001

export interface SocketMeta { staff: number; role: string; at: number }

export class LiveHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // Keep-alive without waking the object: the browser sends "ping", the runtime answers "pong".
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  /** Only reachable from the Worker (the binding is the sole way in). The Worker has authenticated the caller and sets the identity headers. */
  async fetch(req: Request): Promise<Response> {
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('expected a WebSocket upgrade', { status: 426 })
    const staff = Number(req.headers.get('x-live-staff'))
    if (!Number.isInteger(staff) || staff <= 0) return new Response('missing identity', { status: 400 })
    const live = this.ctx.getWebSockets()
    if (live.length >= MAX_SOCKETS) {
      const oldest = live.reduce((a, b) => ((a.deserializeAttachment() as SocketMeta | null)?.at ?? 0) <= ((b.deserializeAttachment() as SocketMeta | null)?.at ?? 0) ? a : b)
      try { oldest.close(1008, 'too many connections') } catch { /* already gone */ }
    }
    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    const sid = req.headers.get('x-live-sid')
    this.ctx.acceptWebSocket(server, [`staff:${staff}`, ...(sid ? [`sid:${sid}`] : [])])
    const meta: SocketMeta = { staff, role: req.headers.get('x-live-role') ?? 'staff', at: Date.now() }
    server.serializeAttachment(meta)
    // First frame: lets the browser know the stream is really attached (and which server clock to expect).
    server.send(JSON.stringify({ type: 'hello', ts: Date.now(), data: {} }))
    return new Response(null, { status: 101, webSocket: client })
  }

  /**
   * RPC from the Worker when a session is revoked: closes the matching sockets with 4001 so a deactivated or logged-out
   * person stops receiving events at once. `staff` closes all of that person's sockets (except `exceptSid`); `sid` one session's.
   */
  async revoke(sel: { staff?: number; sid?: string; exceptSid?: string }): Promise<number> {
    const tag = sel.sid ? `sid:${sel.sid}` : sel.staff ? `staff:${sel.staff}` : null
    if (!tag) return 0
    let n = 0
    for (const ws of this.ctx.getWebSockets(tag)) {
      if (sel.exceptSid && this.ctx.getTags(ws).includes(`sid:${sel.exceptSid}`)) continue
      try { ws.send(JSON.stringify({ type: 'revoked', ts: Date.now(), data: {} })) } catch { /* gone */ } // lets the browser stop at once
      try { ws.close(REVOKED_CODE, 'revoked') } catch { /* already gone */ }
      n++
    }
    return n
  }

  /** RPC from the Worker's publisher. `frames` are already-serialised events; returns how many sockets got them. */
  async broadcast(frames: string[]): Promise<number> {
    let sent = 0
    const now = Date.now()
    for (const ws of this.ctx.getWebSockets()) {
      const meta = ws.deserializeAttachment() as SocketMeta | null
      if (meta && now - meta.at > MAX_SOCKET_AGE_MS) { try { ws.close(1008, 'session age') } catch { /* gone */ } continue }
      try { for (const f of frames) ws.send(f); sent++ } catch { try { ws.close(1011, 'send failed') } catch { /* gone */ } }
    }
    return sent
  }

  // The browser only sends "ping" (auto-answered). Anything else is ignored: the channel is server -> browser only.
  webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): void {}
  webSocketClose(ws: WebSocket, code: number): void {
    // 1005/1006 are not valid to send back; close with a normal code.
    try { ws.close(code === 1005 || code === 1006 || code < 1000 ? 1000 : code, 'bye') } catch { /* already closed */ }
  }
  webSocketError(ws: WebSocket): void { try { ws.close(1011, 'error') } catch { /* already closed */ } }
}
