// template store (D1 mirror of Meta's objects), normalisation of both adaptors' list shapes, sync, cron hook.
import type { Env } from './db'
import { logEvent } from './db'
import { resolveActive } from './adaptors'
import type { AdaptorResult, MetaAdaptor } from './adaptors/types'
import { placeholders } from './templateRules'

export interface TemplateRow {
  id: string; name: string; language: string; category: string; status: string; rejected_reason: string | null
  components: string; header_format: string; header_media_r2_key: string | null; header_media_mime: string | null
  body_params_count: number; header_params_count: number; quality?: string | null; synced_at: number | null; created_by: number | null; created_at: number; updated_at: number
}

export interface Remote {
  id: string | null; name: string; language: string; category: string; status: string; reason: string | null; components: any[]; quality: string | null
}

const STATUS_MAP: Record<string, string | null> = {
  PENDING: 'PENDING', IN_APPEAL: 'PENDING', APPROVED: 'APPROVED', REJECTED: 'REJECTED', PAUSED: 'PAUSED', DISABLED: 'DISABLED',
  PENDING_DELETION: null, DELETED: null,
}

const QUALITY = new Set(['GREEN', 'YELLOW', 'RED', 'UNKNOWN'])
/** Graph `quality_score: { score, date }` (WhaBuzz passes the same object under meta_object); a bare string is tolerated. */
function qualityOf(...cands: unknown[]): string | null {
  for (const c of cands) {
    const v = typeof c === 'string' ? c : c && typeof c === 'object' ? (c as any).score : null
    const s = typeof v === 'string' ? v.toUpperCase() : ''
    if (QUALITY.has(s)) return s
  }
  return null
}

/** One list item from either adaptor: WhaBuzz `{id,status_reason,meta_object:{components}}` or Graph `{id,rejected_reason,components}`. */
export function normalizeRemote(item: any): Remote | null {
  if (!item || typeof item !== 'object') return null
  const mo = item.meta_object && typeof item.meta_object === 'object' ? item.meta_object : {}
  const name = String(item.name ?? mo.name ?? '')
  const language = String(item.language ?? mo.language ?? '')
  if (!name || !language) return null
  const rawStatus = String(item.status ?? mo.status ?? '').toUpperCase()
  const status = rawStatus in STATUS_MAP ? STATUS_MAP[rawStatus] : rawStatus ? 'DISABLED' : 'PENDING'
  if (!status) return null // deleted upstream
  const cat = String(item.category ?? mo.category ?? '').toUpperCase()
  const reasonRaw = item.status_reason ?? item.rejected_reason ?? mo.rejected_reason ?? mo.status_reason ?? null
  const reason = typeof reasonRaw === 'string' && reasonRaw.trim() && reasonRaw.trim().toUpperCase() !== 'NONE' ? reasonRaw : null
  const comps = item.components ?? mo.components
  return {
    id: item.id != null ? String(item.id) : mo.id != null ? String(mo.id) : null,
    name, language,
    category: cat === 'MARKETING' || cat === 'AUTHENTICATION' ? cat : 'UTILITY',
    status, reason: status === 'APPROVED' ? null : reason,
    components: Array.isArray(comps) ? comps : [],
    quality: qualityOf(item.quality_score, mo.quality_score, item.quality, mo.quality),
  }
}

/** Meta's template-header rules (stricter than the inbox allowlist): image jpeg/png, video mp4, document pdf. */
const HEADER_MIME: Record<string, RegExp> = { IMAGE: /^image\/(jpeg|png)$/, VIDEO: /^video\/mp4$/, DOCUMENT: /^application\/pdf$/ }
export const templateHeaderOk = (format: string, mime: string) => !!HEADER_MIME[format]?.test((mime ?? '').split(';')[0]!.trim().toLowerCase())

export function safeComponents(json: string): any[] {
  try { const p = JSON.parse(json); return Array.isArray(p) ? p : [] } catch { return [] }
}

/** Shapes WhaLeads cannot fill in at send time. These stay listed (greyed, with the reason) but are never offered or sent. */
export function sendability(components: any[], category?: string): { sendable: boolean; reason: string | null } {
  const no = (reason: string) => ({ sendable: false, reason })
  if (String(category ?? '').toUpperCase() === 'AUTHENTICATION') return no('Authentication (one-time code) templates cannot be sent from WhaLeads.')
  for (const c of components) {
    const type = String(c?.type).toUpperCase()
    if ((type === 'HEADER' || type === 'BODY') && /\{\{\s*[^\s\d}][^}]*\}\}/.test(String(c?.text ?? ''))) return no('This template uses named variables, which WhaLeads cannot fill in yet.')
    if (type === 'HEADER' && String(c?.format).toUpperCase() === 'LOCATION') return no('Location headers cannot be sent from WhaLeads yet.')
    if (type === 'BUTTONS' && Array.isArray(c?.buttons)) {
      for (const b of c.buttons) {
        const bt = String(b?.type).toUpperCase()
        if ((bt === 'URL' && /\{\{/.test(String(b?.url ?? ''))) || ['COPY_CODE', 'OTP', 'FLOW', 'CATALOG', 'MPM', 'SPM'].includes(bt)) return no('This template has buttons with variables, which WhaLeads cannot fill in yet.')
      }
    }
  }
  return { sendable: true, reason: null }
}

