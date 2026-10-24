import type { Env } from './db'
import { onLeadCreated } from './flows/triggers'
import { resolveActiveCached } from './adaptors'
import { hit } from './ratelimit'
import { notifyLead } from './push'
import { publishLead, publishMessage } from './live' // D20
import { getSettings, phoneCountry } from './settings'
import { toWaDigits } from './phone'
import { windowClosed } from './sendTarget'
import { sendTextToContact } from './send'
import { deferRecord, firstResponse, outboundConversation, outboundMessageInsert, previewOf } from './conversations'

const json = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...extra } })
export { json }

/** Allowed origins come from the `allowed_origins` setting, then the ALLOWED_ORIGINS env var. */
export async function corsHeaders(req: Request, env: Env): Promise<Record<string, string>> {
  const origin = req.headers.get('Origin') ?? ''
  const allowed = (await getSettings(env)).allowed_origins
  if (!origin || !allowed.includes(origin)) return {}
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'Origin',
  }
}

const s = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null
  const t = v.trim().slice(0, max)
  return t || null
}

export async function handleLeadIntake(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const cors = await corsHeaders(req, env)
  if (req.method === 'OPTIONS') return new Response(null, { status: cors['access-control-allow-origin'] ? 204 : 403, headers: cors })
  const origin = req.headers.get('Origin')
  if (origin && !cors['access-control-allow-origin']) return json({ ok: false, error: 'origin not allowed' }, 403)

  let b: any
  try { b = await req.json() } catch { return json({ ok: false, error: 'invalid JSON' }, 400, cors) }
  if (!b || typeof b !== 'object') return json({ ok: false, error: 'invalid body' }, 400, cors)
  if (b.hp) return json({ ok: true, id: 0 }, 200, cors) // honeypot: pretend success, store nothing

  const source = b.source
  if (source !== 'pilot_form' && source !== 'contact_form') return json({ ok: false, error: 'source must be pilot_form or contact_form' }, 400, cors)
  const phone = toWaDigits(b.phone, await phoneCountry(env))
  if (!phone) return json({ ok: false, error: 'valid phone required' }, 400, cors)
  const name = s(b.name, 120)
  if (!name) return json({ ok: false, error: 'name required' }, 400, cors)

  try {
    if (await hit(env.DB, `leads:${req.headers.get('CF-Connecting-IP') ?? 'unknown'}`, 10, 60)) return json({ ok: false, error: 'too many requests' }, 429, cors)
    const email = s(b.email, 200)
    const found = await env.DB.prepare(`SELECT id FROM contacts WHERE wa_id=?1 OR phone=?1 LIMIT 1`).bind(phone).first<{ id: number }>()
    let contactId: number
    if (found) {
      contactId = found.id
      await env.DB.prepare(`UPDATE contacts SET last_seen_at=unixepoch(), name=COALESCE(name,?2), email=COALESCE(email,?3) WHERE id=?1`).bind(contactId, name, email).run()
    } else {
      const r = await env.DB.prepare(`INSERT INTO contacts (phone,name,email,source) VALUES (?,?,?,?)`).bind(phone, name, email, source).run()
      contactId = r.meta.last_row_id as number
    }
    const r = await env.DB.prepare(
      `INSERT INTO leads (contact_id,source,page,message,utm_source,utm_medium,utm_campaign,gclid) VALUES (?,?,?,?,?,?,?,?)`,
    ).bind(contactId, source, s(b.page, 300), s(b.message, 4000), s(b.utm_source, 200), s(b.utm_medium, 200), s(b.utm_campaign, 200), s(b.gclid, 200)).run()
    if (ctx) notifyLead(env, ctx, r.meta.last_row_id as number)
    publishLead(env, ctx, r.meta.last_row_id as number, 'new') // D20
    if (ctx) onLeadCreated(env, ctx, r.meta.last_row_id as number)
    return json({ ok: true, id: r.meta.last_row_id }, 200, cors)
  } catch {
    return json({ ok: false, error: 'could not save' }, 400, cors)
  }
}

// ---- admin reads / send -------------------------------------------------------

export async function listLeads(url: URL, env: Env): Promise<Response> {
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200)
  const { results } = await env.DB.prepare(
    `SELECT l.*, c.name, c.phone, c.email FROM leads l JOIN contacts c ON c.id=l.contact_id ORDER BY l.created_at DESC, l.id DESC LIMIT ?`,
  ).bind(limit).all()
  return json({ ok: true, leads: results })
}

export async function send(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  let b: any
  try { b = await req.json() } catch { return json({ ok: false, error: 'invalid JSON' }, 400) }
  const text = s(b?.text, 4000)
  if (!text) return json({ ok: false, error: 'text required' }, 400)
  // same 24h window rule as the inbox composer. A number we have never heard from has no open window.
  let contactId: number | null = b.contact_id ? Number(b.contact_id) : null
  if (!contactId && b.to) {
    const to = toWaDigits(b.to, await phoneCountry(env))
    if (!to) return json({ ok: false, error: 'invalid to' }, 400)
    const c = await env.DB.prepare(`SELECT id FROM contacts WHERE wa_id=?1 OR phone=?1 LIMIT 1`).bind(to).first<{ id: number }>()
    if (!c) return windowClosed()
    contactId = c.id
  }
  if (!contactId) return json({ ok: false, error: 'contact not found' }, 404)
  const out = await sendTextToContact(env, contactId, text, { ctx })
  if (!out.ok) {
    if (out.kind === 'refused') return out.response
    const r = out.result
    return json({ ok: false, error: r.error?.message ?? 'send failed', source: r.error?.source, graph: r.error?.error ?? r.data }, 502)
  }
  const wamid = out.wamid
  return json({ ok: true, wamid })
}
