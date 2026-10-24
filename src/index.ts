// WhaLeads: one Worker + D1. WhatsApp Cloud API webhook, form lead intake, admin API.
import { startRouteLimit } from './routelimits'
import { withSecurityHeaders } from './headers'
import { newTiming, runWithTiming, summary, timedRoute, withServerTiming } from './timing'
import { ensureSchema, logEvent, type Env } from './db'
import { handleWebhook, verifyChallenge } from './webhook'
import { ConfigUndecryptable, applyAdaptorConfig, maskConfig, resolveActive } from './adaptors'
import { CloudApiAdaptor } from './adaptors/cloud-api'
import { connectAvailable } from './adaptors/whabuzz'
import { prefetchTarget } from './sendTarget'
import { handleLeadIntake, json, listLeads, send } from './leads'
import { authenticate, require, withRenewedCookie } from './auth'
import { handleAuth } from './routes/auth'
import { handleSetup } from './routes/setup'
import { handleStaff } from './routes/staff'
import { handleSettings } from './routes/settings'
import { handlePipeline } from './routes/pipeline'
import { handleInbox } from './routes/inbox'
import { handleTemplates } from './routes/templates'
import { handleMedia } from './routes/media'
import { runCron } from './cron' // media jobs + flow tick
import { handleLive } from './routes/live' // D20
import { handleBroadcasts } from './routes/broadcasts'
import { handleFlows } from './routes/flows'
import { handleLeads } from './routes/leads'
import { handleContacts } from './routes/contacts'
import { handleToday } from './routes/today'
import { handleReports } from './routes/reports'
import { handleExport } from './routes/export'
import { handlePush } from './routes/push'
import { connectInfo, handleConnect, handleConnectCallback } from './routes/connect'

/** Direct Meta setup (Cloud API adaptor only): WABA subscription and app webhook. Staff alerts are web push (D17), not templates. */
async function setup(cloud: CloudApiAdaptor, origin: string) {
  const out: Record<string, unknown> = {}
  out.subscribed_apps = await cloud.subscribeWaba()
  out.subscriptions = await cloud.subscribeApp(`${origin}/webhooks/meta`)
  return out
}

async function getAdaptor(env: Env): Promise<Response> {
  let active
  try { active = await resolveActive(env) } catch (e) {
    if (e instanceof ConfigUndecryptable) return json({ ok: false, error: 'config_undecryptable', detail: 'The saved WhatsApp connection cannot be read with this SESSION_SECRET. Save it again.' }, 500)
    throw e
  }
  if (!active) return json({ ok: true, kind: null, source: null, connect_available: connectAvailable(env.WHABUZZ_CONNECT_BASE), config: null, status: null })
  return json({ ok: true, kind: active.kind, source: active.source, onboarding: active.adaptor.onboarding, connect_available: connectAvailable(env.WHABUZZ_CONNECT_BASE), sandbox: active.kind === 'whabuzz' && String((active.config as { api_key?: string }).api_key ?? '').startsWith('wb_test_'), config: maskConfig(active.config as unknown as Record<string, unknown>), connect_info: active.kind === 'whabuzz' ? await connectInfo(env, String((active.config as { phone_number_id?: string }).phone_number_id ?? '')) : null, status: await active.adaptor.status() })
}

async function putAdaptor(req: Request, env: Env): Promise<Response> {
  if (!env.SESSION_SECRET) return json({ ok: false, error: 'SESSION_SECRET is not set on this Worker' }, 500)
  let body: unknown
  try { body = await req.json() } catch { return json({ ok: false, error: 'invalid JSON' }, 400) }
  const r = await applyAdaptorConfig(env, body, 'manual')
  if (!r.ok) return json(r.body, r.http)
  return json({ ok: true, kind: r.kind, config: maskConfig(r.config), status: r.status })
}