export function derive(components: any[]) {
  const header = components.find((c) => String(c?.type).toUpperCase() === 'HEADER')
  const body = components.find((c) => String(c?.type).toUpperCase() === 'BODY')
  const fmt = String(header?.format ?? '').toUpperCase()
  return {
    header_format: fmt === 'TEXT' || fmt === 'IMAGE' || fmt === 'VIDEO' || fmt === 'DOCUMENT' ? fmt : 'NONE',
    body_params_count: placeholders(String(body?.text ?? '')).length,
    header_params_count: fmt === 'TEXT' ? placeholders(String(header?.text ?? '')).length : 0,
    ...(({ sendable }) => ({ sendable }))(sendability(components)),
  }
}

export function upsertStatement(db: D1Database, r: Remote, now: number, createdBy: number | null = null, media?: { key: string; mime: string }) {
  const d = derive(r.components)
  const id = r.id ?? `local:${r.name}:${r.language}`
  return db.prepare(
    `INSERT INTO templates (id,name,language,category,status,rejected_reason,components,header_format,header_media_r2_key,header_media_mime,body_params_count,header_params_count,synced_at,created_by,created_at,updated_at,quality)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?13,?13,?15)
     ON CONFLICT(name,language) DO UPDATE SET
       id = CASE WHEN excluded.id LIKE 'local:%' THEN templates.id ELSE excluded.id END,
       category=excluded.category, status=excluded.status, rejected_reason=excluded.rejected_reason, components=excluded.components,
       header_format=excluded.header_format, body_params_count=excluded.body_params_count, header_params_count=excluded.header_params_count,
       header_media_r2_key=COALESCE(excluded.header_media_r2_key, templates.header_media_r2_key),
       header_media_mime=COALESCE(excluded.header_media_mime, templates.header_media_mime),
       quality=COALESCE(excluded.quality, templates.quality),
       synced_at=excluded.synced_at, updated_at=excluded.updated_at`,
  ).bind(id, r.name, r.language, r.category, r.status, r.reason, JSON.stringify(r.components), d.header_format, media?.key ?? null, media?.mime ?? null,
    d.body_params_count, d.header_params_count, now, createdBy, r.quality)
}

const comp = (components: any[], type: string) => components.find((c) => String(c?.type).toUpperCase() === type)

/** Row as the API/UI sees it: text parts pulled out of the components, no R2 key. */
/** The authentication settings Meta echoes back, for the "Duplicate" prefill. */
function authOf(components: any[]) {
  const otp = (comp(components, 'BUTTONS')?.buttons ?? []).find((b: any) => b?.type === 'OTP')
  const exp = comp(components, 'FOOTER')?.code_expiration_minutes
  return {
    security_note: !!comp(components, 'BODY')?.add_security_recommendation,
    expiry_minutes: Number.isInteger(exp) ? exp : null,
    button_text: typeof otp?.text === 'string' ? otp.text : null,
  }
}

export function rowJson(r: TemplateRow) {
  let components: any[] = []
  try { const p = JSON.parse(r.components); if (Array.isArray(p)) components = p } catch { /* keep [] */ }
  const header = comp(components, 'HEADER'), body = comp(components, 'BODY'), footer = comp(components, 'FOOTER')
  return {
    id: r.id, name: r.name, language: r.language, category: r.category, status: r.status, rejected_reason: r.rejected_reason,
    ...(() => { const s = sendability(components, r.category); return { sendable: s.sendable, unsendable_reason: s.reason } })(),
    header_format: r.header_format, header_text: r.header_format === 'TEXT' ? String(header?.text ?? '') : null,
    body: String(body?.text ?? ''), footer: footer?.text ? String(footer.text) : null,
    body_params_count: r.body_params_count, header_params_count: r.header_params_count,
    has_header_sample: !!r.header_media_r2_key, header_media_mime: r.header_media_mime,
    ...(r.category === 'AUTHENTICATION' ? { auth: authOf(components) } : {}),
    quality: r.quality ?? null, synced_at: r.synced_at, created_at: r.created_at,
  }
}

