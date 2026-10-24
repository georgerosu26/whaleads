// Shared CRM types, the pipeline metadata loader and day/time helpers for the Leads, Today and Contacts screens.
import { useCallback, useEffect, useState } from 'react'
import { localDate, localTime, startOfDay, startOfNextDay, zonedToEpoch } from '../../../src/daytime'
import { api } from './api'
import { displayName } from './inbox'

export interface Stage { key: string; label: string; kind: 'open' | 'won' | 'lost'; position: number; archived?: number }
export interface Source { key: string; label: string; archived?: number }
export interface Tag { id: number; label: string; color: string }
export interface Owner { id: number; name: string; role: string }

export interface LeadT {
  id: number; contact_id: number; name: string | null; phone: string | null; wa_id: string | null; email: string | null; opted_out_at?: number | null; opt_out_source?: string | null
  source: string; status: string; stage_label: string | null; stage_kind: 'open' | 'won' | 'lost' | null; message: string | null
  created_at: number; updated_at: number; assigned_to: number | null; assigned_name: string | null; next_action_at: number | null
  lost_reason: string | null; won_at: number | null; closed_at: number | null; first_response_at: number | null; last_activity_at: number | null
  tags: Tag[]
  ctwa_clid?: string | null; ad_source_id?: string | null; attribution?: Record<string, string | null> | null
}
export interface ActivityT { id: number; kind: string; data: Record<string, any> | null; actor: string; actor_name: string | null; created_at: number }
export interface LeadDetailT {
  ok: boolean; lead: LeadT; activity: ActivityT[]; activity_next_before: number | null
  conversation: { last_message_at: number; last_inbound_at: number | null; last_preview: string | null; unread_count: number; status: string } | null
}

export const leadName = (l: { name: string | null; phone: string | null; wa_id: string | null }) => displayName(l)

export interface Meta { stages: Stage[]; sources: Source[]; tags: Tag[]; owners: Owner[] }
export type MetaState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: Meta }

/** Stages, sources, tags and owners: everything the filters and pickers need. */
export function useMeta() {
  const [state, setState] = useState<MetaState>({ status: 'loading' })
  const load = useCallback(async () => {
    setState({ status: 'loading' })
    try {
      const [s, so, t, o] = await Promise.all([
        api<{ stages: Stage[] }>('/api/stages'), api<{ sources: Source[] }>('/api/sources'),
        api<{ tags: Tag[] }>('/api/tags'), api<{ owners: Owner[] }>('/api/leads/owners'),
      ])
      setState({ status: 'ready', data: { stages: s.stages, sources: so.sources, tags: t.tags, owners: o.owners } })
    } catch (e) { setState({ status: 'error', message: (e as Error).message }) }
  }, [])
  useEffect(() => { void load() }, [load])
  return { state, reload: load }
}

export const stageTone = (kind: string | null | undefined) => (kind === 'won' ? 'green' : kind === 'lost' ? 'neutral' : 'blue')

// ---- time ------------------------------------------------------------------------------------------------

const fmtIn = (tz: string, o: Intl.DateTimeFormatOptions, ts: number) => new Intl.DateTimeFormat([], { timeZone: tz, ...o }).format(new Date(ts * 1000))

export function dueLabel(ts: number, tz: string, now = Math.floor(Date.now() / 1000)): { text: string; overdue: boolean } {
  const start = startOfDay(now, tz)
  const end = startOfNextDay(now, tz)
  const time = fmtIn(tz, { hour: 'numeric', minute: '2-digit' }, ts)
  if (ts < start) return { text: `Overdue, ${fmtIn(tz, { day: 'numeric', month: 'short' }, ts)}`, overdue: true }
  if (ts < end) return { text: `Today ${time}`, overdue: false }
  if (ts < startOfNextDay(end, tz)) return { text: `Tomorrow ${time}`, overdue: false }
  return { text: `${fmtIn(tz, { day: 'numeric', month: 'short' }, ts)} ${time}`, overdue: false }
}

export function whenLabel(ts: number, tz: string): string {
  return fmtIn(tz, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }, ts)
}

/** Preset next actions at 10:00 local, except "Today" which is 18:00 so it is still a sensible time later today. */
export function presetEpoch(preset: 'today' | 'tomorrow' | '3d' | 'week', tz: string, now = Math.floor(Date.now() / 1000)): number {
  const days = { today: 0, tomorrow: 1, '3d': 3, week: 7 }[preset]
  const [y, m, d] = localDate(startOfDay(now, tz) + 12 * 3600, tz).split('-').map(Number)
  const base = new Date(Date.UTC(y, m - 1, d + days))
  return zonedToEpoch(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), preset === 'today' ? 18 : 10, 0, tz)
}

export function epochToInputs(ts: number | null, tz: string): { date: string; time: string } {
  return ts ? { date: localDate(ts, tz), time: localTime(ts, tz) } : { date: '', time: '10:00' }
}
export function inputsToEpoch(date: string, time: string, tz: string): number | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  const t = /^(\d{2}):(\d{2})$/.exec(time || '10:00')
  if (!d || !t) return null
  return zonedToEpoch(Number(d[1]), Number(d[2]), Number(d[3]), Number(t[1]), Number(t[2]), tz)
}

export const initial = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 1).toUpperCase() || '#'

/** Only http(s) URLs become links; anything else in an ad payload is shown as plain text. */
export const safeUrl = (u: string | null | undefined): string | null => {
  if (!u) return null
  try { const p = new URL(u); return p.protocol === 'https:' || p.protocol === 'http:' ? p.toString() : null } catch { return null }
}
