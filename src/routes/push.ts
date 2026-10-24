// /api/push/*: VAPID public key, device subscriptions, and a test send. Behind the one gate (session + CSRF, or ADMIN_KEY).
import type { Actor } from '../auth'
import type { Env } from '../db'
import { json } from '../leads'
import { endpointOk, sendToSubs, type SubRow } from '../push'
import { putSetting, getSettings } from '../settings'
import { readJson } from './auth'
import { actorId } from './settings'

const MAX_PER_STAFF = 10
const key = (v: unknown) => (typeof v === 'string' && /^[A-Za-z0-9_-]{16,200}$/.test(v) ? v : null)

async function subscribe(req: Request, env: Env, staffId: number): Promise<Response> {
  const b = await readJson(req)
  const sub = (b?.subscription ?? b) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | undefined
  const p256dh = key(sub?.keys?.p256dh); const auth = key(sub?.keys?.auth)
  if (!endpointOk(sub?.endpoint) || !p256dh || !auth) return json({ ok: false, error: 'invalid subscription' }, 400)
  const endpoint = sub!.endpoint as string
  const existing = await env.DB.prepare(`SELECT staff_id FROM push_subscriptions WHERE endpoint=?`).bind(endpoint).first<{ staff_id: number }>()
  if (!existing) {
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM push_subscriptions WHERE staff_id=?`).bind(staffId).first<{ n: number }>()
    if ((n?.n ?? 0) >= MAX_PER_STAFF) return json({ ok: false, error: `at most ${MAX_PER_STAFF} devices per person` }, 409)
  }
  const ua = (req.headers.get('User-Agent') ?? '').slice(0, 300) || null
  // Upsert on the endpoint: a device that signs in as someone else is re-owned, and its failure count restarts.
  await env.DB.prepare(
    `INSERT INTO push_subscriptions (staff_id,endpoint,p256dh,auth,user_agent) VALUES (?1,?2,?3,?4,?5)
     ON CONFLICT(endpoint) DO UPDATE SET staff_id=excluded.staff_id, p256dh=excluded.p256dh, auth=excluded.auth, user_agent=excluded.user_agent, fail_count=0`,
  ).bind(staffId, endpoint, p256dh, auth, ua).run()
  // The VAPID `sub` claim needs an https URL for this instance; the pipeline has no request, so remember it here.
  const origin = new URL(req.url).origin
  if (origin.startsWith('https:')) await putSetting(env, 'push_subject', origin, staffId).catch(() => {})
  return json({ ok: true })
}

async function unsubscribe(req: Request, env: Env, staffId: number): Promise<Response> {
  const b = await readJson(req)
  if (typeof b?.endpoint !== 'string' || !b.endpoint) return json({ ok: false, error: 'endpoint required' }, 400)
  await env.DB.prepare(`DELETE FROM push_subscriptions WHERE endpoint=? AND staff_id=?`).bind(b.endpoint, staffId).run()
  return json({ ok: true })
}

async function test(env: Env, staffId: number): Promise<Response> {
  const subs = await env.DB.prepare(`SELECT id,staff_id,endpoint,p256dh,auth FROM push_subscriptions WHERE staff_id=? ORDER BY id LIMIT 10`).bind(staffId).all<SubRow>()
  const biz = (await getSettings(env)).business_name
  const r = await sendToSubs(env, subs.results, { title: biz, body: 'Notifications are on for this device.', url: '/settings/profile', tag: 'test' })
  return json({ ok: true, sent: r.sent, removed: r.removed, failed: r.failed, devices: subs.results.length })
}

export async function handlePush(req: Request, env: Env, path: string, actor: Actor | null): Promise<Response | null> {
  if (!path.startsWith('/api/push/')) return null
  if (path === '/api/push/vapid' && req.method === 'GET') return json({ ok: true, public_key: (await getSettings(env)).vapid_public })
  const me = actorId(actor)
  const needStaff = () => json({ ok: false, error: 'a signed-in staff session is required' }, 400)
  if (path === '/api/push/subscribe' && req.method === 'POST') return me ? subscribe(req, env, me) : needStaff()
  if ((path === '/api/push/subscribe' && req.method === 'DELETE') || (path === '/api/push/unsubscribe' && req.method === 'POST')) return me ? unsubscribe(req, env, me) : needStaff()
  if (path === '/api/push/test' && req.method === 'POST') return me ? test(env, me) : needStaff()
  return null
}