async function handle(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname.replace(/\/+$/, '') || '/'
  try {
    const version = await ensureSchema(env.DB)

    if (path === '/api/health') {
      try {
        const active = await resolveActive(env)
        const cron = await env.DB.prepare(`SELECT value FROM meta WHERE key='cron_last_at'`).first<{ value: string }>()
        return json({ ok: true, instance: env.INSTANCE_NAME, schema_version: version, adaptor: active?.kind ?? null, cron_last_at: cron ? Number(cron.value) : null })
      } catch (e) {
        const undecryptable = e instanceof ConfigUndecryptable
        // public route, so the exception text (config values, SQL) stays in the logs, not the response.
        console.error(JSON.stringify({ at: 'health', error: String(e) }))
        return json({ ok: false, instance: env.INSTANCE_NAME, schema_version: version, adaptor: null, adaptor_error: undecryptable ? 'config_undecryptable' : 'adaptor_error' })
      }
    }

    if (path === '/webhooks/meta') {
      if (req.method === 'GET') return await verifyChallenge(url, env)
      if (req.method === 'POST') return await handleWebhook('cloud_api', req, env, ctx)
      return new Response('method not allowed', { status: 405 })
    }
    // /api/whabuzz/webhook is the path the live Connect flow registers; /webhooks/whabuzz stays for instances registered by hand.
    // Both sit before the /api/ gate and go through the same signed pipeline.
    if (path === '/webhooks/whabuzz' || path === '/api/whabuzz/webhook') {
      if (req.method === 'POST') return await handleWebhook('whabuzz', req, env, ctx)
      return new Response('method not allowed', { status: 405 })
    }

    if (path === '/api/leads' && (req.method === 'POST' || req.method === 'OPTIONS')) return await handleLeadIntake(req, env, ctx)

    const pub = (await handleSetup(req, env, path)) ?? (await handleAuth(req, env, path, ctx))
    if (pub) return pub
    const cb = await handleConnectCallback(req, env, path) // does its own auth (a missing session redirects to /login)
    if (cb) return cb

    if (path.startsWith('/api/')) {
      // The one gate: a session cookie (humans) or the ADMIN_KEY bearer (scripts, no CSRF).
      // The inbox send routes read the contact, window and adaptor-config version while the session is looked up.
      const sendRoute = req.method === 'POST' && (req.headers.has('Authorization') || req.headers.has('Cookie')) ? /^\/api\/inbox\/(\d+)\/(send|send-media|send-template)$/.exec(path) : null
      if (sendRoute) prefetchTarget(req, env, Number(sendRoute[1]), sendRoute[2] === 'send-template')
      const limit = startRouteLimit(req, env, path) // overlaps the session lookup
      limit.catch(() => {}) // awaited below; never an unhandled rejection if the gate returns first
      const actor = await authenticate(req, env)
      const needs = (role: 'staff' | 'admin') => require(actor, role)
      const done = (r: Response) => withRenewedCookie(r, actor)

      const denied = needs('staff')
      if (denied) return denied
      const limited = await limit // only reported once auth + CSRF passed
      if (limited) return limited
      const liveRes = await handleLive(req, env, path, actor) // D20: a 101 must not be rebuilt by done()
      if (liveRes) return liveRes
      // before the CRM handlers, so /api/leads/:id/flow-runs is not swallowed by handleLeads
      const flowRes = await handleFlows(req, env, ctx, path, actor, url)
      if (flowRes) return done(flowRes)
      const bcRes = await handleBroadcasts(req, env, ctx, path, actor, url)
      if (bcRes) return done(bcRes)
      const crmRes = (await handleLeads(req, env, ctx, path, actor, url)) ?? (await handleContacts(req, env, path, actor, url, ctx)) ?? (await handleToday(req, env, path, actor))
      if (crmRes) return done(crmRes)
      const reportRes = (await handleReports(req, env, path, actor, url)) ?? (await handleExport(req, env, ctx, path, actor, url))
      if (reportRes) return done(reportRes)
      const pushRes = await handlePush(req, env, path, actor)
      if (pushRes) return done(pushRes)
      const tplRes = await handleTemplates(req, env, ctx, path, actor, url)
      if (tplRes) return done(tplRes)
      const inboxRes = await handleInbox(req, env, ctx, path, actor, url)
      if (inboxRes) return done(inboxRes)
      const mediaRes = await handleMedia(req, env, ctx, path)
      if (mediaRes) return done(mediaRes)
      if (path === '/api/send' && req.method === 'POST') return done(await send(req, env, ctx))
      const connectRes = await handleConnect(req, env, path, actor)
      if (connectRes) return done(connectRes)
      const owned = (await handleSettings(req, env, path, actor)) ?? (await handleStaff(req, env, path, actor, ctx)) ?? (await handlePipeline(req, env, path, actor, url))
      if (owned) return done(owned)
      if (path.startsWith('/api/admin/')) {
        const adminDenied = needs('admin')
        if (adminDenied) return adminDenied
        if (path === '/api/admin/adaptor') {
          if (req.method === 'GET') return done(await getAdaptor(env))
          if (req.method === 'PUT') return done(await putAdaptor(req, env))
        }
        if (path === '/api/admin/setup' && req.method === 'POST') {
          const active = await resolveActive(env)
          if (!(active?.adaptor instanceof CloudApiAdaptor)) return json({ ok: false, error: 'setup registers a direct Meta webhook and needs the cloud_api adaptor' }, 400)
          const result = await setup(active.adaptor, url.origin)
          await logEvent(env.DB, 'setup', result)
          return done(json({ ok: true, ...result }))
        }
      }
    }
    return json({ ok: false, error: 'not found' }, 404)
  } catch (e) {
    // never echo the exception (D1 errors quote SQL; adaptor errors can quote config). Log it with an id the
    // operator can search for, and hand the caller only that id.
    const ref = crypto.randomUUID().slice(0, 8)
    console.error(JSON.stringify({ at: 'unhandled', ref, method: req.method, path, error: String(e), stack: e instanceof Error ? e.stack : undefined }))
    return json({ ok: false, error: 'internal error', ref }, 500)
  }
}

export { LiveHub } from './livehub' // D20: Durable Object class, bound as LIVE

export default {
  // D19: send routes and webhook POSTs carry Server-Timing (worker / upstream / the gateway's own split).
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const pathname = new URL(req.url).pathname.replace(/\/+$/, '') || '/'
    const route = timedRoute(req.method, pathname)
    if (!route) return withSecurityHeaders(await handle(req, env, ctx))
    const t = newTiming()
    const res = await runWithTiming(t, () => handle(req, env, ctx))
    // Logged after the response is on its way, so the timing row never adds to the latency it measures.
    if (route === 'send' && t.calls > 0) ctx.waitUntil(logEvent(env.DB, 'send_timing', { route: pathname, status: res.status, timing: summary(t) }))
    return withSecurityHeaders(withServerTiming(res, t))
  },
  // Cron (every minute): the flow tick always; the 15-minute jobs (media retries, purge, repair; dead push
  // subscriptions) on minutes divisible by 15. Awaited, not waitUntil, so a long tick is not cut at 30 s.
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    const t0 = Date.now()
    const { ran } = await runCron(env, event.scheduledTime)
    console.log(JSON.stringify({ cron: event.cron, ran, ms: Date.now() - t0 })) // observability captures it; no D1 cost
  },
} satisfies ExportedHandler<Env>
