// GET /api/live (D20): upgrade to the live-channel WebSocket. Runs behind the auth gate in index.ts, so a missing or
// bad session is already a 401 by the time it gets here. The identity the hub sees comes from the VERIFIED session,
// never from anything the client sent.
import type { Actor } from '../auth'
import type { Env } from '../db'
import { json } from '../leads'
import { HUB_NAME } from '../live'

export async function handleLive(req: Request, env: Env, path: string, actor: Actor | null): Promise<Response | null> {
  if (path !== '/api/live') return null
  if (req.method !== 'GET') return json({ ok: false, error: 'method not allowed' }, 405)
  // The ADMIN_KEY is for scripts; the live channel is for a signed-in human's browser.
  if (!actor || actor.kind !== 'staff') return json({ ok: false, error: 'live channel needs a staff session' }, 400)
  // CSRF does not apply to a GET, but a WebSocket handshake is not covered by CORS: another site's page could open it
  // with the visitor's cookie. Browsers always send Origin on the handshake, so it must match this host.
  const origin = req.headers.get('Origin')
  let ok = false
  try { ok = !!origin && new URL(origin).host === new URL(req.url).host } catch { /* malformed */ }
  if (!ok) return json({ ok: false, error: 'origin not allowed' }, 403)
  if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ ok: false, error: 'expected a WebSocket upgrade' }, 426)
  if (!env.LIVE) return json({ ok: false, error: 'live channel not configured' }, 503)

  // A fresh Request to the hub: only the upgrade headers plus the identity set here.
  const fwd = new Request('https://live.internal/connect', {
    headers: { Upgrade: 'websocket', 'x-live-staff': String(actor.staff.id), 'x-live-role': actor.staff.role, 'x-live-sid': actor.sid },
  })
  const res = await env.LIVE.get(env.LIVE.idFromName(HUB_NAME)).fetch(fwd)
  if (res.status !== 101 || !res.webSocket) return res
  // A slid session still gets its cookie renewed (withRenewedCookie would rebuild the Response and could drop the socket).
  return actor.renew ? new Response(null, { status: 101, webSocket: res.webSocket, headers: { 'set-cookie': actor.renew } }) : res
}
