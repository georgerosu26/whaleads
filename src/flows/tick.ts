// The cron tick (every minute). Resumes due runs oldest first, within a D1 call budget, and sweeps the stragglers.
// Free-plan sizing: an invocation may make 50 D1 calls; the tick spends at most LIMITS.TICK_DB_CALLS (40) alone, or
// LIMITS.TICK_DB_CALLS_SHARED (20) on the quarter-hour minutes when the media / purge jobs share the invocation.
import type { Env } from '../db'
import { meteredEnv, nowSec, type StepOpts } from './engine'
import { resumeRun } from './resume'
import { LIMITS } from './types'

export interface TickOpts extends StepOpts {
  /** D1 calls this tick may spend. */
  dbBudget?: number
  /** Also abandon runs past their expiry (cheap, but only needed every few minutes). */
  sweep?: boolean
  /** Due runs to resume at most. */
  max?: number
}

export interface TickResult { resumed: number; completed: number; awaiting: number; failed: number; skipped: number; stalled: number; abandoned: number; dbCalls: number; /** Outbound fetches the tick made (D1 calls are counted in dbCalls). */ subrequests: number; more: boolean }

export async function tick(env: Env, opts: TickOpts = {}): Promise<TickResult> {
  const m: { calls: number; subrequests?: number } = { calls: 0 }
  const menv = meteredEnv(env, m)
  const now = opts.now ?? nowSec()
  const budget = opts.dbBudget ?? LIMITS.TICK_DB_CALLS
  const max = opts.max ?? LIMITS.RESUMES_PER_TICK
  const res: TickResult = { resumed: 0, completed: 0, awaiting: 0, failed: 0, skipped: 0, stalled: 0, abandoned: 0, dbCalls: 0, subrequests: 0, more: false }

  // Due timers and expired reply waits, flows that are live only (a paused flow keeps its runs parked).
  const { results: due } = await menv.DB.prepare(
    `SELECT r.id, r.await_kind FROM flow_runs r JOIN flows f ON f.id = r.flow_id
      WHERE r.status = 'awaiting' AND r.resume_at <= ? AND f.status = 'active' ORDER BY r.resume_at, r.id LIMIT ?`,
  ).bind(now, max + 1).all<{ id: number; await_kind: 'timer' | 'reply' }>()
  res.more = due.length > max

  for (const d of due.slice(0, max)) {
    // A resume spends RESUME_RESERVE on its own bookkeeping (read, CAS, context reload, final batch) plus its step, which
    // is capped so the whole resume still fits the tick's remaining budget.
    const left = budget - m.calls - LIMITS.RESUME_RESERVE
    if (left < 1) { res.more = true; break }
    const r = await resumeRun(menv, d.id, d.await_kind === 'timer' ? { kind: 'timer' } : { kind: 'timeout' }, { ...opts, now, dbCap: Math.min(opts.dbCap ?? LIMITS.STEP_DB_CALLS, left) })
    if (!r.resumed) { res.skipped++; continue }
    res.resumed++
    res[r.status]++
  }

  // A run left `running` this long was a step that died mid-flight (isolate evicted). Fail it so it is visible.
  if (m.calls < budget) {
    const s = await menv.DB.prepare(`UPDATE flow_runs SET step=step+1, status='failed', error='stalled', updated_at=?1, completed_at=?1 WHERE status='running' AND updated_at < ?2`).bind(now, now - LIMITS.STALL_S).run()
    res.stalled = s.meta.changes ?? 0
  }
  if (opts.sweep && m.calls < budget) {
    const a = await menv.DB.prepare(`UPDATE flow_runs SET step=step+1, status='abandoned', error='expired', updated_at=?1, completed_at=?1 WHERE status='awaiting' AND expires_at IS NOT NULL AND expires_at <= ?1`).bind(now).run()
    res.abandoned = a.meta.changes ?? 0
  }
  res.dbCalls = m.calls
  res.subrequests = m.subrequests ?? 0
  return res
}

/** Daily: delete finished runs past retention (setting `flow_run_retention_days`, default 90). Activity rows stay. */
export async function purgeFinishedRuns(env: Env, now = nowSec()): Promise<number> {
  const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'flow_run_retention_days'`).first<{ value: string }>()
  const n = Number(row ? safeParse(row.value) : NaN)
  const days = Number.isFinite(n) && n >= 7 && n <= 3650 ? Math.floor(n) : LIMITS.RETENTION_DAYS
  const r = await env.DB.prepare(`DELETE FROM flow_runs WHERE completed_at IS NOT NULL AND completed_at < ?`).bind(now - days * 86400).run()
  return r.meta.changes ?? 0
}

const safeParse = (s: string): unknown => { try { return JSON.parse(s) } catch { return s } }
