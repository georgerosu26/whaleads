// Opt-out (plan section E). Consent belongs to the person, so it lives on `contacts`. Three sources:
// 'keyword' (the contact wrote STOP), 'meta_131050' (Meta refused a marketing send), 'manual' (staff toggled it).
// START clears a keyword opt-out only: a contact staff or Meta opted out stays out until staff say otherwise.
import type { Env } from '../db'
import { publishLater } from '../live'

/** Whole-message matches only (trimmed, lower-cased, trailing punctuation dropped). "please stop" does not match. */
export const OPT_OUT_KEYWORDS = ['stop', 'stop all', 'unsubscribe', 'opt out', 'optout', 'stop messages', 'no more', 'band karo', 'band'] as const
export const OPT_IN_KEYWORDS = ['start', 'subscribe'] as const

export function classifyKeyword(body: string | null | undefined): 'out' | 'in' | null {
  if (!body) return null
  const t = body.trim().toLowerCase().replace(/[\s.!?,;:]+$/g, '').replace(/\s+/g, ' ')
  if (!t || t.length > 20) return null
  if ((OPT_OUT_KEYWORDS as readonly string[]).includes(t)) return 'out'
  if ((OPT_IN_KEYWORDS as readonly string[]).includes(t)) return 'in'
  return null
}

const activity = (env: Env, contactId: number, kind: 'opted_out' | 'opted_in', actor: string, data: unknown, at: number) =>
  env.DB.prepare(`INSERT INTO activity (contact_id,actor,kind,data,created_at) SELECT ?1,?2,?3,?4,?5 WHERE changes() > 0`)
    .bind(contactId, actor, kind, JSON.stringify(data), at)

/** Inbound text matched a keyword. Idempotent; sends no auto-reply (the owner's flows may answer). */
export async function applyKeyword(env: Env, ctx: Pick<ExecutionContext, 'waitUntil'> | undefined, contactId: number, kind: 'out' | 'in', at = Math.floor(Date.now() / 1000)): Promise<boolean> {
  const stmts = kind === 'out'
    ? [env.DB.prepare(`UPDATE contacts SET opted_out_at=?2, opt_out_source='keyword' WHERE id=?1 AND opted_out_at IS NULL`).bind(contactId, at), activity(env, contactId, 'opted_out', 'system', { source: 'keyword' }, at)]
    : [env.DB.prepare(`UPDATE contacts SET opted_out_at=NULL, opt_out_source=NULL WHERE id=?1 AND opt_out_source='keyword'`).bind(contactId), activity(env, contactId, 'opted_in', 'system', { source: 'keyword' }, at)]
  const res = await env.DB.batch(stmts)
  const changed = (res[0]?.meta.changes ?? 0) > 0
  if (changed) publishContact(env, ctx, contactId)
  return changed
}

/** Staff pressed the toggle. Source 'manual'. */
export function manualStmts(env: Env, contactId: number, optedOut: boolean, actor: string, at: number): D1PreparedStatement[] {
  return [
    optedOut
      ? env.DB.prepare(`UPDATE contacts SET opted_out_at=?2, opt_out_source='manual' WHERE id=?1 AND opted_out_at IS NULL`).bind(contactId, at)
      : env.DB.prepare(`UPDATE contacts SET opted_out_at=NULL, opt_out_source=NULL WHERE id=?1 AND opted_out_at IS NOT NULL`).bind(contactId),
    activity(env, contactId, optedOut ? 'opted_out' : 'opted_in', actor, { source: 'manual' }, at),
  ]
}

/** Meta 131050: the contact stopped marketing messages. No-op if already out. */
export function metaOptOutStmts(env: Env, contactId: number, at: number): D1PreparedStatement[] {
  return [
    env.DB.prepare(`UPDATE contacts SET opted_out_at=?2, opt_out_source='meta_131050' WHERE id=?1 AND opted_out_at IS NULL`).bind(contactId, at),
    activity(env, contactId, 'opted_out', 'system', { source: 'meta_131050' }, at),
  ]
}

/** Meta 131050 seen on a status webhook: the contact is found through the recipient's wamid. No-op if already out. */
export function metaOptOutByWamid(env: Env, wamid: string, at: number): D1PreparedStatement[] {
  const cid = `CAST((SELECT contact_id FROM broadcast_recipients WHERE wamid=?1) AS INTEGER)`
  return [
    env.DB.prepare(`UPDATE contacts SET opted_out_at=?2, opt_out_source='meta_131050' WHERE id=${cid} AND opted_out_at IS NULL`).bind(wamid, at),
    env.DB.prepare(`INSERT INTO activity (contact_id,actor,kind,data,created_at) SELECT ${cid},'system','opted_out',?3,?2 WHERE changes() > 0`)
      .bind(wamid, at, JSON.stringify({ source: 'meta_131050' })),
  ]
}

/** The contact's newest lead carries the live `lead.update`, so open boards refresh. */
export function publishContact(env: Env, ctx: Pick<ExecutionContext, 'waitUntil'> | undefined, contactId: number): void {
  publishLater(env, ctx, async () => {
    const l = await env.DB.prepare(`SELECT id, status, assigned_to, source FROM leads WHERE contact_id=? ORDER BY created_at DESC, id DESC LIMIT 1`).bind(contactId).first<Record<string, any>>()
    return l ? [{ type: 'lead.update' as const, ts: Date.now(), data: { id: l.id, contact_id: contactId, status: l.status, owner: l.assigned_to, source: l.source } }] : []
  })
}
