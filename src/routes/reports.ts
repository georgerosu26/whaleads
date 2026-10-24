// GET /api/reports/overview?from=YYYY-MM-DD&to=YYYY-MM-DD. Any signed-in staff member; the auth gate in index.ts already ran.
import type { Actor } from '../auth'
import type { Env } from '../db'
import { json } from '../leads'
import { Bad } from '../crm'
import { overview } from '../reports'

export async function handleReports(req: Request, env: Env, path: string, _actor: Actor | null, url: URL): Promise<Response | null> {
  if (path !== '/api/reports/overview' || req.method !== 'GET') return null
  try {
    return json({ ok: true, ...(await overview(env, url.searchParams.get('from'), url.searchParams.get('to'))) })
  } catch (e) {
    if (e instanceof Bad) return json({ ok: false, error: e.message, ...(e.field ? { field: e.field } : {}) }, e.status)
    throw e
  }
}
