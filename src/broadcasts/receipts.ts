import type { Env } from '../db'
import { metaOptOutByWamid } from './optout'

/** Statements keeping broadcast_recipients and the broadcasts counters in step with a delivery status. */
export function broadcastStatusStmts(env: Env, wamid: string, status: string, at: number, code: number | null, message: string): D1PreparedStatement[] {
  const old = `(SELECT status FROM broadcast_recipients WHERE wamid=?1)`
  const bid = `(SELECT broadcast_id FROM broadcast_recipients WHERE wamid=?1)`
  const s: D1PreparedStatement[] = []
  if (status === 'delivered' || status === 'read') {
    s.push(env.DB.prepare(`UPDATE broadcasts SET delivered=delivered+1 WHERE id=${bid} AND ${old}='sent'`).bind(wamid))
    if (status === 'read') s.push(env.DB.prepare(`UPDATE broadcasts SET read=read+1 WHERE id=${bid} AND ${old} IN ('sent','delivered')`).bind(wamid))
    s.push(env.DB.prepare(
      `UPDATE broadcast_recipients SET status=?2, updated_at=?3 WHERE wamid=?1 AND status IN ('sent','delivered') AND ${rank('status')} < ${rank('?2')}`,
    ).bind(wamid, status, at))
  } else if (status === 'failed') {
    s.push(env.DB.prepare(`UPDATE broadcasts SET sent=MAX(0, sent-1), failed=failed+1 WHERE id=${bid} AND ${old}='sent'`).bind(wamid))
    if (code === 131050) s.push(...metaOptOutByWamid(env, wamid, at)) // reads the recipient row before it moves, so ahead of the update
    s.push(env.DB.prepare(
      `UPDATE broadcast_recipients SET status='failed', error_code=?2, error_message=?3, updated_at=?4 WHERE wamid=?1 AND status='sent'`,
    ).bind(wamid, code, message.slice(0, 300) || null, at))
  }
  return s
}

export const rank = (col: string) => `CASE ${col} WHEN 'read' THEN 3 WHEN 'delivered' THEN 2 WHEN 'sent' THEN 1 ELSE 0 END`
