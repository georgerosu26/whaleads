// Broadcast template values (plan D1 params.ts). Each placeholder is either a fixed text or a per-lead field with a
// required fallback. Fields resolve in SQL when the broadcast starts and are frozen on the recipient row, so a lead edited
// mid-broadcast does not change what is sent; the step only parses and cleans them.
import { TEMPLATE_LIMITS, paramProblem } from '../templateRules'

export const FIELDS = ['contact.name', 'contact.phone', 'lead.stage', 'lead.source', 'lead.owner'] as const
export type FieldName = (typeof FIELDS)[number]
export type ParamSpec = { kind: 'fixed'; value: string } | { kind: 'field'; field: FieldName; fallback: string }
export interface ParamsSpec { body: ParamSpec[]; header: ParamSpec[] }
export interface FrozenParams { body: string[]; header: string[] }

/** Where each field comes from. Aliases: c = contacts, l = leads, s = stages, so = sources, st = staff. */
const FIELD_SQL: Record<FieldName, string> = {
  'contact.name': 'c.name', 'contact.phone': 'c.phone',
  'lead.stage': 's.label', 'lead.source': 'so.label', 'lead.owner': 'st.name',
}
export const PARAM_JOINS = `LEFT JOIN leads l ON l.id = p.lead_id LEFT JOIN stages s ON s.key = l.status
  LEFT JOIN sources so ON so.key = l.source LEFT JOIN staff st ON st.id = l.assigned_to`

export type Checked = { ok: true; spec: ParamsSpec } | { ok: false; error: string; field: string }

function list(raw: unknown, label: 'body' | 'header', want: number): ParamSpec[] | string {
  const arr = raw === undefined || raw === null ? [] : raw
  if (!Array.isArray(arr)) return `${label} must be a list.`
  if (arr.length !== want) return `This template needs ${want} ${label} value${want === 1 ? '' : 's'}, got ${arr.length}.`
  const out: ParamSpec[] = []
  for (let i = 0; i < arr.length; i++) {
    const p = arr[i] as Record<string, unknown> | null
    const at = `${label} value ${i + 1}`
    if (!p || typeof p !== 'object') return `${at}: expected an object.`
    if (p.kind === 'fixed') {
      const v = typeof p.value === 'string' ? p.value.trim() : ''
      const bad = paramProblem(v)
      if (bad) return `${at}: ${bad}`
      out.push({ kind: 'fixed', value: v })
    } else if (p.kind === 'field') {
      if (!(FIELDS as readonly string[]).includes(String(p.field))) return `${at}: unknown field.`
      const fb = typeof p.fallback === 'string' ? p.fallback.trim() : ''
      const bad = paramProblem(fb)
      if (bad) return `${at}: a fallback is required. ${bad}`
      out.push({ kind: 'field', field: p.field as FieldName, fallback: fb })
    } else return `${at}: kind must be "fixed" or "field".`
  }
  return out
}

/** Validates the shape against the template's placeholder counts. */
export function checkParams(raw: unknown, bodyCount: number, headerCount: number): Checked {
  const r = (raw ?? {}) as Record<string, unknown>
  if (typeof r !== 'object' || Array.isArray(r)) return { ok: false, error: 'params must be an object.', field: 'params' }
  const body = list(r.body, 'body', bodyCount)
  if (typeof body === 'string') return { ok: false, error: body, field: 'params' }
  const header = list(r.header, 'header', headerCount)
  if (typeof header === 'string') return { ok: false, error: header, field: 'params' }
  return { ok: true, spec: { body, header } }
}

/** One SQL expression per value. Binds go through `bind`, which returns the numbered placeholder. */
function exprs(specs: ParamSpec[], bind: (v: unknown) => string): string {
  return specs.map((p) => p.kind === 'fixed'
    ? bind(p.value)
    : `COALESCE(NULLIF(TRIM(${FIELD_SQL[p.field]}), ''), ${bind(p.fallback)})`).join(', ')
}

/** SQL producing the frozen params JSON for a row of `p JOIN contacts c ${PARAM_JOINS}`. */
export function paramsSql(spec: ParamsSpec, bind: (v: unknown) => string): string {
  return `json_object('body', json_array(${exprs(spec.body, bind)}), 'header', json_array(${exprs(spec.header, bind)}))`
}

/** A value as WhatsApp takes it: no line breaks, tabs or runs of spaces, at most 1024 characters. '' means unusable. */
export const cleanParam = (v: unknown): string => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, TEMPLATE_LIMITS.param)

/** Parses the frozen JSON; null when it is unusable or does not match the counts. */
export function parseFrozen(json: string | null, bodyCount: number, headerCount: number): FrozenParams | null {
  try {
    const o = JSON.parse(json ?? '')
    const body = (Array.isArray(o?.body) ? o.body : []).map(cleanParam)
    const header = (Array.isArray(o?.header) ? o.header : []).map(cleanParam)
    if (body.length !== bodyCount || header.length !== headerCount) return null
    if ([...body, ...header].some((v) => !v)) return null
    return { body, header }
  } catch { return null }
}
