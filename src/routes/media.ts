// GET /api/media/:messageId. Behind the one auth gate in index.ts (staff session or ADMIN_KEY).
import type { Env } from '../db'
import { serveMedia } from '../media'

/** Returns null when the path is not a media route. */
export async function handleMedia(req: Request, env: Env, ctx: ExecutionContext, path: string): Promise<Response | null> {
  const m = path.match(/^\/api\/media\/(\d+)$/)
  if (!m) return null
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('method not allowed', { status: 405 })
  return serveMedia(req, env, ctx, Number(m[1]))
}
