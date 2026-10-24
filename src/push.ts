// Web Push (RFC 8030) with VAPID (RFC 8292) and aes128gcm payload encryption (RFC 8291), WebCrypto only.
// Fan-out with reactive cleanup; the crypto is written out here instead of
// pulling @block65/webcrypto-web-push, so the Worker bundle stays dependency-free.
// Push is the ONLY staff notification channel (D17): a failure here must never fail the request that caused it.
import { VAPID_INFO, decryptJson } from './crypto'
import type { Env } from './db'
import { logEvent } from './db'
import { getSettings } from './settings'

export const MAX_FANOUT = 40
export const SEND_TIMEOUT_MS = 10_000
export const MAX_FAILS = 5
const TTL_SECONDS = 24 * 3600
const RECORD_SIZE = 4096

export interface PushPayload { title: string; body: string; url: string; tag: string }
export interface SubRow { id: number; staff_id: number; endpoint: string; p256dh: string; auth: string }

const enc = new TextEncoder()

export function b64urlEncode(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export function b64urlDecode(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

/** An endpoint the Worker may POST to: https, or http on loopback (local stub in the smoke test; unreachable from a deployed Worker). */
export function endpointOk(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== 'string' || endpoint.length > 2048) return false
  try {
    const u = new URL(endpoint)
    if (u.username || u.password) return false
    if (u.protocol === 'https:') return true
    return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]')
  } catch { return false }
}

// ---- VAPID (RFC 8292) -------------------------------------------------------------------------------------------

export interface Vapid { publicKey: string; privateKey: CryptoKey; subject: string }

/** Loads the keypair created at /setup (private half decrypted from SESSION_SECRET). Null when push is not configured. */
export async function loadVapid(env: Env): Promise<Vapid | null> {
  if (!env.SESSION_SECRET) return null
  const rows = await env.DB.prepare(`SELECT key,value FROM settings WHERE key IN ('vapid_public','vapid_private_enc','push_subject')`).all<{ key: string; value: string }>()
  const m = new Map(rows.results.map((r) => [r.key, JSON.parse(r.value) as string]))
  const pub = m.get('vapid_public'); const privEnc = m.get('vapid_private_enc')
  if (!pub || !privEnc) return null
  const jwk = await decryptJson<JsonWebKey>(env.SESSION_SECRET, privEnc, VAPID_INFO)
  const privateKey = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  return { publicKey: pub, privateKey, subject: m.get('push_subject') || 'https://whaleads.app' }
}

/** `Authorization: vapid t=<jwt>, k=<public key>` for one push service (aud = its origin). Valid 12 h. */
export async function vapidHeader(v: Vapid, endpoint: string, now = Math.floor(Date.now() / 1000)): Promise<string> {
  const head = b64urlEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64urlEncode(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: now + 12 * 3600, sub: v.subject })))
  const input = `${head}.${claims}`
  // WebCrypto ECDSA returns the raw r||s (IEEE P1363) form that JWS ES256 wants.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, v.privateKey, enc.encode(input)))
  return `vapid t=${input}.${b64urlEncode(sig)}, k=${v.publicKey}`
}

// ---- payload encryption (RFC 8291, aes128gcm content coding of RFC 8188) ----------------------------------------

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8))
}

/** Body = salt(16) | record size(4) | key id length(1) | sender public key(65) | AES-128-GCM(payload | 0x02). One record. */
export async function encryptPayload(plain: Uint8Array, p256dh: string, authSecret: string): Promise<Uint8Array> {
  const uaPublic = b64urlDecode(p256dh)
  const auth = b64urlDecode(authSecret)
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || auth.length < 16) throw new Error('bad subscription keys')
  if (plain.length > RECORD_SIZE - 17 - 1) throw new Error('payload too large')

  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair
  const asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer)
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, pair.privateKey, 256))

  const ikm = await hkdf(auth, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32)
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12)
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(plain, new Uint8Array([2]))))

  const header = new Uint8Array(21)
  header.set(salt, 0)
  new DataView(header.buffer).setUint32(16, RECORD_SIZE)
  header[20] = asPublic.length
  return concat(header, asPublic, ct)
}

// ---- send + fan-out -------------------------------------------------------------------------------------------

/** One POST to the push service. Returns the HTTP status (0 = network/encryption failure). */
async function sendOne(v: Vapid, sub: SubRow, body: Uint8Array): Promise<number> {
  try {
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(TTL_SECONDS),
        Urgency: 'normal',
        Authorization: await vapidHeader(v, sub.endpoint),
      },
      body,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS), // a hanging push service counts as a failure, not a stalled batch
    })
    await res.body?.cancel().catch(() => {})
    return res.status
  } catch { return 0 }
}

/**
 * Sends to the given subscriptions (already capped by the caller) and updates their health in one batch:
 * 2xx resets the failure count; 404/410 deletes (the browser unsubscribed); anything else adds one failure and
 * the row is deleted at MAX_FAILS. Never throws for a single bad subscription.
 */
