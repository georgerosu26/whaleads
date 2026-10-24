// RunContext: the shared state of one run. Every node writes its output under its own id and any later node
// may read any earlier node's output ({{node_id.field}}). Persisted as JSON in flow_runs.context, so plain data only.
import type { Env } from '../db'
import { getSettings, type Resolved } from '../settings'
import { localTime, localDate } from '../daytime'
import type { NodeType } from './types'
import { LIMITS } from './types'

export interface NodeResult {
  output: Record<string, unknown>
  type: NodeType
  /** Unix seconds the node completed or parked. */
  at: number
  status?: 'ok' | 'awaiting' | 'skipped' | 'failed'
}

export interface LeadSnapshot {
  id: number
  name: string | null
  phone: string | null
  source: string
  stage: string
  tags: string[]
  assigned_to: number | null
  [key: string]: unknown
}

export interface RunContext {
  nodes: Record<string, NodeResult>
  vars: Record<string, unknown>
  lead: LeadSnapshot
  contact: { id: number; name: string | null; phone: string | null; email: string | null; wa_id: string | null }
  business: { open: boolean }
  /** The most recent trigger or reply event, merged in by start / resume. */
  lastEvent?: Record<string, unknown>
  /** Set when a step ran out of time: the node to EXECUTE (not route from) when the run resumes. */
  pendingExec?: string
  /** Trigger chain depth this run started at (0 = a real-world event). Persisted so a resumed run keeps it. */
  depth?: number
  /** Flow name, for the live frame and the activity row. */
  flowName?: string
  /** Event keys already applied to this run (last 50): a redelivered reply must not advance a later wait. */
  applied?: string[]
}

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype'])

export function recordNodeOutput(ctx: RunContext, nodeId: string, type: NodeType, output: Record<string, unknown>, status: NodeResult['status'] = 'ok', at = Math.floor(Date.now() / 1000)): void {
  ctx.nodes[nodeId] = { output: output ?? {}, type, at, status }
}

function deepGet(obj: unknown, parts: string[]): unknown {
  let cur: unknown = obj
  for (const raw of parts) {
    if (cur == null || typeof cur !== 'object') return undefined
    const m = raw.match(/^(\w+)\[(\d+)\]$/)
    const key = m ? m[1] : raw
    if (UNSAFE.has(key) || !hasOwn(cur as object, key)) return undefined
    const v = (cur as Record<string, unknown>)[key]
    cur = m ? (Array.isArray(v) ? v[Number(m[2])] : undefined) : v
  }
  return cur
}

/**
 * Resolves a dotted path: `lead.stage`, `contact.name`, `business.open`, `<node_id>.field`, `<var>`.
 * Returns undefined when unresolved.
 */
export function resolve(ctx: RunContext, path: string): unknown {
  const trimmed = path.trim()
  if (!trimmed) return undefined
  const [head, ...rest] = trimmed.split('.')
  if (UNSAFE.has(head)) return undefined
  const root = head === 'lead' ? ctx.lead : head === 'contact' ? ctx.contact : head === 'business' ? ctx.business
    : hasOwn(ctx.nodes, head) ? ctx.nodes[head].output : hasOwn(ctx.vars, head) ? ctx.vars[head] : undefined
  if (root === undefined) return undefined
  return rest.length ? deepGet(root, rest) : root
}

function stringify(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try { return JSON.stringify(v) } catch { return String(v) }
}

/** Aliases kept from earlier flow builders so ported graphs read the same. */
function alias(key: string, ctx: RunContext): string | undefined {
  const ev = ctx.lastEvent ?? {}
  switch (key) {
    case 'sender_name': return stringify(ctx.lead.name ?? '')
    case 'sender_phone': return stringify(ctx.lead.phone ?? '')
    case 'user_response': return stringify(ev.text ?? ev.message ?? ev.body ?? '')
    default: return undefined
  }
}

/** Replaces every {{token}}; unresolved tokens render empty. */
export function interpolate(text: string, ctx: RunContext): string {
  if (!text) return text ?? ''
  return text.replace(/\{\{\s*([\w.[\]]+)\s*\}\}/g, (_m, expr: string) => {
    const a = alias(expr, ctx)
    if (a !== undefined) return a
    const r = resolve(ctx, expr)
    return r === undefined ? '' : stringify(r)
  })
}

// ---- business hours ----------------------------------------------------------------------------------------

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

/** Is `now` inside the configured working hours? No hours configured counts as open (an unset rule never blocks). */
export function isOpenAt(hours: unknown, tz: string, now: number): boolean {
  if (!hours || typeof hours !== 'object' || Array.isArray(hours)) return true
  const [y, m, d] = localDate(now, tz).split('-').map(Number)
  const day = DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
  const h = (hours as Record<string, { open?: string; close?: string } | null>)[day]
  if (!h || typeof h.open !== 'string' || typeof h.close !== 'string') return false
  const t = localTime(now, tz)
  return t >= h.open && t < h.close
}

// ---- snapshot ----------------------------------------------------------------------------------------------

interface LeadJoin {
  id: number; contact_id: number; source: string; status: string; assigned_to: number | null
  name: string | null; phone: string | null; email: string | null; wa_id: string | null
}

/** Loads the lead + contact + tags (two reads) into a fresh context. Null when the lead is gone. */
export async function buildContext(env: Env, leadId: number, now: number, settings?: Resolved): Promise<RunContext | null> {
  const l = await env.DB.prepare(
    `SELECT l.id, l.contact_id, l.source, l.status, l.assigned_to, c.name, c.phone, c.email, c.wa_id
       FROM leads l JOIN contacts c ON c.id = l.contact_id WHERE l.id = ?`,
  ).bind(leadId).first<LeadJoin>()
  if (!l) return null
  const { results } = await env.DB.prepare(`SELECT t.label FROM lead_tags lt JOIN tags t ON t.id = lt.tag_id WHERE lt.lead_id = ? ORDER BY t.label`).bind(leadId).all<{ label: string }>()
  const s = settings ?? (await getSettings(env))
  return {
    nodes: {}, vars: {},
    lead: { id: l.id, name: l.name, phone: l.phone, source: l.source, stage: l.status, tags: results.map((r) => r.label), assigned_to: l.assigned_to },
    contact: { id: l.contact_id, name: l.name, phone: l.phone, email: l.email, wa_id: l.wa_id },
    business: { open: isOpenAt(s.working_hours, s.timezone, now) },
  }
}

/** Serialises the context; null when it is past the 32 KB cap (the caller fails the run). */
export function serializeContext(ctx: RunContext): string | null {
  const s = JSON.stringify(ctx)
  return new TextEncoder().encode(s).byteLength > LIMITS.MAX_CONTEXT_BYTES ? null : s
}
