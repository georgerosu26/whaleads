// one-click Connect to WhaBuzz, WhaLeads side. Implements the LIVE WhaBuzz contract
// (see docs/ADAPTORS.md, "Connect through WhaBuzz").
//   POST /api/connect/whabuzz/start   admin + CSRF: mints state + PKCE verifier, stores the pending connect encrypted, returns {url}
//   GET  /api/whabuzz/callback        top-level navigation back from WhaBuzz (own session check; no session -> /login?next=)
//   POST /api/whabuzz/webhook         alias of /webhooks/whabuzz (src/webhook.ts), plus the unsigned verify-ping allowance
import type { Actor } from '../auth'
import { b64url, require, sha256Hex, authenticate, withRenewedCookie } from '../auth'
import { applyAdaptorConfig } from '../adaptors'
import { resolveApiRoot, resolveConnectBase } from '../adaptors/whabuzz'
import { decryptJson, encryptJson } from '../crypto'
import type { Env } from '../db'
import { logEvent } from '../db'
import { json } from '../leads'
import { timingSafeEqual } from '../password'
import { hit } from '../ratelimit'
import { clearSettingsCache, getSettings, putSetting } from '../settings'
import { clientIp } from './auth'

const START = '/api/connect/whabuzz/start'
export const CALLBACK = '/api/whabuzz/callback'
export const WEBHOOK = '/api/whabuzz/webhook'
const PENDING_KEY = 'connect_pending'
export const INFO_KEY = 'whabuzz_connect_info'
export const CONNECT_INFO = 'whaleads/connect/v1'
const PENDING_TTL_S = 600
const WINDOW = 600
const enc = new TextEncoder()

interface Pending { state_hash: string; verifier: string; sid: string; exp: number }

/** `?error=` values WhaBuzz can send to the callback. Anything else is folded into `connect_failed`. */
const WB_ERRORS = new Set(['access_denied'])
/** `error.code` values of POST /connect/token the settings page knows how to word (the code is also the redirect's connect_error). */
const TOKEN_ERRORS = new Set(['unknown_app', 'invalid_code', 'code_used', 'code_expired', 'connection_gone', 'connection_unavailable', 'rate_limited'])
const STATE_RE = /^[\x21-\x7e]{1,200}$/

const rand = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)))
const s256 = async (verifier: string) => b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(verifier))))

/** Reads (does not delete) the pending row straight from D1. `raw` is the exact stored value, used to consume it. */
async function readPending(env: Env): Promise<{ raw: string; p: Pending } | null> {
  const row = await env.DB.prepare(`SELECT value FROM settings WHERE key=?`).bind(PENDING_KEY).first<{ value: string }>()
  if (!row || !env.SESSION_SECRET) return null
  try {
    const p = await decryptJson<Pending>(env.SESSION_SECRET, String(JSON.parse(row.value)), CONNECT_INFO)
    return typeof p?.state_hash === 'string' && typeof p.verifier === 'string' && typeof p.sid === 'string' && typeof p.exp === 'number' ? { raw: row.value, p } : null
  } catch { return null }
}

/** Single use: deletes exactly the ciphertext that was verified. Only the caller that sees changes===1 may go on, so a
 *  concurrent or replayed callback cannot spend it twice, and a newer start (different ciphertext) is never wiped. */
async function consumePending(env: Env, raw: string): Promise<boolean> {
  const r = await env.DB.prepare(`DELETE FROM settings WHERE key=? AND value=?`).bind(PENDING_KEY, raw).run()
  clearSettingsCache(env.DB)
  return r.meta.changes === 1
}

