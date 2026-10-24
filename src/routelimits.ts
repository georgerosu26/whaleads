// per-caller rate limits for the state-changing (or expensive) routes that had none. The budget is per session
// (or 'api' for the ADMIN_KEY). The hit starts in parallel with the session lookup, so the send path gains no serial D1
// round trip (D19), and it only starts for a request with a valid session MAC plus an X-CSRF-Token header, so a
// cross-site request cannot burn a signed-in user's budget. The 429 is returned only after auth + CSRF pass.
// Login, setup, intake, password, flow writes and flow dry-runs keep their own limiters in their handlers.
import { limitIdentity } from './auth'
import type { Env } from './db'
import { hit } from './ratelimit'

interface Rule { bucket: string; method: string; re: RegExp; limit: number; windowSec: number }

export const ROUTE_LIMITS: Rule[] = [
  // Every outbound send shares one budget per sender: a stolen session cannot run up the WhatsApp bill unchecked.
  { bucket: 'send', method: 'POST', re: /^\/api\/(send|inbox\/\d+\/(send|send-media|send-template))$/, limit: 60, windowSec: 60 },
  { bucket: 'pushtest', method: 'POST', re: /^\/api\/push\/test$/, limit: 5, windowSec: 60 },
  { bucket: 'pushsub', method: 'POST', re: /^\/api\/push\/(subscribe|unsubscribe)$/, limit: 30, windowSec: 60 },
  { bucket: 'tplcreate', method: 'POST', re: /^\/api\/templates$/, limit: 20, windowSec: 3600 },
  // per caller; the bearer is one caller, so this is the deployment-wide cap. The 5 per destination per 10 min lives in otp.ts.
  { bucket: 'otp', method: 'POST', re: /^\/api\/send-otp$/, limit: 30, windowSec: 60 },
  { bucket: 'tplsync', method: 'POST', re: /^\/api\/templates\/sync$/, limit: 10, windowSec: 60 },
  // Broadcasts: reads are generous (the progress screen polls), previews walk the lead tables, writes are admin clicks.
  { bucket: 'bcread', method: 'GET', re: /^\/api\/broadcasts(\/bc_[0-9a-f]{16}(\/recipients)?)?$/, limit: 240, windowSec: 60 },
  { bucket: 'bcpreview', method: 'POST', re: /^\/api\/broadcasts\/preview$/, limit: 30, windowSec: 60 },
  { bucket: 'bcwrite', method: 'POST', re: /^\/api\/broadcasts(\/bc_[0-9a-f]{16}\/(start|pause|resume|cancel|requeue-unknown))?$/, limit: 30, windowSec: 60 },
  { bucket: 'bcwrite', method: 'PATCH', re: /^\/api\/broadcasts\/bc_[0-9a-f]{16}$/, limit: 30, windowSec: 60 },
  { bucket: 'bcwrite', method: 'DELETE', re: /^\/api\/broadcasts\/bc_[0-9a-f]{16}$/, limit: 30, windowSec: 60 },
  { bucket: 'optout', method: 'PATCH', re: /^\/api\/contacts\/\d+\/opt-out$/, limit: 60, windowSec: 60 },
  { bucket: 'export', method: 'GET', re: /^\/api\/export\/(leads\.csv|full\.json)$/, limit: 10, windowSec: 3600 },
  { bucket: 'import', method: 'POST', re: /^\/api\/import\/leads$/, limit: 30, windowSec: 60 },
  { bucket: 'importcommit', method: 'POST', re: /^\/api\/import\/leads\/commit$/, limit: 120, windowSec: 60 },
  { bucket: 'staffwrite', method: 'POST', re: /^\/api\/staff(\/\d+\/reset-password)?$/, limit: 20, windowSec: 600 },
  { bucket: 'adminsetup', method: 'POST', re: /^\/api\/admin\/setup$/, limit: 5, windowSec: 600 },
]

export function routeLimit(method: string, path: string): Rule | null {
  return ROUTE_LIMITS.find((r) => r.method === method && r.re.test(path)) ?? null
}

/** Starts the limiter hit for this request (or resolves null when the route is unlimited / the caller has no identity).
 *  Await the result only after the actor passed require(); a 429 Response when over budget. */
export function startRouteLimit(req: Request, env: Env, path: string): Promise<Response | null> {
  const rule = routeLimit(req.method, path)
  if (!rule) return Promise.resolve(null)
  return (async () => {
    const who = await limitIdentity(req, env)
    if (!who || !(await hit(env.DB, `rl:${rule.bucket}:${who}`, rule.limit, rule.windowSec))) return null
    return new Response(JSON.stringify({ ok: false, error: 'rate_limited', limit: rule.bucket, retry_after: rule.windowSec }), {
      status: 429, headers: { 'content-type': 'application/json', 'retry-after': String(rule.windowSec), 'cache-control': 'no-store' },
    })
  })()
}
