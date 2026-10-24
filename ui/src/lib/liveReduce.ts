// Pure reducers for live events. They sit next to the poll reducers (mergePoll, mergeFirstPage, settleSend) and obey the
// same rules, so an event and a poll carrying the same change can never produce a duplicate or move anything backwards.
import type { ConvRow, Msg } from './inbox'

const RANK: Record<string, number> = { failed: 9, read: 3, delivered: 2, sent: 1 }
/** Statuses only move forward; "failed" is terminal (same rule as the server). */
export const statusAhead = (cur: string | null | undefined, next: string | null | undefined) =>
  !!next && cur !== 'failed' && (next === 'failed' || (RANK[next] ?? 0) > (RANK[cur ?? ''] ?? 0))

/** A delivery receipt by event, by wamid (or row id). Never moves a tick backwards. */
export function applyMessageStatus(msgs: Msg[], u: { id?: number; wamid?: string; status: string | null }): Msg[] {
  let hit = false
  const out = msgs.map((m) => {
    if (m.local || !((u.id && m.id === u.id) || (u.wamid && m.wamid === u.wamid))) return m
    if (!statusAhead(m.status, u.status)) return m
    hit = true
    return { ...m, status: u.status }
  })
  return hit ? out : msgs
}

/** The list order the server uses: unread first, then newest, then highest contact id. */
export const convOrder = (a: ConvRow, b: ConvRow) =>
  Number(b.unread_count > 0) - Number(a.unread_count > 0) || b.last_message_at - a.last_message_at || b.contact_id - a.contact_id

/**
 * A conversation.update on the unfiltered list. Replaces the row (or inserts it) and re-sorts. A row that is not loaded and
 * would sort below the last loaded one is left out when more pages exist (it shows up when that page loads).
 * An update older than the row we hold is ignored (last_message_at never goes backwards).
 */
export function applyConversation(rows: ConvRow[], u: ConvRow, hasMore: boolean): ConvRow[] {
  const i = rows.findIndex((r) => r.contact_id === u.contact_id)
  if (i >= 0) {
    const cur = rows[i]!
    const next = u.last_message_at < cur.last_message_at ? { ...u, last_message_at: cur.last_message_at, last_preview: cur.last_preview } : u
    return [...rows.slice(0, i), next, ...rows.slice(i + 1)].sort(convOrder)
  }
  const last = rows[rows.length - 1]
  if (hasMore && last && convOrder(u, last) > 0) return rows
  return [...rows, u].sort(convOrder)
}

// flow runs. A `flow.run` frame is status-only (no trace), so it patches a run we hold and says "refetch" for one we do not.
export interface RunLike { id: number; status: string; current_node_id: string | null; updated_at: number; completed_at: number | null }
export interface RunFrameLike { run_id: number; status: string; node: string | null }
const TERMINAL = new Set(['completed', 'failed', 'abandoned', 'cancelled'])
export const runTerminal = (s: string) => TERMINAL.has(s)

/** Patches the held run; null when the run is not in the list (the caller refetches the first page). A terminal run never goes back to running. */
export function applyFlowRunFrame<T extends RunLike>(rows: T[], f: RunFrameLike, now: number = Date.now()): T[] | null {
  const i = rows.findIndex((r) => r.id === f.run_id)
  if (i < 0) return null
  const cur = rows[i]!
  if (runTerminal(cur.status) && !runTerminal(f.status)) return rows
  if (cur.status === f.status && cur.current_node_id === f.node) return rows
  const next = { ...cur, status: f.status, current_node_id: f.node, updated_at: now, completed_at: runTerminal(f.status) ? (cur.completed_at ?? now) : cur.completed_at }
  return [...rows.slice(0, i), next, ...rows.slice(i + 1)]
}

/** A refetched first page over the loaded list: first-page rows win, older pages stay, newest first. */
export function mergeRunsFirstPage<T extends { id: number }>(cur: T[], first: T[]): T[] {
  const ids = new Set(first.map((r) => r.id))
  return [...first, ...cur.filter((r) => !ids.has(r.id))].sort((a, b) => b.id - a.id)
}
