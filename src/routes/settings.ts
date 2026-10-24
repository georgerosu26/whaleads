// GET/PUT/PATCH /api/settings. Any staff may read; only admins write. Secrets are never returned.
import type { Actor } from '../auth'
import { require } from '../auth'
import { isCountryCode } from '../countries'
import type { Env } from '../db'
import { logEvent } from '../db'
import { json } from '../leads'
import { anthropicKeyInfo, getBroadcastPerMinute, getSettings, putSetting, setAnthropicKey } from '../settings'
import { readJson } from './auth'

export const actorId = (a: Actor | null): number | null => (a?.kind === 'staff' ? a.staff.id : null)
const validTimezone = (tz: string) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true } catch { return false } }
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

/** Returns a normalised origin or null. https anywhere; http only for localhost. */
export function normaliseOrigin(s: string): string | null {
  try {
    const u = new URL(s.trim())
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null
    if (u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) return null
    return u.origin
  } catch { return null }
}

function validWorkingHours(v: unknown): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  for (const [k, d] of Object.entries(v)) {
    if (!DAYS.includes(k)) return false
    if (d === null) continue
    const o = d as Record<string, unknown>
    if (typeof o.open !== 'string' || typeof o.close !== 'string' || !HHMM.test(o.open) || !HHMM.test(o.close) || o.open >= o.close) return false
  }
  return true
}

async function view(env: Env, admin: boolean) {
  const s = await getSettings(env)
  return {
    ok: true,
    settings: {
      business_name: s.business_name, default_country: s.default_country, timezone: s.timezone,
      working_hours: s.working_hours, allowed_origins: s.allowed_origins, broadcast_per_minute: await getBroadcastPerMinute(env),
      ...(admin ? { ai: await anthropicKeyInfo(env) } : {}),
    },
    sources: s.sources,
  }
}

async function patch(req: Request, env: Env, actor: Actor | null): Promise<Response> {
  const b = await readJson(req)
  if (!b) return json({ ok: false, error: 'invalid JSON' }, 400)
  const by = actorId(actor)
  const writes: [string, unknown][] = []
  const fail = (error: string, field: string) => json({ ok: false, error, field }, 400)

  if ('business_name' in b) {
    const v = typeof b.business_name === 'string' ? b.business_name.trim() : ''
    if (b.business_name === null) writes.push(['business_name', undefined])
    else if (!v || v.length > 120) return fail('business name must be 1-120 characters', 'business_name')
    else writes.push(['business_name', v])
  }
  if ('default_country' in b) {
    if (b.default_country === null || b.default_country === '') writes.push(['default_country', undefined])
    else {
      const c = typeof b.default_country === 'string' ? b.default_country.trim().toUpperCase() : ''
      if (!isCountryCode(c)) return fail('unknown country', 'default_country')
      writes.push(['default_country', c])
    }
  }
  if ('timezone' in b) {
    if (b.timezone === null) writes.push(['timezone', undefined])
    else if (typeof b.timezone !== 'string' || !validTimezone(b.timezone)) return fail('unknown timezone', 'timezone')
    else writes.push(['timezone', b.timezone])
  }
  if ('working_hours' in b) {
    if (b.working_hours === null) writes.push(['working_hours', undefined])
    else if (!validWorkingHours(b.working_hours)) return fail('working hours must be {mon..sun: null | {open:"HH:MM", close:"HH:MM"}}', 'working_hours')
    else writes.push(['working_hours', b.working_hours])
  }
  if ('allowed_origins' in b) {
    if (b.allowed_origins === null) writes.push(['allowed_origins', undefined]) // back to the deployment default
    else {
      if (!Array.isArray(b.allowed_origins) || b.allowed_origins.length > 20) return fail('allowed_origins must be a list of at most 20 origins', 'allowed_origins')
      const out: string[] = []
      for (const o of b.allowed_origins) {
        const n = typeof o === 'string' ? normaliseOrigin(o) : null
        if (!n) return fail(`not a valid origin: ${String(o).slice(0, 80)} (use https://example.com, no path)`, 'allowed_origins')
        if (!out.includes(n)) out.push(n)
      }
      writes.push(['allowed_origins', out])
    }
  }
  if ('broadcast_per_minute' in b) {
    if (b.broadcast_per_minute === null) writes.push(['broadcast_per_minute', undefined])
    else if (!Number.isInteger(b.broadcast_per_minute) || (b.broadcast_per_minute as number) < 1 || (b.broadcast_per_minute as number) > 40) return fail('broadcast pace must be a whole number from 1 to 40 per minute', 'broadcast_per_minute')
    else writes.push(['broadcast_per_minute', b.broadcast_per_minute])
  }
  let ai: string | null | undefined
  if ('anthropic_key' in b) {
    if (b.anthropic_key === null || b.anthropic_key === '') ai = null
    else if (typeof b.anthropic_key !== 'string' || b.anthropic_key.trim().length < 8 || b.anthropic_key.length > 300 || /\s/.test(b.anthropic_key.trim())) return fail('that does not look like an API key', 'anthropic_key')
    else ai = b.anthropic_key.trim()
    if (!env.SESSION_SECRET) return json({ ok: false, error: 'session_secret_missing' }, 503)
  }

  for (const [k, v] of writes) await putSetting(env, k, v, by)
  if (ai !== undefined) await setAnthropicKey(env, ai, by)
  await logEvent(env.DB, 'settings_changed', { by: by ?? 'api', keys: [...writes.map((w) => w[0]), ...(ai !== undefined ? ['anthropic_key'] : [])] })
  return json(await view(env, true))
}

export async function handleSettings(req: Request, env: Env, path: string, actor: Actor | null): Promise<Response | null> {
  if (path !== '/api/settings') return null
  if (req.method === 'GET') return json(await view(env, actor?.kind === 'admin_key' || actor?.staff.role === 'admin'))
  if (req.method === 'PUT' || req.method === 'PATCH') return require(actor, 'admin') ?? patch(req, env, actor)
  return null
}
