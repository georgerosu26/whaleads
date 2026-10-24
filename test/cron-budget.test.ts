// The WHOLE cron firing against the free plan's 50 subrequests per invocation (D1 calls count). The counter sits outside
// runCron, so ensureSchema, the events, the progress read and the cron_last_at write are all in the total.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/db'
import { runCron, type CronJobs, DEFAULT_JOBS } from '../src/cron'
import { meterDb, type Meter } from '../src/flows/meter'
import { addHotLeads, bcRig, makeRunning, seedTemplate, type Bc } from './broadcast.helpers'

let b: Bc
beforeEach(async () => { b = await bcRig(); seedTemplate(b.r); addHotLeads(b.r, 80); })
afterEach(() => { vi.unstubAllGlobals() })
const at = (mm: number) => Date.UTC(2026, 9, 19, 5, mm, 0)

/** Runs one cron firing and returns D1 calls + fetches made by the whole invocation. */
async function whole(pace: number, withTick: boolean): Promise<{ total: number; sent: number }> {
  b.r.raw.prepare(`INSERT OR REPLACE INTO settings (key,value) VALUES ('broadcast_per_minute',?)`).run(String(pace))
  const id = await makeRunning(b)
  const m: Meter = { calls: 0 }
  let publishes = 0
  const LIVE = { idFromName: (n: string) => n, get: () => ({ broadcast: async () => { publishes++; return 0 } }) } as unknown as Env['LIVE']
  const env = { ...b.r.env, LIVE, DB: meterDb(b.r.env.DB, m) } // a fresh proxy: ensureSchema is cold, as in a new isolate
  const before = b.gw.calls.length
  const jobs: CronJobs = { ...DEFAULT_JOBS }
  if (withTick) {
    jobs.tick = async (e) => {
      for (let i = 0; i < 8; i++) await e.DB.prepare('SELECT 1').first()
      for (let i = 0; i < 4; i++) await fetch('https://flows.invalid/x', { method: 'POST', body: '{}' })
      return { resumed: 1, completed: 1, awaiting: 0, failed: 0, skipped: 0, stalled: 0, abandoned: 0, dbCalls: 8, subrequests: 4, more: false }
    }
  }
  await runCron(env, at(7), jobs)
  const gwCalls = b.gw.calls.length - before
  const sent = (b.r.raw.prepare(`SELECT COUNT(*) AS n FROM broadcast_recipients WHERE broadcast_id=? AND status='sent'`).get(id) as { n: number }).n
  return { total: m.calls + gwCalls + publishes, sent }
}

describe('a whole cron firing stays inside 50 subrequests', () => {
  for (const pace of [20, 40]) {
    for (const withTick of [false, true]) {
      it(`pace ${pace}, ${withTick ? 'with a flow tick' : 'idle flows'}`, async () => {
        const r = await whole(pace, withTick)
        expect(r.sent).toBeGreaterThan(0)
        expect(r.total).toBeLessThanOrEqual(50)
      })
    }
  }
})
