// Broadcasts: API client, shared types and the pure helpers the wizard and detail page lean on (tested in test/broadcasts.ui.test.ts).
import { useCallback, useEffect, useRef, useState } from 'react'
import { FIELDS, type FieldName } from '../../../src/broadcasts/params'
import { paramProblem, placeholders, renderParams } from '../../../src/templateRules'
import { ApiError, api } from './api'
import { useLiveEvents } from './live'
import type { Tpl } from './templates'

/** Mirrors MAX_AUDIENCE in src/broadcasts/audience.ts (a test pins them together; importing it would drag Worker types into the UI build). */
export const MAX_AUDIENCE = 50_000
export { FIELDS }
export type { FieldName }

export type BroadcastStatus = 'draft' | 'queued' | 'running' | 'paused' | 'cancelled' | 'finished' | 'failed'
export type RecipientStatus = 'queued' | 'sending' | 'sent' | 'delivered' | 'read' | 'failed' | 'skipped' | 'unknown'
export type ParamSpec = { kind: 'fixed'; value: string } | { kind: 'field'; field: FieldName; fallback: string }
export interface ParamsSpec { body: ParamSpec[]; header: ParamSpec[] }
export interface BroadcastFilter { tags: number[]; tag_mode: 'any' | 'all'; stage: string | null; all: boolean }
export interface Excluded { opted_out: number; no_phone: number; duplicate: number }

export interface Broadcast {
  id: string; name: string; template_id: string; template_name: string; language: string; category: string
  params: ParamsSpec | Record<string, never>; filter: Partial<BroadcastFilter>; status: BroadcastStatus; pause_reason: string | null
  total: number; excluded: number; excluded_detail: Excluded | null
  sent: number; delivered: number; read: number; failed: number
  /** recipients with an unknown outcome (a subset of `failed`) */
  unknown: number
  created_by: string | null; created_at: number; started_at: number | null; finished_at: number | null; updated_at: number
}
export interface Recipient {
  contact_id: string; lead_id: string | null; status: RecipientStatus; wamid: string | null
  error_code: number | null; error_message: string | null; attempts: number; sent_at: number | null; updated_at: number
  name: string | null; phone: string | null
}
export interface SampleRow { contact_id: number; lead_id: number | null; name: string | null; phone: string | null; params: string | null }
export interface Preview {
  matched: number; contacts: number; total: number; excluded: Excluded; excluded_total: number; sample: SampleRow[]
  template: { id: string; name: string; category: string; header_format: string } | null; filter: BroadcastFilter
}
/** The `broadcast.progress` live frame: counts only. */
export interface ProgressFrame { id: string; status: BroadcastStatus; pause_reason: string | null; total: number; sent: number; delivered: number; read: number; failed: number }

const q = (o: Record<string, string | null | undefined>) => {
  const s = new URLSearchParams()
  for (const [k, v] of Object.entries(o)) if (v) s.set(k, v)
  const t = s.toString()
  return t ? `?${t}` : ''
}

export const broadcastsApi = {
  list: (cursor?: string | null) => api<{ broadcasts: Broadcast[]; next: string | null }>(`/api/broadcasts${q({ cursor })}`),
  get: (id: string) => api<{ broadcast: Broadcast }>(`/api/broadcasts/${id}`),
  recipients: (id: string, status?: string | null, cursor?: string | null) =>
    api<{ recipients: Recipient[]; next: string | null }>(`/api/broadcasts/${id}/recipients${q({ status, cursor })}`),
  preview: (body: { filter: BroadcastFilter; template_id?: string; params?: ParamsSpec }) => api<Preview>('/api/broadcasts/preview', { method: 'POST', body }),
  create: (body: { name: string; template_id: string; params: ParamsSpec; filter: BroadcastFilter }) => api<{ broadcast: Broadcast }>('/api/broadcasts', { method: 'POST', body }),
  patch: (id: string, body: { name: string; template_id: string; params: ParamsSpec; filter: BroadcastFilter }) => api<{ broadcast: Broadcast }>(`/api/broadcasts/${id}`, { method: 'PATCH', body }),
  start: (id: string, total: number) => api<{ broadcast: Broadcast }>(`/api/broadcasts/${id}/start`, { method: 'POST', body: { total } }),
  act: (id: string, action: 'pause' | 'resume' | 'cancel') => api<{ broadcast: Broadcast }>(`/api/broadcasts/${id}/${action}`, { method: 'POST' }),
  requeueUnknown: (id: string) => api<{ requeued: number; broadcast: Broadcast }>(`/api/broadcasts/${id}/requeue-unknown`, { method: 'POST' }),
  remove: (id: string) => api<{ ok: true }>(`/api/broadcasts/${id}`, { method: 'DELETE' }),
}

