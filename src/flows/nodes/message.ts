import { interpolate } from '../context'
import type { NodeExecutor } from '../executor'
import { countSubrequest } from '../meter'
import { sendTextToContact } from '../../send'
import { failOrRoute } from './fail'

const MAX_TEXT = 4096

/**
 * Sends a text message to the lead's contact through the one send path (src/send.ts), so the 24 h window, the message
 * row, the live publish and the timing are the same as a human reply. Free text outside the window is refused:
 *   - a connected `window_closed` port takes the run on from there (typically to a template node);
 *   - otherwise the run fails with a readable error.
 * Shadow and dry runs record what would have been sent and send nothing. The message row carries origin `flow:<id>`.
 */
export const messageExecutor: NodeExecutor = async (node, ctx, svc) => {
  const text = interpolate(String((node.data as { text?: unknown }).text ?? ''), ctx).trim().slice(0, MAX_TEXT)
  if (svc.shadow || svc.dryRun) return { port: 'out', status: 'skipped', output: { would: { text }, shadow: true }, note: 'shadow: message not sent' }
  if (!text) return failOrRoute(svc, node, 'empty_message', 'The message came out empty after filling in its values.')

  countSubrequest(svc.meter)
  const r = await sendTextToContact(svc.env, ctx.contact.id, text, { origin: svc.actor, awaitRecord: true, ctx: svc.ctx })
  if (r.ok) return { port: 'out', output: { ok: true, wamid: r.wamid, text, ...(r.queued ? { queued: true } : {}) } }
  if (r.kind === 'refused') {
    if (r.code === 'window_closed') return failOrRoute(svc, node, 'window_closed', 'The 24-hour reply window is closed, so a free-text message cannot be sent. Connect the "window closed" port to a template, or send a template instead.', 'window_closed')
    return failOrRoute(svc, node, r.code, r.message)
  }
  return failOrRoute(svc, node, 'send_failed', r.message)
}
