// D20: publishing to the live channel. Every publisher is best effort and OFF the request's critical path:
// it runs inside ctx.waitUntil, after the D1 write succeeded, and can never fail or slow a webhook, a send or a CRM
// update. A deployment without the LIVE binding (or any DO failure) just means the browsers keep polling.
import type { Env } from './db'
import { logEvent } from './db'
import { windowState } from './conversations'

export type LiveEventType = 'message.new' | 'message.status' | 'conversation.update' | 'unread.total' | 'lead.new' | 'lead.update' | 'flow.run' | 'flow.updated' | 'broadcast.progress'
export interface LiveEvent { type: LiveEventType; ts: number; data: Record<string, unknown> }

/** One hub per deployment. */
export const HUB_NAME = 'hub'

const ev = (type: LiveEventType, data: Record<string, unknown>): LiveEvent => ({ type, ts: Date.now(), data })
type Waiter = Pick<ExecutionContext, 'waitUntil'> | undefined

/** Send already-built events to the hub. Resolves to the number of sockets reached; never throws. */
export async function publish(env: Env, events: LiveEvent[]): Promise<number> {
  if (!env.LIVE || !events.length) return 0
  try {
    const stub = env.LIVE.get(env.LIVE.idFromName(HUB_NAME))
    return await stub.broadcast(events.map((e) => JSON.stringify(e)))
  } catch (e) {
    await logEvent(env.DB, 'live_publish_error', { types: events.map((x) => x.type), error: String(e) })
    return 0
  }
}

/** Run `build` (which may read D1) and publish what it returns, after the response. Never throws, never blocks the caller. */
export function publishLater(env: Env, ctx: Waiter, build: () => Promise<LiveEvent[]>): void {
  if (!env.LIVE) return
  const job = (async () => {
    try { await publish(env, await build()) } catch (e) { await logEvent(env.DB, 'live_publish_error', { error: String(e) }) }
  })()
  if (ctx) ctx.waitUntil(job); else void job
}

export interface RevokeSelector { staff?: number; sid?: string; exceptSid?: string }
/** Close live sockets whose session was just revoked (logout, deactivation, password change/reset). Best effort, off the request path. */
export function revokeLive(env: Env, ctx: Waiter, sel: RevokeSelector): void {
  if (!env.LIVE) return
  const job = (async () => {
    try { await env.LIVE!.get(env.LIVE!.idFromName(HUB_NAME)).revoke(sel) } catch (e) { await logEvent(env.DB, 'live_publish_error', { revoke: sel.staff ?? 'sid', error: String(e) }).catch(() => {}) }
  })()
  if (ctx) ctx.waitUntil(job); else void job
}

async function unreadCount(env: Env): Promise<number> {
  return (await env.DB.prepare(`SELECT COUNT(*) AS n FROM conversations WHERE unread_count > 0`).first<{ n: number }>())?.n ?? 0
}

/** The conversation row as the inbox list shows it. Null when the contact has no conversation. */
export async function conversationData(env: Env, contactId: number): Promise<Record<string, unknown> | null> {
  const r = await env.DB.prepare(
    `SELECT v.contact_id, c.name, c.phone, c.wa_id, v.last_preview, v.last_message_at, v.last_inbound_at, v.unread_count, v.status, v.assigned_to, s.name AS assigned_name
       FROM conversations v JOIN contacts c ON c.id = v.contact_id LEFT JOIN staff s ON s.id = v.assigned_to WHERE v.contact_id = ?`,
  ).bind(contactId).first<Record<string, any>>()
  if (!r) return null
  return { ...r, ...windowState(r.last_inbound_at), last_body: r.last_preview, last_at: r.last_message_at }
}

