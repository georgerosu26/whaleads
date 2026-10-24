import { parsePhoneNumberFromString } from 'libphonenumber-js/min'

export interface ConvRow {
  contact_id: number; name: string | null; phone: string | null; wa_id: string | null
  last_preview: string | null; last_message_at: number; last_inbound_at: number | null
  unread_count: number; status: 'open' | 'closed'; assigned_to: number | null; assigned_name: string | null
  window_open: boolean; window_closes_at: number | null
}
export interface InboxList { ok: boolean; inbox: ConvRow[]; next_before: string | null; unread_total: number }
/** Client-only state of a message the user just sent and the server has not confirmed yet (negative temp id). */
export interface LocalSend { state: 'sending' | 'sent' | 'failed'; error?: string; previewUrl?: string }
export interface Msg {
  local?: LocalSend
  id: number; direction: 'in' | 'out'; wamid: string | null; type: string | null; body: string | null
  media_id: string | null; status: string | null; timestamp: number
  media: { status: string; mime: string | null; filename: string | null; size: number | null } | null
}
export interface Thread {
  ok: boolean
  contact: { id: number; name: string | null; phone: string | null; wa_id: string | null; opted_out_at?: number | null; opt_out_source?: string | null }
  messages: Msg[]
  conversation: { unread_count: number; status: 'open' | 'closed'; assigned_to: number | null; assigned_name: string | null } | null
  window_open: boolean; window_closes_at: number | null; has_more: boolean; next_before: number | null
  /** Only on `?after=` polls: current status of the contact's recent outbound messages, for the ticks. */
  statuses?: { id: number; status: string | null }[]
}

/**
 * The send response arrived for the pending bubble `tempId`. Applied inside the state updater, against the newest list:
 * if a poll already brought the real row (same id, or same wamid) - or the send was queued and has no row yet - the
 * pending bubble is dropped; otherwise it is replaced in place by the real message (keeping its position's timestamp).
 */
export function settleSend(msgs: Msg[], tempId: number, real: Msg): Msg[] {
  // Already stored? By wamid, or - a queued send has none yet - by direction, type, body and server time (the same rule mergePoll uses),
  // so a row an event or poll added first can never be shown twice next to the pending bubble.
  const known = real.wamid
    ? msgs.some((x) => x.id > 0 && x.wamid === real.wamid)
    : msgs.some((x) => x.id > 0 && x.direction === 'out' && x.type === real.type && (x.body ?? null) === (real.body ?? null) && Math.abs(x.timestamp - real.timestamp) <= 10)
  if (typeof real.id !== 'number') {
    // The server answered before it had stored the row (respond-before-batch). Keep the bubble, now as sent, until the
    // poll brings the row so nothing flickers away: matched by wamid, or - a queued send has none yet - by contact,
    // body and server time (mergePoll). The server's own timestamp is kept for the queued case so that match is exact.
    if (known) return msgs.filter((m) => m.id !== tempId)
    return msgs.map((m) => (m.id !== tempId ? m : { ...real, id: m.id, timestamp: real.wamid ? m.timestamp : real.timestamp, local: { state: 'sent' as const, previewUrl: m.local?.previewUrl } }))
  }
  const dup = msgs.some((x) => x.id > 0 && (x.id === real.id || known))
  return msgs.flatMap((m) => (m.id !== tempId ? [m] : dup ? [] : [{ ...real, timestamp: m.timestamp }]))
}

/** A thread poll brought `fresh` rows: a row whose wamid belongs to a kept-until-confirmed bubble replaces it in place; the rest append. */
export function mergePoll(msgs: Msg[], fresh: Msg[]): Msg[] {
  const have = new Set(msgs.map((m) => m.id))
  let out = msgs
  const add: Msg[] = []
  for (const f of fresh) {
    if (have.has(f.id)) continue
    const i = out.findIndex((m) => m.local?.state === 'sent' && (f.wamid
      ? m.wamid === f.wamid
      : !m.wamid && f.direction === 'out' && m.type === f.type && (m.body ?? null) === (f.body ?? null) && Math.abs(m.timestamp - f.timestamp) <= 10))
    if (i >= 0) out = out.map((m, j) => (j === i ? f : m))
    else add.push(f)
  }
  return add.length ? [...out, ...add] : out
}

/**
 * A quiet list refresh: the fresh first page, then every previously loaded row that is not in it, in its old order.
 * A row that slid below the first page therefore stays (further down) instead of vanishing until a reload.
 */
export function mergeFirstPage(old: ConvRow[], fresh: ConvRow[]): ConvRow[] {
  const head = new Set(fresh.map((c) => c.contact_id))
  return [...fresh, ...old.filter((c) => !head.has(c.contact_id))]
}

/** International display for stored E.164 digits; falls back to "+digits". */
export function showPhone(digits: string | null | undefined): string {
  if (!digits) return ''
  return parsePhoneNumberFromString('+' + digits)?.formatInternational() ?? '+' + digits
}
export const displayName = (c: { name: string | null; phone: string | null; wa_id: string | null }) =>
  c.name?.trim() || showPhone(c.phone ?? c.wa_id) || 'Unknown'

export function shortTime(ts: number, now = Date.now()): string {
  const d = new Date(ts * 1000)
  const n = new Date(now)
  if (d.toDateString() === n.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const days = Math.floor((now - ts * 1000) / 86_400_000)
  if (days < 7) return d.toLocaleDateString([], { weekday: 'short' })
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' })
}
export const clock = (ts: number) => new Date(ts * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
export const dayLabel = (ts: number) => new Date(ts * 1000).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })

/** "3h 20m" until the window closes. */
export function untilClose(closesAt: number, now = Date.now()): string {
  const s = Math.max(0, closesAt - Math.floor(now / 1000))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60)
  return h ? `${h}h ${m}m` : `${m}m`
}
