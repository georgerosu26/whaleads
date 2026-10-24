// /api/broadcasts: list, detail, recipients (all staff); preview, create, edit, start, pause, resume, cancel,
// requeue-unknown and delete (admin only). Behind the auth gate in index.ts; every write has a ROUTE_LIMITS row.
import type { Actor } from '../auth'
import { require as requireRole } from '../auth'
import { Bad } from '../crm'
import type { Env } from '../db'
import { json } from '../leads'
import {
  cancel, createDraft, getBroadcast, listBroadcasts, patchDraft, pause, preview, recipientsPage, remove, requeueUnknown, resume, start, view,
} from '../broadcasts/store'
import { readJson } from './auth'

const fail = (e: Bad) => json({ ok: false, ...e.extra, error: e.extra.error ?? e.message, message: e.message, ...(e.field ? { field: e.field } : {}) }, e.status)

export async function handleBroadcasts(req: Request, env: Env, _ctx: ExecutionContext, path: string, actor: Actor | null, url: URL): Promise<Response | null> {
  const m = /^\/api\/broadcasts(?:\/(preview)|\/(bc_[0-9a-f]{16})(?:\/(recipients|start|pause|resume|cancel|requeue-unknown))?)?$/.exec(path)
  if (!m) return null
  const admin = () => requireRole(actor, 'admin')
  const body = async () => (await readJson(req)) ?? {}
  try {
    if (m[1]) return req.method === 'POST' ? (admin() ?? json({ ok: true, ...(await preview(env, await body())) })) : null
    if (!m[2]) {
      if (req.method === 'GET') { const r = await listBroadcasts(env.DB, url.searchParams.get('cursor')); return json({ ok: true, broadcasts: r.rows, next: r.next }) }
      if (req.method === 'POST') return admin() ?? json({ ok: true, broadcast: await createDraft(env, await body(), actor) }, 201)
      return null
    }
    const id = m[2]
    switch (m[3]) {
      case undefined: {
        if (req.method === 'GET') { const b = await getBroadcast(env.DB, id); return b ? json({ ok: true, broadcast: view(b) }) : json({ ok: false, error: 'not_found' }, 404) }
        if (req.method === 'PATCH') return admin() ?? json({ ok: true, broadcast: await patchDraft(env, id, await body()) })
        if (req.method === 'DELETE') return admin() ?? (await remove(env, id), json({ ok: true }))
        return null
      }
      case 'recipients': {
        if (req.method !== 'GET') return null
        if (!(await getBroadcast(env.DB, id))) return json({ ok: false, error: 'not_found' }, 404)
        const r = await recipientsPage(env.DB, id, url.searchParams.get('status'), url.searchParams.get('cursor'))
        return json({ ok: true, recipients: r.rows, next: r.next })
      }
      case 'start': return req.method === 'POST' ? (admin() ?? json({ ok: true, broadcast: await start(env, id, (await body()).total) })) : null
      case 'pause': return req.method === 'POST' ? (admin() ?? json({ ok: true, broadcast: await pause(env, id) })) : null
      case 'resume': return req.method === 'POST' ? (admin() ?? json({ ok: true, broadcast: await resume(env, id) })) : null
      case 'cancel': return req.method === 'POST' ? (admin() ?? json({ ok: true, broadcast: await cancel(env, id) })) : null
      case 'requeue-unknown': return req.method === 'POST' ? (admin() ?? json({ ok: true, ...(await requeueUnknown(env, id)) })) : null
    }
    return null
  } catch (e) {
    if (e instanceof Bad) return fail(e)
    throw e
  }
}