/** The message row in the shape of GET /api/contacts/:id/messages. Looked up by row id or by wamid. */
export async function messageData(env: Env, by: { id: number } | { wamid: string }): Promise<Record<string, unknown> | null> {
  const where = 'id' in by ? 'm.id = ?' : 'm.wamid = ?'
  const r = await env.DB.prepare(
    `SELECT m.id, m.contact_id, m.direction, m.wamid, m.type, m.body, m.media_id, m.status, m.timestamp,
            d.status AS media_status, d.mime AS media_mime, d.filename AS media_filename, d.size AS media_size
       FROM messages m LEFT JOIN media d ON d.message_id = m.id WHERE ${where}`,
  ).bind('id' in by ? by.id : by.wamid).first<Record<string, any>>()
  if (!r) return null
  const { media_status, media_mime, media_filename, media_size, ...m } = r
  return { ...m, media: media_status ? { status: media_status, mime: media_mime, filename: media_filename, size: media_size } : null }
}

/**
 * A message was stored (inbound webhook or outbound send): message.new, then the conversation it moved, then the badge.
 * `by` finds the row after the write, so the event always carries what D1 now holds.
 */
export function publishMessage(env: Env, ctx: Waiter, contactId: number, by: { id: number } | { wamid: string }, newLeadId?: number): void {
  publishLater(env, ctx, async () => {
    const [m, conv, unread, lead] = await Promise.all([messageData(env, by), conversationData(env, contactId), unreadCount(env), newLeadId ? leadEvent(env, newLeadId, 'new') : null])
    return [
      ...(m ? [ev('message.new', { contact_id: contactId, message: m })] : []),
      ...(conv ? [ev('conversation.update', conv)] : []),
      ev('unread.total', { unread }),
      ...(lead ? [lead] : []),
    ]
  })
}

/** Read / assign / close changed the conversation row (and maybe the badge). */
export function publishConversation(env: Env, ctx: Waiter, contactId: number): void {
  publishLater(env, ctx, async () => {
    const [conv, unread] = await Promise.all([conversationData(env, contactId), unreadCount(env)])
    return [...(conv ? [ev('conversation.update', conv)] : []), ev('unread.total', { unread })]
  })
}

/** A delivery receipt moved a message. Carries the status D1 holds now, which is never behind what the webhook said. */
export function publishMessageStatus(env: Env, ctx: Waiter, wamid: string): void {
  publishLater(env, ctx, async () => {
    const r = await env.DB.prepare(`SELECT id, contact_id, status FROM messages WHERE wamid = ?`).bind(wamid).first<{ id: number; contact_id: number; status: string | null }>()
    return r ? [ev('message.status', { contact_id: r.contact_id, id: r.id, wamid, status: r.status })] : []
  })
}

/** A lead was created (`new`) or its stage/owner changed (`update`). */
export function publishLead(env: Env, ctx: Waiter, leadId: number, kind: 'new' | 'update'): void {
  publishLater(env, ctx, async () => {
    const e = await leadEvent(env, leadId, kind)
    return e ? [e] : []
  })
}

async function leadEvent(env: Env, leadId: number, kind: 'new' | 'update'): Promise<LiveEvent | null> {
  const r = await env.DB.prepare(`SELECT id, contact_id, status, assigned_to, source FROM leads WHERE id = ?`).bind(leadId).first<Record<string, any>>()
  if (!r) return null
  return ev(kind === 'new' ? 'lead.new' : 'lead.update', { id: r.id, contact_id: r.contact_id, status: r.status, owner: r.assigned_to, source: r.source })
}

/** a flow run started, parked, finished or failed. The frame carries what the UI needs without a lookup. */
export interface FlowRunFrame { run_id: number; flow_id: number; flow: string; lead_id: number; status: string; shadow: boolean; node: string | null }
export function publishFlowRun(env: Env, ctx: Waiter, frames: FlowRunFrame[]): void {
  publishLater(env, ctx, async () => frames.map((f) => ev('flow.run', { ...f })))
}

/** a flow was published, paused or archived, so an open canvas or list can refresh. */
export function publishFlowUpdated(env: Env, ctx: Waiter, f: { flow_id: number; name: string; status: string; version: number }): void {
  publishLater(env, ctx, async () => [ev('flow.updated', { ...f })])
}
