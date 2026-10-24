// Inspector form <-> node `data`, one pair per node type. The `data` side is exactly what the engine reads
// (src/flows/nodes/*.ts, triggers.ts) and what validateGraph checks; the form side is strings the inputs can hold.
// Pure, so the mapping is unit-tested without a DOM.
import { assertUrlAllowed } from '../../../../src/flows/http-guard'
import { compileSafeRegex } from '../../../../src/flows/regex'
import type { NodeType } from '../../lib/flows'

type D = Record<string, unknown>
const s = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v))
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const numOrUndef = (v: string): number | undefined => { const t = v.trim(); if (!t) return undefined; const n = Number(t); return Number.isFinite(n) ? n : undefined }
const put = (o: D, k: string, v: unknown) => { if (v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)) o[k] = v }
const lines = (t: string) => t.split(/[\n,]/).map((x) => x.trim()).filter(Boolean)

export const TRIGGER_LABEL: Record<string, string> = { lead_created: 'A lead is created', message_received: 'A message arrives', stage_changed: 'A lead changes stage' }
export const UNITS = ['seconds', 'minutes', 'hours', 'days'] as const
export const OPERATORS: { value: string; label: string; needsValue: boolean }[] = [
  { value: 'equals', label: 'equals', needsValue: true }, { value: 'not_equals', label: 'does not equal', needsValue: true },
  { value: 'contains', label: 'contains', needsValue: true }, { value: 'not_contains', label: 'does not contain', needsValue: true },
  { value: 'starts_with', label: 'starts with', needsValue: true }, { value: 'ends_with', label: 'ends with', needsValue: true },
  { value: 'regex', label: 'matches pattern', needsValue: true },
  { value: 'gt', label: 'is greater than', needsValue: true }, { value: 'gte', label: 'is at least', needsValue: true },
  { value: 'lt', label: 'is less than', needsValue: true }, { value: 'lte', label: 'is at most', needsValue: true },
  { value: 'is_empty', label: 'is empty', needsValue: false }, { value: 'is_not_empty', label: 'is not empty', needsValue: false },
  { value: 'exists', label: 'exists', needsValue: false },
]
export const ACTIONS = [
  { value: 'set_stage', label: 'Move to a stage' }, { value: 'add_tag', label: 'Add a tag' }, { value: 'remove_tag', label: 'Remove a tag' },
  { value: 'assign', label: 'Assign to a teammate' }, { value: 'note', label: 'Add a note' }, { value: 'set_next_action', label: 'Set next action' },
] as const
export const VAR_OPS = ['set', 'append', 'increment', 'clear'] as const
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

// ---- forms --------------------------------------------------------------------------------------------------------

export interface TriggerForm { kind: string; reentry: 'once' | 'each_event'; sources: string[]; stages: string[]; match: 'any' | 'keyword' | 'regex'; keywords: string; regexPattern: string; from: string[]; to: string[] }
export interface MessageForm { text: string }
export interface TemplateForm { templateId: string; templateName: string; bodyParams: string[]; headerParams: string[] }
export interface ConditionForm { left: string; operator: string; value: string }
export interface ActionForm { actionType: string; stage: string; tag: string; staffId: string; text: string; duration: string; unit: string }
export interface DelayForm { duration: string; unit: string }
export interface WaitForm { timeout: string; timeoutUnit: string }
export interface AiForm { systemPrompt: string; prompt: string; outputVariable: string; maxTokens: string }
export interface VariableForm { variableName: string; operation: string; value: string }
export interface HttpForm { method: string; url: string; headers: { name: string; value: string }[]; body: string; outputVariable: string }
export interface WritebackForm { verdict: string; score: string; stage: string; signals: { path: string; weight: string }[]; thresholds: { min: string; verdict: string; stage: string }[] }
export type Form = TriggerForm | MessageForm | TemplateForm | ConditionForm | ActionForm | DelayForm | WaitForm | AiForm | VariableForm | HttpForm | WritebackForm

