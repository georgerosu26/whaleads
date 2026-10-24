// Parsing of Meta message / status objects into normalised InboundEvents. Shared by the Cloud API
// adaptor (raw Meta POST) and the WhaBuzz adaptor (envelope `data.message` / `data.status`).
import type { InboundEvent, InboundMessage, InboundStatus } from './types'

export function describeMessage(m: any): { type: string; body: string | null; mediaId: string | null } {
  const type = String(m.type ?? 'unknown')
  if (type === 'text') return { type, body: m.text?.body ?? null, mediaId: null }
  const media = m[type]
  if (media && typeof media === 'object' && (media.id || media.caption)) {
    return { type, body: media.caption ? `[${type}] ${media.caption}` : `[${type}]`, mediaId: media.id ?? null }
  }
  if (type === 'button') return { type, body: m.button?.text ?? null, mediaId: null }
  if (type === 'interactive') {
    const i = m.interactive
    return { type, body: i?.button_reply?.title ?? i?.list_reply?.title ?? '[interactive]', mediaId: null }
  }
  return { type, body: `[${type}]`, mediaId: null }
}

const ts = (v: unknown): number => Number(v) || Math.floor(Date.now() / 1000)

export function contactNames(contacts: any): Map<string, string> {
  const names = new Map<string, string>()
  for (const c of Array.isArray(contacts) ? contacts : []) if (c?.wa_id) names.set(String(c.wa_id), c.profile?.name ?? '')
  return names
}

export function messageEvent(m: any, names: Map<string, string>): InboundMessage | null {
  const from = String(m?.from ?? '')
  if (!from || !m?.id) return null
  const d = describeMessage(m)
  return {
    kind: 'message', wamid: String(m.id), from, name: names.get(from) || null,
    type: d.type, body: d.body, media_id: d.mediaId, timestamp: ts(m.timestamp), raw: m,
  }
}

export function statusEvent(s: any): InboundStatus | null {
  if (!s?.id || !s?.status) return null
  return {
    kind: 'status', wamid: String(s.id), status: String(s.status), timestamp: ts(s.timestamp),
    recipient: s.recipient_id ? String(s.recipient_id) : null,
    errors: Array.isArray(s.errors) ? s.errors : null, raw: s,
  }
}

/** A complete Meta POST body (object: whatsapp_business_account). Only `messages` changes matter. */
export function parseMetaBody(body: any): InboundEvent[] {
  const out: InboundEvent[] = []
  for (const entry of body?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'messages') continue
      const v = change.value ?? {}
      const names = contactNames(v.contacts)
      for (const m of v.messages ?? []) {
        const e = messageEvent(m, names)
        if (e) out.push(e)
      }
      for (const s of v.statuses ?? []) {
        const e = statusEvent(s)
        if (e) out.push(e)
      }
    }
  }
  return out
}
