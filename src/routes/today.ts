// GET /api/today: the day's work, bucketed in the instance timezone.
import type { Actor } from '../auth'
import type { Env } from '../db'
import { json } from '../leads'
import { todayBuckets } from '../crm'

export async function handleToday(req: Request, env: Env, path: string, _actor: Actor | null): Promise<Response | null> {
  if (path !== '/api/today' || req.method !== 'GET') return null
  return json({ ok: true, ...(await todayBuckets(env)) })
}