/** `flowReentry` is the flow's stored column; a trigger with no reentry of its own shows (and keeps) that value. */
export function dataToForm(type: NodeType, data: D, flowReentry?: string): Form {
  const d = data ?? {}
  switch (type) {
    case 'trigger': return { kind: s(d.kind), reentry: (d.reentry ?? flowReentry) === 'each_event' ? 'each_event' : 'once', sources: list(d.sources), stages: list(d.stages), match: d.match === 'keyword' || d.match === 'regex' ? d.match : 'any', keywords: list(d.keywords).join('\n'), regexPattern: s(d.regexPattern), from: list(d.from), to: list(d.to) } satisfies TriggerForm
    case 'message': return { text: s(d.text) } satisfies MessageForm
    case 'template': return { templateId: s(d.templateId), templateName: s(d.templateName), bodyParams: list(d.bodyParams), headerParams: list(d.headerParams) } satisfies TemplateForm
    case 'condition': return { left: s(d.left) || 'user_response', operator: s(d.operator) || 'contains', value: s(d.value) } satisfies ConditionForm
    case 'action': return { actionType: s(d.actionType) || 'add_tag', stage: s(d.stage), tag: s(d.tag), staffId: s(d.staffId), text: s(d.text), duration: s(d.duration), unit: s(d.unit) || 'hours' } satisfies ActionForm
    case 'delay': return { duration: s(d.duration), unit: s(d.unit) || 'minutes' } satisfies DelayForm
    case 'wait_event': return { timeout: s(d.timeout), timeoutUnit: s(d.timeoutUnit) || 'hours' } satisfies WaitForm
    case 'ai': return { systemPrompt: s(d.systemPrompt), prompt: s(d.prompt), outputVariable: s(d.outputVariable), maxTokens: s(d.maxTokens) } satisfies AiForm
    case 'variable': return { variableName: s(d.variableName), operation: s(d.operation) || 'set', value: s(d.value) } satisfies VariableForm
    case 'http_request': {
      const h = d.headers
      const rows = Array.isArray(h) ? h.map((x: any) => ({ name: s(x?.name ?? x?.key), value: s(x?.value) })) : h && typeof h === 'object' ? Object.entries(h as D).map(([name, v]) => ({ name, value: s(v) })) : []
      return { method: s(d.method).toUpperCase() || 'GET', url: s(d.url), headers: rows, body: s(d.body), outputVariable: s(d.outputVariable) } satisfies HttpForm
    }
    case 'lead_writeback': {
      const r = (d.ratingRules ?? {}) as { signals?: any[]; thresholds?: any[] }
      return {
        verdict: s(d.verdict), score: s(d.score), stage: s(d.stage),
        signals: (r.signals ?? []).map((x) => ({ path: s(x?.path), weight: s(x?.weight) })),
        thresholds: (r.thresholds ?? []).map((x) => ({ min: s(x?.min), verdict: s(x?.verdict), stage: s(x?.stage) })),
      } satisfies WritebackForm
    }
  }
}

