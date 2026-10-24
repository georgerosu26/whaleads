// contact, destination and 24h-window check shared by every outbound free-text/media route.
import type { Env } from './db'
import { windowState } from './conversations'
import { CONFIG_VERSION_SQL } from './adaptors'

const body = (data: unknown, status: number) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

export interface Target { dest: string; /** CONFIG_VERSION_SQL of the stored adaptor config, for resolveActiveCached. */ cfgVersion: string | null }

/** `ignoreWindow`: template sends are the one message type WhatsApp allows with the 24h window closed. */
async function lookup(env: Env, id: number, ignoreWindow = false): Promise<Target | Response> {
  // One round trip for everything the send needs before it calls the gateway: contact, window, config version.
  const c = await env.DB.prepare(
    `SELECT c.wa_id, c.phone, v.last_inbound_at, ${CONFIG_VERSION_SQL} AS cfg_version
       FROM contacts c LEFT JOIN conversations v ON v.contact_id = c.id WHERE c.id=?`,
  ).bind(id).first<{ wa_id: string | null; phone: string | null; last_inbound_at: number | null; cfg_version: string | null }>()
  const dest = c?.wa_id ?? c?.phone
  if (!c || !dest) return body({ ok: false, error: 'contact not found' }, 404)
  if (!ignoreWindow && !windowState(c.last_inbound_at).window_open) return windowClosed()
  return { dest, cfgVersion: c.cfg_version }
}

// The inbox send routes start this read in parallel with the session lookup (index.ts), so the two round trips overlap.
// The result is only ever consumed after the auth gate has passed; for a refused request it is simply dropped.
const early = new WeakMap<Request, Promise<Target | Response>>()
export function prefetchTarget(req: Request, env: Env, id: number, ignoreWindow = false): void {
  const p = lookup(env, id, ignoreWindow)
  p.catch(() => {})
  early.set(req, p)
}

/** A Response means the send is refused (404 no contact, 409 window_closed). */
export function sendTarget(env: Env, id: number, req?: Request, ignoreWindow = false): Promise<Target | Response> {
  return (req && early.get(req)) || lookup(env, id, ignoreWindow)
}

export const windowClosed = () =>
  body({ ok: false, error: 'window_closed', message: 'The 24-hour reply window is closed. Only an approved template can start a conversation.' }, 409)
