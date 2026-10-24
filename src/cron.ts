// Cron entry. The trigger fires every minute: the flow tick runs on every firing, and the older 15-minute jobs
// (media retries, session/rate-limit purge, send-record repair, template sync, dead push subscriptions) run only on
// minutes divisible by 15, exactly as before. The finished-run purge runs once a day at 03:00 UTC.
import type { Env } from './db'
import { ensureSchema, logEvent } from './db'
import { LIMITS } from './flows/types'
import { broadcastStep, type StepResult } from './broadcasts/step'
import { purgeFinishedRuns, tick, type TickResult } from './flows/tick'
import { scheduled as mediaJobs } from './media'
import { purgeDeadSubscriptions } from './push'
import { syncPendingTemplates } from './templates'

export interface CronJobs {
  tick: (env: Env, opts: { dbBudget: number; sweep: boolean; now: number }) => Promise<TickResult>
  /** The broadcast sender. Runs after the flow tick with whatever D1 calls and subrequests it left. */
  broadcasts?: (env: Env, opts: { dbBudget: number; subrequestBudget: number; now: number }) => Promise<StepResult>
  quarterHour: (env: Env) => Promise<void>
  daily: (env: Env, now: number) => Promise<void>
}

/**
 * Workers Free allows 50 subrequests per invocation; keep two in hand. D1 calls COUNT toward that limit: Cloudflare defines a
 * subrequest as "any request a Worker makes using the Fetch API or to Cloudflare services like R2, KV, or D1"
 * (https://developers.cloudflare.com/workers/platform/limits/), and the D1 limits table lists "Queries per Worker invocation
 * (read subrequest limits): 50 (Free)" (https://developers.cloudflare.com/d1/platform/limits/). Checked 2026-10-21.
 */
export const BROADCAST_SUBREQUEST_CAP = 48
/**
 * D1 calls runCron itself makes outside any job meter, worst case: ensureSchema (exec + version read = 2), the flow_tick event,
 * the broadcast_step event, one cron_error event, the cron_last_at write. The broadcast step is handed its budget net of these.
 */
export const CRON_FIXED_OVERHEAD = 6
export const BROADCAST_QUARTER_RESERVE = 30
export const BROADCAST_MIN_SLICE = 6

export const isQuarterHour = (scheduledTime: number) => new Date(scheduledTime).getUTCMinutes() % 15 === 0
export const isDailyRun = (scheduledTime: number) => { const d = new Date(scheduledTime); return d.getUTCHours() === 3 && d.getUTCMinutes() === 0 }

export const DEFAULT_JOBS: CronJobs = {
  tick: (env, o) => tick(env, o),
  broadcasts: (env, o) => broadcastStep(env, o),
  quarterHour: async (env) => { await mediaJobs(env); await syncPendingTemplates(env).catch(() => {}); await purgeDeadSubscriptions(env).catch(() => {}) },
  daily: async (env, now) => { await purgeFinishedRuns(env, Math.floor(now / 1000)) },
}

/**
 * One cron firing. Awaited by the caller (not waitUntil): a cron invocation may run for minutes, whereas
 * waitUntil work is cut 30 s after the handler returns. Each job is isolated so one failing never skips the rest.
 */
export async function runCron(env: Env, scheduledTime: number = Date.now(), jobs: CronJobs = DEFAULT_JOBS): Promise<{ ran: string[] }> {
  const ran: string[] = []
  await ensureSchema(env.DB)
  const quarter = isQuarterHour(scheduledTime)
  const guard = async (name: string, fn: () => Promise<unknown>) => {
    ran.push(name)
    try { await fn() } catch (e) { await logEvent(env.DB, 'cron_error', { job: name, error: String(e).slice(0, 300) }).catch(() => {}) }
  }
  const dbBudget = quarter ? LIMITS.TICK_DB_CALLS_SHARED : LIMITS.TICK_DB_CALLS
  let spent = { db: 0, sub: 0 }
  await guard('flow_tick', async () => {
    const r = await jobs.tick(env, { dbBudget, sweep: quarter, now: Math.floor(scheduledTime / 1000) })
    spent = { db: r.dbCalls ?? 0, sub: (r.dbCalls ?? 0) + (r.subrequests ?? 0) }
    if (r.resumed || r.stalled || r.abandoned) await logEvent(env.DB, 'flow_tick', { ...r })
  })
  // Broadcasts get what the tick left. Flows run first and keep their budget. Free plan: 50 subrequests per invocation, D1 calls
  // included; a quarter-hour firing also reserves BROADCAST_QUARTER_RESERVE for the media / template / push jobs.
  if (jobs.broadcasts) {
    const subBudget = BROADCAST_SUBREQUEST_CAP - CRON_FIXED_OVERHEAD - spent.sub - (quarter ? BROADCAST_QUARTER_RESERVE : 0)
    const dbLeft = dbBudget - spent.db - CRON_FIXED_OVERHEAD
    if (dbLeft >= BROADCAST_MIN_SLICE && subBudget >= BROADCAST_MIN_SLICE) {
      await guard('broadcasts', async () => {
        const r = await jobs.broadcasts!(env, { dbBudget: dbLeft, subrequestBudget: subBudget, now: Math.floor(scheduledTime / 1000) })
        if (r.sent || r.failed || r.unknown || r.paused) await logEvent(env.DB, 'broadcast_step', { ...r })
      })
    }
  }
  if (quarter) await guard('quarter_hour', () => jobs.quarterHour(env))
  if (isDailyRun(scheduledTime)) await guard('daily', () => jobs.daily(env, scheduledTime))
  // One overwritten row (never a per-tick events row): /api/health reports it so a silent cron is visible.
  await env.DB.prepare(`INSERT INTO meta (key,value) VALUES ('cron_last_at', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(String(Math.floor(Date.now() / 1000))).run().catch(() => {})
  return { ran }
}