/** Plain words for a failed call. A 403 means a staff session reached an admin action (the controls are hidden, but never trust that). */
export function broadcastErrorText(e: unknown): string {
  if (e instanceof ApiError && e.status === 403) return 'Only an admin can do that.'
  if (e instanceof ApiError && e.status === 429) return 'Too many requests. Wait a moment and try again.'
  return (e as Error)?.message || 'Something went wrong.'
}

// ---- status vocabulary -------------------------------------------------------------------------------------------

export const STATUS_TONE: Record<BroadcastStatus, string> = { draft: 'neutral', queued: 'blue', running: 'green', paused: 'amber', cancelled: 'neutral', finished: 'teal', failed: 'coral' }
export const STATUS_LABEL: Record<BroadcastStatus, string> = { draft: 'Draft', queued: 'Queued', running: 'Sending', paused: 'Paused', cancelled: 'Cancelled', finished: 'Finished', failed: 'Failed' }
export const STATUS_FILTERS: BroadcastStatus[] = ['draft', 'queued', 'running', 'paused', 'finished', 'cancelled', 'failed']
export const isTerminal = (s: BroadcastStatus) => s === 'cancelled' || s === 'finished' || s === 'failed'
export const canPause = (s: BroadcastStatus) => s === 'queued' || s === 'running'
export const canCancel = (s: BroadcastStatus) => s === 'draft' || s === 'queued' || s === 'running' || s === 'paused'
export const canDelete = (s: BroadcastStatus) => s === 'draft' || isTerminal(s)