const redirect = (res: { path: string; params?: Record<string, string> }) => {
  const qs = new URLSearchParams(res.params ?? {}).toString()
  return new Response(null, { status: 302, headers: { Location: qs ? `${res.path}?${qs}` : res.path, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } })
}
const back = (params: Record<string, string>) => redirect({ path: '/settings/whatsapp', params })
const fail = (code: string, detail?: string) => back({ connect_error: code, ...(detail ? { detail: detail.replace(/[^\w .,:'()/-]/g, ' ').trim().slice(0, 120) } : {}) })

async function start(req: Request, env: Env, actor: Actor | null): Promise<Response> {
  const denied = require(actor, 'admin')
  if (denied) return denied
  // The pending connect is bound to a browser session, so a Bearer ADMIN_KEY (no cookie) cannot start one.
  if (actor?.kind !== 'staff') return json({ ok: false, error: 'session_required' }, 403)
  if (!env.SESSION_SECRET) return json({ ok: false, error: 'session_secret_missing' }, 503)
  if (!env.WHABUZZ_CONNECT_BASE?.trim()) return json({ ok: false, error: 'connect_unavailable' }, 409)
  let base: string
  try { base = resolveConnectBase(env.WHABUZZ_CONNECT_BASE) } catch (e) { return json({ ok: false, error: 'connect_misconfigured', detail: (e as Error).message }, 500) }
  if (await hit(env.DB, `connect:start:${actor.staff.id}`, 5, WINDOW)) return json({ ok: false, error: 'too_many_attempts', message: 'Too many connect attempts. Wait a few minutes and try again.' }, 429)

  const state = rand(32) // 43 printable ASCII chars; WhaBuzz allows up to 200
  const verifier = rand(32) // 43 base64url chars (PKCE allows 43 to 128)
  const pending: Pending = { state_hash: await sha256Hex(state), verifier, sid: actor.sid, exp: Math.floor(Date.now() / 1000) + PENDING_TTL_S }
  // Replaces any earlier pending row: one connect in flight at a time.
  await putSetting(env, PENDING_KEY, await encryptJson(env.SESSION_SECRET, pending, CONNECT_INFO), actor.staff.id)

  // The live contract takes exactly app, callback, state and (optional) code_challenge; S256 is implied. Whole link stays well under 500 chars.
  const u = new URL('/connect', base)
  u.searchParams.set('app', 'whaleads')
  u.searchParams.set('callback', `${new URL(req.url).origin}${CALLBACK}`)
  u.searchParams.set('state', state)
  u.searchParams.set('code_challenge', await s256(verifier))
  return json({ ok: true, url: u.toString() })
}

/** True while a not-yet-expired connect is in flight (the start button was pressed in the last 10 minutes). Never throws. */
export async function connectPending(env: Env): Promise<boolean> {
  try {
    const got = await readPending(env)
    return !!got && got.p.exp > Math.floor(Date.now() / 1000)
  } catch { return false }
}

/** Display info stored at connect time, only if it belongs to the number that is active now. */
export async function connectInfo(env: Env, phoneNumberId: string): Promise<{ display_phone_number: string; tenant_id: string } | null> {
  try {
    const row = await env.DB.prepare(`SELECT value FROM settings WHERE key=?`).bind(INFO_KEY).first<{ value: string }>()
    const v = row ? JSON.parse(row.value) : null
    return v && v.phone_number_id === phoneNumberId ? { display_phone_number: String(v.display_phone_number ?? ''), tenant_id: String(v.tenant_id ?? '') } : null
  } catch { return null }
}

/** Parses WhaBuzz's `{error:{code}}` (or a bare `{code}`) off a failed exchange. */
function errorCodeOf(d: any): string {
  const c = d?.error?.code ?? d?.code ?? (typeof d?.error === 'string' ? d.error : '')
  return typeof c === 'string' ? c : ''
}

async function callback(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url)
  const actor = await authenticate(req, env)
  if (actor?.kind !== 'staff') {
    // The per-IP budget guards only this signed-out path; a signed-in admin's budget is per person (below), so hidden
    // cross-site GETs from other IPs cannot burn it.
    if (await hit(env.DB, `connect:cb:${clientIp(req)}`, 10, WINDOW)) return fail('too_many_attempts')
    // Not signed in here (or the browser did not send the cookie): sign in, then land back on this exact URL.
    return redirect({ path: '/login', params: { next: `${url.pathname}${url.search}` } })
  }
  const done = (res: Response) => withRenewedCookie(res, actor)
  if (require(actor, 'admin')) return done(fail('forbidden'))
  if (await hit(env.DB, `connect:cbstaff:${actor.staff.id}`, 10, WINDOW)) return done(fail('too_many_attempts'))

  // State is compared first, before anything else is read from the URL.
  const state = url.searchParams.get('state') ?? ''
  const got = await readPending(env)
  const pending = got?.p ?? null
  const sidOk = !!pending && timingSafeEqual(enc.encode(pending.sid), enc.encode(actor.sid))
  const stateOk = !!pending && STATE_RE.test(state) && timingSafeEqual(enc.encode(await sha256Hex(state)), enc.encode(pending.state_hash))
  if (!pending || !sidOk || !stateOk) { await logEvent(env.DB, 'connect_failed', { code: 'state_mismatch' }); return done(fail('state_mismatch')) }
  // Session, state and expiry are proven: only now spend the row (a forged callback never reaches this line, so it cannot wipe a real pending connect).
  const spent = await consumePending(env, got!.raw)
  if (!spent) { await logEvent(env.DB, 'connect_failed', { code: 'state_mismatch' }); return done(fail('state_mismatch')) }
  if (pending.exp <= Math.floor(Date.now() / 1000)) { await logEvent(env.DB, 'connect_failed', { code: 'state_expired' }); return done(fail('invalid_code')) }

  const wbError = url.searchParams.get('error')
  if (wbError) {
    const code = WB_ERRORS.has(wbError) ? wbError : 'connect_failed'
    await logEvent(env.DB, 'connect_failed', { code, from: 'whabuzz' })
    return done(fail(code))
  }
  const code = url.searchParams.get('code') ?? ''
  if (!/^[A-Za-z0-9_-]{43}$/.test(code)) return done(fail('invalid_code'))

  let root: string
  try { root = resolveApiRoot(env.WHABUZZ_BASE_URL) } catch { return done(fail('server_error')) }
  let ex: Response
  try {
    // Server to server, no Authorization header: the code is the credential. The path is at the API root, not under /v1.
    ex = await fetch(`${root}/connect/token`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ app: 'whaleads', code, state, code_verifier: pending.verifier }),
    })
  } catch { await logEvent(env.DB, 'connect_failed', { code: 'exchange_unreachable' }); return done(fail('exchange_failed')) }
  if (!ex.ok) {
    const wb = errorCodeOf(await ex.json().catch(() => null))
    const c = TOKEN_ERRORS.has(wb) ? wb : ex.status === 429 ? 'rate_limited' : ex.status >= 500 ? 'exchange_failed' : 'invalid_code'
    await logEvent(env.DB, 'connect_failed', { code: c, status: ex.status })
    // A replayed code makes WhaBuzz revoke the connection it created: record that this instance saw it.
    if (c === 'code_used') await logEvent(env.DB, 'connect_revoked', { reason: 'code_used', status: ex.status })
    return done(fail(c))
  }
  const d: any = await ex.json().catch(() => null)
  const str = (v: unknown, max: number) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : '')
  const grant = d && { api_key: str(d.api_key, 512), webhook_secret: str(d.webhook_secret, 512), phone_number_id: str(d.phone_number_id, 64), waba_id: str(d.waba_id, 64) }
  if (!grant || !grant.api_key || !grant.webhook_secret || !grant.phone_number_id || !grant.waba_id) { await logEvent(env.DB, 'connect_failed', { code: 'exchange_malformed' }); return done(fail('exchange_failed')) }

  // WhaBuzz has already activated this connection and revoked the earlier ones, so the grant is saved even if status()
  // fails (applyAdaptorConfig 'connect' mode); a status problem is only a warning. No separate webhook verify call:
  // WhaBuzz verified the endpoint at approve time.
  const applied = await applyAdaptorConfig(env, { kind: 'whabuzz', config: grant }, 'connect')
  if (!applied.ok) {
    await logEvent(env.DB, 'connect_failed', { code: 'exchange_malformed', http: applied.http })
    return done(fail('exchange_failed'))
  }
  // Non-secret display info, tied to the number it was issued for (the UI ignores it if the active number changes).
  await putSetting(env, INFO_KEY, { phone_number_id: grant.phone_number_id, display_phone_number: str(d.display_phone_number, 40), tenant_id: str(d.tenant_id, 64) }, actor.staff.id)
  await logEvent(env.DB, 'connect_done', { live_key: grant.api_key.startsWith('wb_live_') })
  if (applied.status_warning) {
    await logEvent(env.DB, 'connect_status_warning', { detail: String(applied.status.detail ?? '').slice(0, 120) })
    return done(back({ connected: '1', warn: 'status_failed' }))
  }
  return done(back({ connected: '1' }))
}

/** Public (pre-gate) route: the callback authenticates itself because a missing session must redirect, not 401. */
export async function handleConnectCallback(req: Request, env: Env, path: string): Promise<Response | null> {
  if (path !== CALLBACK) return null
  if (req.method !== 'GET') return new Response('method not allowed', { status: 405 })
  return callback(req, env)
}

/** Gated routes (the caller has already required a signed-in staff actor). */
export async function handleConnect(req: Request, env: Env, path: string, actor: Actor | null): Promise<Response | null> {
  if (req.method !== 'POST') return null
  if (path === START) return start(req, env, actor)
  return null
}