export function formToData(type: NodeType, form: Form): D {
  const o: D = {}
  switch (type) {
    case 'trigger': {
      const f = form as TriggerForm
      put(o, 'kind', f.kind); o.reentry = f.reentry
      if (f.kind === 'lead_created') { put(o, 'sources', f.sources); put(o, 'stages', f.stages) }
      if (f.kind === 'message_received') {
        o.match = f.match
        if (f.match === 'keyword') o.keywords = lines(f.keywords)
        if (f.match === 'regex') o.regexPattern = f.regexPattern
      }
      if (f.kind === 'stage_changed') { put(o, 'from', f.from); put(o, 'to', f.to) }
      return o
    }
    case 'message': return { text: (form as MessageForm).text }
    case 'template': { const f = form as TemplateForm; return { templateId: f.templateId, templateName: f.templateName, bodyParams: f.bodyParams, headerParams: f.headerParams } }
    case 'condition': {
      const f = form as ConditionForm
      o.left = f.left.trim() || 'user_response'; o.operator = f.operator
      if (OPERATORS.find((x) => x.value === f.operator)?.needsValue !== false) o.value = f.value
      return o
    }
    case 'action': {
      const f = form as ActionForm
      o.actionType = f.actionType
      if (f.actionType === 'set_stage') o.stage = f.stage
      if (f.actionType === 'add_tag' || f.actionType === 'remove_tag') o.tag = f.tag
      if (f.actionType === 'assign') o.staffId = f.staffId === '' ? null : Number(f.staffId)
      if (f.actionType === 'note') o.text = f.text
      if (f.actionType === 'set_next_action') { put(o, 'duration', numOrUndef(f.duration)); o.unit = f.unit }
      return o
    }
    case 'delay': { const f = form as DelayForm; put(o, 'duration', numOrUndef(f.duration)); o.unit = f.unit; return o }
    case 'wait_event': { const f = form as WaitForm; put(o, 'timeout', numOrUndef(f.timeout)); o.timeoutUnit = f.timeoutUnit; return o }
    case 'ai': {
      const f = form as AiForm
      o.prompt = f.prompt; put(o, 'systemPrompt', f.systemPrompt); put(o, 'outputVariable', f.outputVariable.trim()); put(o, 'maxTokens', numOrUndef(f.maxTokens))
      return o
    }
    case 'variable': {
      const f = form as VariableForm
      o.variableName = f.variableName.trim(); o.operation = f.operation
      if (f.operation !== 'clear') o.value = f.value
      return o
    }
    case 'http_request': {
      const f = form as HttpForm
      o.method = f.method; o.url = f.url.trim()
      o.headers = f.headers.filter((h) => h.name.trim()).map((h) => ({ name: h.name.trim(), value: h.value }))
      if (f.method !== 'GET' && f.body !== '') o.body = f.body
      put(o, 'outputVariable', f.outputVariable.trim())
      return o
    }
    case 'lead_writeback': {
      const f = form as WritebackForm
      put(o, 'verdict', f.verdict.trim()); put(o, 'score', numOrUndef(f.score)); put(o, 'stage', f.stage)
      const signals = f.signals.filter((x) => x.path.trim()).map((x) => ({ path: x.path.trim(), weight: numOrUndef(x.weight) ?? 1 }))
      const thresholds = f.thresholds.filter((x) => x.verdict.trim()).map((x) => ({ min: numOrUndef(x.min) ?? 0, verdict: x.verdict.trim(), ...(x.stage ? { stage: x.stage } : {}) }))
      if (signals.length || thresholds.length) o.ratingRules = { ...(signals.length ? { signals } : {}), ...(thresholds.length ? { thresholds } : {}) }
      return o
    }
  }
  return o
}

// ---- field-level checks the inspector can show before a save -------------------------------------------------------

/** The engine's own SSRF policy, run on the static part of the URL. Null when fine (or templated: the host is only known at run time). */
export function httpUrlIssue(url: string): string | null {
  const u = url.trim()
  if (!u) return 'Enter a URL.'
  if (u.includes('{{')) return /^https?:\/\//i.test(u) ? null : 'A templated URL must start with http:// or https://.'
  try { assertUrlAllowed(u); return null } catch (e) { return e instanceof Error ? e.message : 'This URL is not allowed.' }
}

const SPOOFING_X = /^x-(forwarded-|real-ip|original-|rewrite-url|http-method|host)/i
/** Request headers the guard lets through: Content-Type, Accept, User-Agent, Authorization (explicit), and custom X-*. */
export function headerIssue(name: string): string | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  if (!/^[\w-]{1,64}$/.test(n)) return 'Header names use letters, digits, - and _.'
  if (n === 'content-type' || n === 'accept' || n === 'user-agent' || n === 'authorization') return null
  if (n.startsWith('x-') && !SPOOFING_X.test(n)) return null
  return 'This header is dropped before the request goes out. Allowed: Content-Type, Accept, User-Agent, Authorization and custom X- headers.'
}

export function regexIssue(pattern: string): string | null {
  if (!pattern.trim()) return 'Enter a pattern.'
  const c = compileSafeRegex(pattern)
  return c.ok ? null : c.reason
}

/** Distinct `{{token}}` roots in a text that no known source provides (typos). Variables set by earlier nodes are passed in. */
export function unknownTokens(text: string, known: Set<string>): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/\{\{\s*([\w.[\]]+)\s*\}\}/g)) {
    const root = m[1]!.split('.')[0]!.replace(/\[\d+\]$/, '')
    if (!known.has(root)) out.add(m[1]!)
  }
  return [...out]
}
