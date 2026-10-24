// First-boot setup. The setup key is SESSION_SECRET itself: only whoever deployed the Worker knows it.
// It is compared in constant time, never stored and never logged.
import { createSession, setupKeyOk } from '../auth'
import { VAPID_INFO, encryptJson } from '../crypto'
import type { Env } from '../db'
import { clearSettingsCache } from '../settings'
import { json } from '../leads'
import { hashPassword } from '../password'
import { isCountryCode } from '../countries'
import { hit } from '../ratelimit'
import { MIN_PASSWORD, clientIp, mePayload, readJson, sameOriginOrNone, sessionMissing } from './auth'

export { VAPID_INFO }
const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max ? v.trim() : null)
const validTimezone = (tz: string) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true } catch { return false } }
const b64url = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')


async function needsSetup(env: Env): Promise<boolean> {
  return !(await env.DB.prepare(`SELECT 1 AS x FROM staff LIMIT 1`).first())
}

async function newVapid(secret: string) {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const pub = b64url((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer)
  const priv = await encryptJson(secret, (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey, VAPID_INFO)
  return { pub, priv }
}

async function setup(req: Request, env: Env): Promise<Response> {
  const secret = env.SESSION_SECRET
  if (!secret) return sessionMissing()
  if (!sameOriginOrNone(req)) return json({ ok: false, error: 'bad_origin' }, 403)
  if (await hit(env.DB, `setup:ip:${clientIp(req)}`, 5, 15 * 60)) return json({ ok: false, error: 'too many attempts, try again later' }, 429)

  const b = await readJson(req)
  if (!b) return json({ ok: false, error: 'invalid JSON' }, 400)
  if (typeof b.setup_key !== 'string' || !(await setupKeyOk(b.setup_key, secret))) return json({ ok: false, error: 'invalid_setup_key' }, 403)

  if (!(await needsSetup(env))) return json({ ok: false, error: 'setup_locked' }, 409)

  const business = str(b.business_name, 120)
  const admin = (b.admin ?? {}) as Record<string, unknown>
  const name = str(admin.name, 120)
  const email = str(admin.email, 254)?.toLowerCase() ?? null
  const password = typeof admin.password === 'string' ? admin.password : ''
  const country = typeof b.default_country === 'string' && b.default_country.trim() ? b.default_country.trim().toUpperCase() : ''
  const tz = typeof b.timezone === 'string' && b.timezone.trim() ? b.timezone.trim() : 'UTC'
  if (!business) return json({ ok: false, error: 'business_name required' }, 400)
  if (!name) return json({ ok: false, error: 'admin name required' }, 400)
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ ok: false, error: 'a valid admin email is required' }, 400)
  if (password.length < MIN_PASSWORD || password.length > 200) return json({ ok: false, error: `password must be ${MIN_PASSWORD}-200 characters` }, 400)
  if (country && !isCountryCode(country)) return json({ ok: false, error: 'default_country must be an ISO 3166-1 country code' }, 400)
  if (!validTimezone(tz)) return json({ ok: false, error: 'unknown timezone' }, 400)

  // Everything slow happens before the lock, so the staff row and its settings land in one batch.
  const [pw_hash, vapid] = await Promise.all([hashPassword(password), newVapid(secret)])
  const rows: [string, unknown][] = [['business_name', business], ['timezone', tz], ['vapid_public', vapid.pub], ['vapid_private_enc', vapid.priv]]
  if (country) rows.push(['default_country', country])

  // Statement 1 is the lock: it inserts only while `staff` is empty. The settings rows are inserted only
  // if it did (changes() is the previous statement's row count), so a losing racer writes nothing.
  const out = await env.DB.batch([
    env.DB.prepare(`INSERT INTO staff (email,name,role,pw_hash) SELECT ?1,?2,'admin',?3 WHERE NOT EXISTS (SELECT 1 FROM staff)`).bind(email, name, pw_hash),
    ...rows.map(([k, v]) =>
      env.DB.prepare(`INSERT INTO settings (key,value) SELECT ?1,?2 WHERE changes() > 0 ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=unixepoch()`).bind(k, JSON.stringify(v))),
  ])
  if (!out[0].meta.changes) return json({ ok: false, error: 'setup_locked' }, 409)
  clearSettingsCache(env.DB) // the cache may have been warmed by an earlier request (e.g. intake CORS)

  const staffId = out[0].meta.last_row_id as number
  const s = await createSession(env, staffId, req.headers.get('User-Agent'))
  const me = await mePayload(env, { id: staffId, email, name, role: 'admin', must_change_pw: 0 }, s.csrf)
  return json(me, 201, { 'set-cookie': s.setCookie })
}

export async function handleSetup(req: Request, env: Env, path: string): Promise<Response | null> {
  if (path === '/api/setup/status' && req.method === 'GET') return json({ ok: true, needs_setup: await needsSetup(env), default_country: env.DEFAULT_COUNTRY?.trim().toUpperCase() || null })
  if (path === '/api/setup' && req.method === 'POST') return setup(req, env)
  return null
}