export async function sendToSubs(env: Env, subs: SubRow[], payload: PushPayload): Promise<{ sent: number; removed: number; failed: number }> {
  const out = { sent: 0, removed: 0, failed: 0 }
  if (!subs.length) return out
  const v = await loadVapid(env)
  if (!v) return out
  const plain = enc.encode(JSON.stringify(payload))
  const results = await Promise.all(subs.map(async (s) => {
    try { return await sendOne(v, s, await encryptPayload(plain, s.p256dh, s.auth)) } catch { return 0 }
  }))
  const stmts: D1PreparedStatement[] = []
  results.forEach((status, i) => {
    const id = subs[i].id
    if (status >= 200 && status < 300) { out.sent++; stmts.push(env.DB.prepare(`UPDATE push_subscriptions SET last_ok_at=unixepoch(), fail_count=0 WHERE id=?`).bind(id)) }
    else if (status === 404 || status === 410) { out.removed++; stmts.push(env.DB.prepare(`DELETE FROM push_subscriptions WHERE id=?`).bind(id)) }
    else {
      out.failed++
      stmts.push(env.DB.prepare(`UPDATE push_subscriptions SET fail_count=fail_count+1 WHERE id=?`).bind(id))
      stmts.push(env.DB.prepare(`DELETE FROM push_subscriptions WHERE id=? AND fail_count>=?`).bind(id, MAX_FAILS))
    }
  })
  if (stmts.length) await env.DB.batch(stmts)
  return out
}

/** Subscriptions of the given staff, newest-healthy first, at most MAX_FANOUT (+1 fetched to detect truncation). */
async function subsFor(env: Env, staffIds: number[] | 'all_active'): Promise<{ subs: SubRow[]; truncated: boolean }> {
  const base = `SELECT p.id,p.staff_id,p.endpoint,p.p256dh,p.auth FROM push_subscriptions p JOIN staff s ON s.id=p.staff_id WHERE s.active=1`
  const order = ` ORDER BY p.fail_count ASC, COALESCE(p.last_ok_at, p.created_at) DESC, p.id DESC LIMIT ${MAX_FANOUT + 1}`
  const rows = staffIds === 'all_active'
    ? await env.DB.prepare(base + order).all<SubRow>()
    : await env.DB.prepare(`${base} AND p.staff_id IN (${staffIds.map(() => '?').join(',') || 'NULL'})${order}`).bind(...staffIds).all<SubRow>()
  return { subs: rows.results.slice(0, MAX_FANOUT), truncated: rows.results.length > MAX_FANOUT }
}

/** Recipients table (plan C6): lead = every active staff; inbound = the assignee if active, else every active staff. */
export async function recipients(env: Env, ev: { kind: 'lead' } | { kind: 'inbound'; contactId: number }): Promise<{ subs: SubRow[]; truncated: boolean }> {
  if (ev.kind === 'inbound') {
    const a = await env.DB.prepare(
      `SELECT s.id FROM conversations c JOIN staff s ON s.id=c.assigned_to WHERE c.contact_id=? AND s.active=1`,
    ).bind(ev.contactId).first<{ id: number }>()
    if (a) return subsFor(env, [a.id])
  }
  return subsFor(env, 'all_active')
}

async function fanOut(env: Env, ev: Parameters<typeof recipients>[1], payload: PushPayload): Promise<void> {
  const { subs, truncated } = await recipients(env, ev)
  if (truncated) await logEvent(env.DB, 'push_truncated', { cap: MAX_FANOUT, tag: payload.tag })
  if (subs.length) await sendToSubs(env, subs, payload)
}

const preview = (s: string | null | undefined, n: number) => ((s ?? '').replace(/\s+/g, ' ').trim() || '(no text)').slice(0, n)
const who = (name: string | null, phone: string | null) => name?.trim() || (phone ? `+${phone.replace(/^\+/, '')}` : 'Unknown')

/** New lead (any source). Fire-and-forget under waitUntil: never throws, never blocks the response. */
export function notifyLead(env: Env, ctx: ExecutionContext, leadId: number): void {
  ctx.waitUntil((async () => {
    try {
      const l = await env.DB.prepare(
        `SELECT l.id,l.source,c.name,c.phone FROM leads l JOIN contacts c ON c.id=l.contact_id WHERE l.id=?`,
      ).bind(leadId).first<{ id: number; source: string; name: string | null; phone: string | null }>()
      if (!l) return
      const biz = (await getSettings(env)).business_name
      await fanOut(env, { kind: 'lead' }, { title: biz, body: `${who(l.name, l.phone)} · ${l.source}`, url: `/leads/${l.id}`, tag: `lead-${l.id}` })
    } catch (e) { await logEvent(env.DB, 'push_error', { lead_id: leadId, error: String(e) }).catch(() => {}) }
  })())
}

/** New inbound message on a contact's thread. */
export function notifyInbound(env: Env, ctx: ExecutionContext, a: { contactId: number; name: string | null; phone: string | null; text: string }): void {
  ctx.waitUntil((async () => {
    try {
      const biz = (await getSettings(env)).business_name
      await fanOut(env, { kind: 'inbound', contactId: a.contactId }, {
        title: biz, body: `${who(a.name, a.phone)}: ${preview(a.text, 80)}`, url: `/inbox/${a.contactId}`, tag: `conv-${a.contactId}`,
      })
    } catch (e) { await logEvent(env.DB, 'push_error', { contact_id: a.contactId, error: String(e) }).catch(() => {}) }
  })())
}

/** Cron: drop subscriptions that reached the failure limit without being deleted inline. Idempotent. */
export async function purgeDeadSubscriptions(env: Env): Promise<number> {
  const r = await env.DB.prepare(`DELETE FROM push_subscriptions WHERE fail_count >= ?`).bind(MAX_FAILS).run()
  return r.meta.changes ?? 0
}