export const RECIPIENT_TONE: Record<RecipientStatus, string> = { queued: 'neutral', sending: 'blue', sent: 'blue', delivered: 'teal', read: 'green', failed: 'coral', skipped: 'neutral', unknown: 'amber' }
export const RECIPIENT_LABEL: Record<RecipientStatus, string> = { queued: 'Waiting', sending: 'Sending', sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Failed', skipped: 'Skipped', unknown: 'Unknown' }
export const RECIPIENT_STATUSES = Object.keys(RECIPIENT_LABEL) as RecipientStatus[]

// ---- counts, progress and pace ------------------------------------------------------------------------------------

/** Share of the audience that has been handled (sent or failed), 0 to 100. */
export function progressPct(b: Pick<Broadcast, 'total' | 'sent' | 'failed' | 'status'>): number {
  if (b.status === 'finished' && b.total > 0) return 100
  if (b.total <= 0) return 0
  return Math.max(0, Math.min(100, Math.round(((b.sent + b.failed) / b.total) * 100)))
}

/** Recipients still waiting to go out. Terminal broadcasts have none (cancelled ones skipped the rest). */
export function waiting(b: Pick<Broadcast, 'total' | 'sent' | 'failed' | 'status'>): number {
  return isTerminal(b.status) ? 0 : Math.max(0, b.total - b.sent - b.failed)
}

/** Whole minutes for `total` messages at `perMinute` (at least 1 for a non-empty audience). */
export function estimateMinutes(total: number, perMinute: number): number {
  if (total <= 0 || perMinute <= 0) return 0
  return Math.max(1, Math.ceil(total / perMinute))
}

/** "about 48 min at 20 per minute" / "about 2 h 5 min at 20 per minute". */
export function paceLabel(total: number, perMinute: number): string {
  const m = estimateMinutes(total, perMinute)
  if (!m) return ''
  const t = m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`
  return `about ${t} at ${perMinute} per minute`
}

/** Unique-recipient cap per rolling 24 h for a WhatsApp messaging tier, or null when unknown/unlimited. */
export function tierCap(tier: string | null | undefined): number | null {
  const t = (tier ?? '').toUpperCase()
  if (t === 'TIER_250') return 250
  if (t === 'TIER_1K') return 1_000
  if (t === 'TIER_10K') return 10_000
  if (t === 'TIER_100K') return 100_000
  return null
}

/** The warning shown when the audience is bigger than the number's daily cap; null when it fits or the tier is unknown. */
export function tierWarning(total: number, tier: string | null | undefined): string | null {
  const cap = tierCap(tier)
  if (cap === null || total <= cap) return null
  return `Your WhatsApp number can message about ${cap.toLocaleString('en')} people a day and this audience is ${total.toLocaleString('en')}. Meta may refuse the rest; the broadcast will pause if it does.`
}

// ---- audience ---------------------------------------------------------------------------------------------------

export const emptyFilter = (): BroadcastFilter => ({ tags: [], tag_mode: 'any', stage: null, all: false })

/** What stops step 1 from moving on; null when the audience is well-formed. Mirrors the server's parseFilter. */
export function filterIssue(f: BroadcastFilter): string | null {
  if (f.all) return null
  if (!f.tags.length && !f.stage) return 'Pick at least one tag or a stage, or choose everyone.'
  return null
}

/** Typing the number of recipients is the confirmation for an all-contacts broadcast. Other audiences need none. */
export function confirmMatches(all: boolean, typed: string, total: number): boolean {
  if (!all) return true
  return typed.replace(/[\s,]/g, '') === String(total)
}

export const audienceTooLarge = (total: number) => total > MAX_AUDIENCE

export function excludedLine(e: Excluded): string {
  const parts: string[] = []
  if (e.opted_out) parts.push(`${e.opted_out.toLocaleString('en')} opted out`)
  if (e.no_phone) parts.push(`${e.no_phone.toLocaleString('en')} with no phone number`)
  if (e.duplicate) parts.push(`${e.duplicate.toLocaleString('en')} duplicate${e.duplicate === 1 ? '' : 's'} (one message per person)`)
  return parts.join(' · ')
}

// ---- template choice ----------------------------------------------------------------------------------------------

/** Approved, sendable MARKETING or UTILITY only. Authentication codes never go through a broadcast. */
export const broadcastable = (t: Tpl): boolean => t.status === 'APPROVED' && t.sendable && (t.category === 'MARKETING' || t.category === 'UTILITY')

/** Marketing copy should tell people how to stop. True when the footer or body already says so. */
export function hasOptOutHint(t: Pick<Tpl, 'body' | 'footer'>): boolean {
  return /\b(stop|unsubscribe|opt[\s-]?out)\b/i.test(`${t.body} ${t.footer ?? ''}`)
}

// ---- params -------------------------------------------------------------------------------------------------------

export const FIELD_LABEL: Record<FieldName, string> = {
  'contact.name': 'Contact name', 'contact.phone': 'Contact phone',
  'lead.stage': 'Lead stage', 'lead.source': 'Lead source', 'lead.owner': 'Lead owner',
}

export const blankParam = (): ParamSpec => ({ kind: 'fixed', value: '' })
export const blankParams = (body: number, header: number): ParamsSpec => ({ body: Array.from({ length: body }, blankParam), header: Array.from({ length: header }, blankParam) })

/** Switching kind keeps what was typed where it still makes sense. */
export function setKind(p: ParamSpec, kind: ParamSpec['kind']): ParamSpec {
  if (p.kind === kind) return p
  if (p.kind === 'field') return { kind: 'fixed', value: p.fallback }
  return { kind: 'field', field: 'contact.name', fallback: p.value }
}

/** Adjust stored params to a template's placeholder counts (padding with blanks, dropping extras). */
export function fitParams(p: Partial<ParamsSpec> | null | undefined, body: number, header: number): ParamsSpec {
  const fit = (a: ParamSpec[] | undefined, n: number) => Array.from({ length: n }, (_, i) => a?.[i] ?? blankParam())
  return { body: fit(p?.body, body), header: fit(p?.header, header) }
}

/** The problem with one value, or null. A fixed text and a field's fallback follow the same Meta rules. */
export function paramError(p: ParamSpec): string | null {
  if (p.kind === 'fixed') return paramProblem(p.value.trim())
  if (!FIELDS.includes(p.field)) return 'Pick a field.'
  const bad = paramProblem(p.fallback.trim())
  return bad ? `A fallback is required. ${bad}` : null
}

export interface ParamProblems { body: Array<string | null>; header: Array<string | null> }
export function paramProblems(p: ParamsSpec): ParamProblems {
  return { body: p.body.map(paramError), header: p.header.map(paramError) }
}
export const paramsValid = (p: ParamsSpec) => { const x = paramProblems(p); return ![...x.body, ...x.header].some(Boolean) }

/** The wire shape: values trimmed. */
export function paramsPayload(p: ParamsSpec): ParamsSpec {
  const t = (s: ParamSpec): ParamSpec => (s.kind === 'fixed' ? { kind: 'fixed', value: s.value.trim() } : { kind: 'field', field: s.field, fallback: s.fallback.trim() })
  return { body: p.body.map(t), header: p.header.map(t) }
}

/** Placeholders for counts-only previews (the API wants valid params even when only the audience matters). */
export function placeholderParams(body: number, header: number): ParamsSpec {
  const x = (): ParamSpec => ({ kind: 'fixed', value: 'x' })
  return { body: Array.from({ length: body }, x), header: Array.from({ length: header }, x) }
}

/** What a value shows as when no real lead is at hand: the fixed text, or the fallback a field will fall back to. */
export const specSample = (p: ParamSpec): string => (p.kind === 'fixed' ? p.value.trim() : p.fallback.trim())

/** Values for one sample recipient: the server's frozen params when present, else the specs' own text. */
export function sampleValues(row: SampleRow | null, specs: ParamsSpec): { body: string[]; header: string[] } {
  try {
    const o = row?.params ? JSON.parse(row.params) : null
    if (o && Array.isArray(o.body) && Array.isArray(o.header)) return { body: o.body.map(String), header: o.header.map(String) }
  } catch { /* fall through to the specs */ }
  return { body: specs.body.map(specSample), header: specs.header.map(specSample) }
}

/** The text a recipient would read, for the sample list. */
export const renderBody = (body: string, values: string[]) => renderParams(body, values)

export const countBodyParams = (t: Pick<Tpl, 'body_params_count' | 'header_params_count'>) => ({ body: t.body_params_count, header: t.header_params_count })
export const placeholderCount = (text: string) => placeholders(text).length

// ---- live ---------------------------------------------------------------------------------------------------------

/** Fold a `broadcast.progress` frame into the row it belongs to. Frames for other broadcasts leave it untouched. */
export function applyProgress<T extends Pick<Broadcast, 'id' | 'status' | 'pause_reason' | 'total' | 'sent' | 'delivered' | 'read' | 'failed'>>(b: T, f: Partial<ProgressFrame> | null | undefined): T {
  if (!f || f.id !== b.id) return b
  return {
    ...b,
    status: f.status ?? b.status, pause_reason: f.pause_reason === undefined ? b.pause_reason : f.pause_reason,
    total: f.total ?? b.total, sent: f.sent ?? b.sent, delivered: f.delivered ?? b.delivered, read: f.read ?? b.read, failed: f.failed ?? b.failed,
  }
}

// ---- opt-out (lead page and inbox header) -------------------------------------------------------------------------

export interface OptOutState { optedOut: boolean; source: string | null }
export const OPT_OUT_SOURCE_LABEL: Record<string, string> = {
  keyword: 'They replied with a stop word.', meta_131050: 'WhatsApp reported they stopped marketing messages.', manual: 'Set by your team.',
}

/** The two contact fields the lead detail and inbox thread payloads carry. */
export interface OptOutFields { opted_out_at?: number | null; opt_out_source?: string | null }

/**
 * Whether a contact has opted out of broadcasts, with the manual toggle. The state comes from the lead / thread payload
 * (`payload`); a toggle or the contact's `lead.update` (the server publishes one on every change) overrides it with a fresh
 * read of GET /api/contacts/:id until the payload itself changes.
 */
export function useOptOut(contactId: number | null, payload?: OptOutFields | null) {
  const [over, setOver] = useState<OptOutState | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const live = useRef(0)
  const base: OptOutState | null = payload ? { optedOut: !!payload.opted_out_at, source: payload.opt_out_source ?? null } : null
  const st = over ?? base
  useEffect(() => { setOver(null); setErr('') }, [contactId, payload?.opted_out_at, payload?.opt_out_source])
  const load = useCallback(async () => {
    if (contactId === null) return
    const n = ++live.current
    try {
      const r = await api<{ contact: { opted_out_at: number | null; opt_out_source: string | null } }>(`/api/contacts/${contactId}`)
      if (n === live.current) setOver({ optedOut: !!r.contact.opted_out_at, source: r.contact.opt_out_source })
    } catch { /* the chip is an extra; the page works without it */ }
  }, [contactId])
  useLiveEvents((s) => { if (s.type === 'resync' || (s.type === 'lead.update' && String(s.data?.contact_id) === String(contactId))) void load() })
  const toggle = useCallback(async () => {
    if (contactId === null || !st) return
    setBusy(true); setErr('')
    try {
      const r = await api<{ opted_out_at: number | null; opt_out_source: string | null }>(`/api/contacts/${contactId}/opt-out`, { method: 'PATCH', body: { opted_out: !st.optedOut } })
      live.current++
      setOver({ optedOut: !!r.opted_out_at, source: r.opt_out_source })
    } catch (e) { setErr(broadcastErrorText(e)) } finally { setBusy(false) }
  }, [contactId, st])
  return { st, busy, err, toggle }
}