/** All pages of the remote list (Graph pages 100 at a time; WhaBuzz returns everything at once). */
async function fetchAll(adaptor: MetaAdaptor): Promise<AdaptorResult<{ items: any[] }>> {
  const first = await adaptor.templates.syncStatus()
  if (!first.ok) return first as AdaptorResult<{ items: any[] }>
  const items: any[] = Array.isArray(first.data?.data) ? [...first.data.data] : []
  let after: string | undefined = first.data?.paging?.next ? first.data?.paging?.cursors?.after : undefined
  for (let page = 0; after && page < 20; page++) {
    const next = await adaptor.templates.list({ after })
    if (!next.ok) return next as AdaptorResult<{ items: any[] }>
    if (Array.isArray(next.data?.data)) items.push(...next.data.data)
    after = next.data?.paging?.next ? next.data?.paging?.cursors?.after : undefined
  }
  return { ok: true, status: first.status, data: { items } }
}

export type SyncOutcome = { ok: true; count: number; changed: number; removed: number } | { ok: false; result: AdaptorResult } | { ok: false; noAdaptor: true }

/** Pull Meta's current list and upsert it. rejected_reason is stored exactly as Meta states it. */
export async function syncTemplates(env: Env, adaptor?: MetaAdaptor): Promise<SyncOutcome> {
  let a = adaptor
  if (!a) {
    const active = await resolveActive(env)
    if (!active) return { ok: false, noAdaptor: true }
    a = active.adaptor
  }
  const all = await fetchAll(a)
  if (!all.ok) return { ok: false, result: all }
  const now = Math.floor(Date.now() / 1000)
  const remotes = all.data.items.map(normalizeRemote).filter((x): x is Remote => !!x)
  const before = new Map((await env.DB.prepare(`SELECT name, language, status, rejected_reason FROM templates`).all<{ name: string; language: string; status: string; rejected_reason: string | null }>()).results
    .map((r) => [`${r.name}\u0000${r.language}`, `${r.status}|${r.rejected_reason ?? ''}`]))
  let changed = 0
  for (const r of remotes) if (before.get(`${r.name}\u0000${r.language}`) !== `${r.status}|${r.reason ?? ''}`) changed++
  for (let i = 0; i < remotes.length; i += 40) await env.DB.batch(remotes.slice(i, i + 40).map((r) => upsertStatement(env.DB, r, now)))
  // Upstream deletions: a local row Meta no longer lists is removed after one miss (the table's status CHECK has no DELETED value, so the
  // row goes rather than being flagged). Rows created in the last 10 minutes are spared, because Meta's list can lag a fresh create.
  const seen = new Set(remotes.map((r) => `${r.name}\u0000${r.language}`))
  const gone = [...before.keys()].filter((k) => !seen.has(k))
  let removed = 0
  for (const k of gone) {
    const [name, language] = k.split('\u0000')
    const res = await env.DB.prepare(`DELETE FROM templates WHERE name=?1 AND language=?2 AND created_at <= ?3`).bind(name, language, now - 600).run()
    removed += res.meta?.changes ?? 0
  }
  return { ok: true, count: remotes.length, changed: changed + removed, removed }
}

/** Cron: refresh at most hourly, and only while some template still waits for Meta's review. */
export async function syncPendingTemplates(env: Env): Promise<void> {
  try {
    const due = await env.DB.prepare(`SELECT 1 AS x FROM templates WHERE status='PENDING' AND (synced_at IS NULL OR synced_at <= unixepoch() - 3300) LIMIT 1`).first()
    if (!due) return
    const out = await syncTemplates(env)
    if (out.ok) await logEvent(env.DB, 'templates_cron_sync', { count: out.count, changed: out.changed })
    else await logEvent(env.DB, 'templates_cron_error', { error: 'result' in out ? out.result.error?.message ?? 'sync failed' : 'no adaptor' })
  } catch (e) {
    await logEvent(env.DB, 'templates_cron_error', { error: String(e).slice(0, 300) }).catch(() => {})
  }
}

/** Meta error subcodes that point at a form field, with a plain-words hint. The upstream error itself is always passed through too. */
const META_HINTS: Record<number, { field: string; hint: string }> = {
  2388293: { field: 'body', hint: 'The body needs more fixed text relative to its variables. Add words around the {{n}} placeholders or use fewer variables.' },
  2388024: { field: 'name', hint: 'A template with this name and language already exists. Pick another name.' },
  2388023: { field: 'name', hint: 'This name and language was deleted recently and cannot be reused yet. Pick another name.' },
  2388040: { field: 'body', hint: 'The body or header is over Meta\'s length limit.' },
  2388299: { field: 'body', hint: 'Meta rejected the variables in this text. Check the placeholders and samples.' },
}

export function mapMetaError(e: unknown): { field?: string; hint?: string } {
  const x = e as any
  const sub = Number(x?.error_subcode ?? x?.error?.error_subcode)
  return META_HINTS[sub] ?? {}
}
