// POST /api/send-otp: the one path that sends an AUTHENTICATION (one-time code) template. API-only by design (PLAN-S9 A1):
// the caller is the ADMIN_KEY bearer (checked by the route), never the inbox, a flow or a broadcast. Rules:
//   - an unknown number creates no contact and no lead; a known contact gets a message row whose body is "[one-time code]"
//   - 5 sends per destination per 10 minutes (anti OTP pumping); the 30/min deployment-wide cap is the ROUTE_LIMITS row
//   - the code is never logged, never stored, never put in an event
import type { Env } from './db'
import { resolveActive } from './adaptors'
import type { AdaptorResult } from './adaptors/types'
import { deferRecord, outboundConversation, outboundMessageInsert, previewOf } from './conversations'
import { publishMessage } from './live'
import { toWaDigits } from './phone'
import { hit } from './ratelimit'
import { loadSendableTemplate, queuedId } from './send'
import { phoneCountry } from './settings'
import { OTP_CODE_RE } from './templateRules'

export const OTP_STORED_BODY = '[one-time code]'
export const OTP_DEST_LIMIT = { limit: 5, windowSec: 600 } as const

export type OtpResult =
  | { ok: true; wamid: string | null; queued: string | null }
  | { ok: false; kind: 'bad_request'; status: 400 | 404 | 422 | 503; error: string; message: string; field?: string }
  | { ok: false; kind: 'rate_limited' }
  | { ok: false; kind: 'upstream'; result: AdaptorResult }

const bad = (status: 400 | 404 | 422 | 503, error: string, message: string, field?: string): OtpResult => ({ ok: false, kind: 'bad_request', status, error, message, field })

export async function sendOtp(env: Env, b: Record<string, any>, ctx?: Pick<ExecutionContext, 'waitUntil'>): Promise<OtpResult> {
  const code = typeof b.code === 'string' ? b.code : ''
  if (!OTP_CODE_RE.test(code)) return bad(400, 'invalid_code', 'code must be 1 to 15 letters, digits or dashes.', 'code')

  // destination: an existing contact (contact_id, or a match on the number) or a bare number. Never creates a contact.
  let contactId: number | null = null
  let dest: string | null = null
  if (b.contact_id !== undefined && b.contact_id !== null && b.contact_id !== '') {
    const id = Number(b.contact_id)
    const c = Number.isInteger(id) && id > 0 ? await env.DB.prepare(`SELECT id, wa_id, phone FROM contacts WHERE id=?`).bind(id).first<{ id: number; wa_id: string | null; phone: string | null }>() : null
    dest = c ? c.wa_id ?? c.phone : null
    if (!c || !dest) return bad(404, 'contact_not_found', 'No contact with that id.', 'contact_id')
    contactId = c.id
  } else if (b.to !== undefined && b.to !== null && b.to !== '') {
    dest = toWaDigits(b.to, await phoneCountry(env))
    if (!dest) return bad(400, 'invalid_to', 'to is not a valid phone number.', 'to')
    const c = await env.DB.prepare(`SELECT id FROM contacts WHERE wa_id=?1 OR phone=?1 LIMIT 1`).bind(dest).first<{ id: number }>()
    contactId = c?.id ?? null
  } else return bad(400, 'destination_required', 'Send to or contact_id.', 'to')

  const tpl = await loadSendableTemplate(env, { id: b.template_id, name: b.name, language: b.language }, true)
  if (!tpl.ok) return bad(tpl.code === 'template_not_found' ? 404 : 422, tpl.code, tpl.message, 'template_id')
  const t = tpl.template

  const active = await resolveActive(env)
  if (!active) return bad(503, 'no_adaptor', 'no WhatsApp adaptor configured')

  if (await hit(env.DB, `otp:${dest}`, OTP_DEST_LIMIT.limit, OTP_DEST_LIMIT.windowSec)) return { ok: false, kind: 'rate_limited' }

  const r = await active.adaptor.sendTemplate(dest, t.name, t.language, [code], undefined, [{ index: 0, sub_type: 'url', text: code }])
  if (!r.ok) return { ok: false, kind: 'upstream', result: r }

  const now = Math.floor(Date.now() / 1000)
  if (contactId !== null) {
    const cid = contactId, wamid = r.wamid
    await deferRecord(env, ctx, { wamid, contact_id: cid, type: 'template', body: OTP_STORED_BODY, media_id: null, ts: now, origin: 'otp' }, async () => {
      const res = await env.DB.batch([
        outboundMessageInsert(env.DB, cid, wamid, 'template', OTP_STORED_BODY, null, now, 'otp'),
        outboundConversation(env.DB, cid, now, previewOf('template', OTP_STORED_BODY)), // no firstResponse: a code is not a human reply
      ])
      if (res[0]?.meta.changes) publishMessage(env, ctx, cid, { id: res[0].meta.last_row_id as number })
    })
  }
  return { ok: true, wamid: r.wamid, queued: queuedId(r) }
}
