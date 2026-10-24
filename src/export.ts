// Export: leads as CSV and the whole workspace as versioned JSON. Both are streamed: rows are read in keyset
// pages (never OFFSET) and encoded as they arrive, so memory stays flat however many leads there are.
import type { Env } from './db'
import { csvRow } from './csv'

export const EXPORT_VERSION = 1
export const LEADS_PAGE = 500
const JSON_PAGE = 500

export const LEAD_CSV_COLUMNS = [
  'id', 'created_at', 'name', 'phone', 'email', 'source', 'stage', 'owner', 'owner_email', 'tags', 'next_action_at', 'won_at', 'closed_at',
  'lost_reason', 'first_response_at', 'message', 'utm_source', 'utm_medium', 'utm_campaign', 'gclid', 'ctwa_clid',
  'referral_source_id', 'referral_source_type', 'referral_source_url', 'referral_headline',
] as const

export const iso = (s: number | null | undefined): string => (s === null || s === undefined ? '' : new Date(s * 1000).toISOString())

interface CsvLeadRow {
  id: number; created_at: number; name: string | null; wa_id: string | null; cphone: string | null; email: string | null; source: string; stage: string
  owner: string | null; owner_email: string | null; tags: string | null; next_action_at: number | null; won_at: number | null; closed_at: number | null
  lost_reason: string | null; first_response_at: number | null; message: string | null; utm_source: string | null; utm_medium: string | null
  utm_campaign: string | null; gclid: string | null; ctwa_clid: string | null; attribution: string | null
}

function attribution(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v : {} } catch { return {} }
}
const str = (v: unknown) => (typeof v === 'string' ? v : '')

export function leadCsvLine(r: CsvLeadRow): string {
  const a = attribution(r.attribution)
  const digits = r.wa_id || r.cphone || ''
  return csvRow([
    r.id, iso(r.created_at), r.name, digits ? '+' + digits.replace(/^\+/, '') : '', r.email, r.source, r.stage, r.owner, r.owner_email, r.tags,
    iso(r.next_action_at), iso(r.won_at), iso(r.closed_at), r.lost_reason, iso(r.first_response_at), r.message, r.utm_source, r.utm_medium,
    r.utm_campaign, r.gclid, r.ctwa_clid, str(a.source_id), str(a.source_type), str(a.source_url), str(a.headline),
  ])
}

/** Tags are joined with ";" (labels cannot contain it: the import splits on it). */
const LEAD_PAGE_SQL = `SELECT l.id, l.created_at, c.name, c.wa_id, c.phone AS cphone, c.email, l.source, l.status AS stage, o.name AS owner, o.email AS owner_email,
    (SELECT group_concat(replace(t.label, ';', ','), ';') FROM lead_tags lt JOIN tags t ON t.id = lt.tag_id WHERE lt.lead_id = l.id) AS tags,
    l.next_action_at, l.won_at, l.closed_at, l.lost_reason, l.first_response_at, l.message, l.utm_source, l.utm_medium, l.utm_campaign, l.gclid, l.ctwa_clid, l.attribution
  FROM leads l JOIN contacts c ON c.id = l.contact_id LEFT JOIN staff o ON o.id = l.assigned_to
  WHERE l.id > ?1 ORDER BY l.id LIMIT ?2`

const enc = new TextEncoder()

/** UTF-8 BOM first so Excel reads the file as UTF-8; the importer strips it. */
export function leadsCsvStream(env: Env, onDone?: (rows: number) => void): ReadableStream<Uint8Array> {
  let last = 0, started = false, rows = 0
  return new ReadableStream<Uint8Array>({
    async pull(ctl) {
      if (!started) { started = true; ctl.enqueue(enc.encode('﻿' + csvRow([...LEAD_CSV_COLUMNS]))) }
      const { results } = await env.DB.prepare(LEAD_PAGE_SQL).bind(last, LEADS_PAGE).all<CsvLeadRow>()
      if (!results.length) { onDone?.(rows); ctl.close(); return }
      ctl.enqueue(enc.encode(results.map(leadCsvLine).join('')))
      rows += results.length
      last = results[results.length - 1].id
      if (results.length < LEADS_PAGE) { onDone?.(rows); ctl.close() }
    },
  })
}

// ---- full JSON --------------------------------------------------------------------------------------------

/** Settings that may leave the instance: business and display values only. An ALLOWLIST: any other key
 *  (adaptor config, connect_pending, whabuzz_*, anthropic_key_enc, vapid_private_enc, future secrets) is never exported. */
export const EXPORT_SETTINGS: ReadonlySet<string> = new Set([
  'business_name', 'default_country', 'timezone', 'working_hours', 'allowed_origins', 'vapid_public', 'push_subject', 'flow_run_retention_days', 'broadcast_per_minute',
])

interface Section { name: string; sql: string; cols?: string[]; paged?: boolean; optional?: boolean }
// Paged sections use rowid keyset paging (every table here is a rowid table); `_rid` is dropped from the output.
const SECTIONS: Section[] = [
  { name: 'staff', sql: `SELECT id,email,name,role,must_change_pw,active,created_at,last_login_at FROM staff`, paged: false },
  { name: 'stages', sql: `SELECT key,label,position,kind,archived FROM stages ORDER BY position,key`, paged: false },
  { name: 'sources', sql: `SELECT key,label,system,archived FROM sources ORDER BY key`, paged: false },
  { name: 'tags', sql: `SELECT id,label,color FROM tags ORDER BY id`, paged: false },
  { name: 'contacts', sql: `SELECT rowid AS _rid, id,wa_id,phone,name,email,first_seen_at,last_seen_at,source FROM contacts`, paged: true },
  { name: 'leads', sql: `SELECT rowid AS _rid, id,contact_id,source,page,message,utm_source,utm_medium,utm_campaign,gclid,status,created_at,updated_at,assigned_to,external_id,attribution,ctwa_clid,ad_source_id,next_action_at,lost_reason,won_at,closed_at,first_response_at,last_activity_at FROM leads`, paged: true },
  { name: 'lead_tags', sql: `SELECT rowid AS _rid, lead_id,tag_id FROM lead_tags`, paged: true },
  { name: 'activity', sql: `SELECT rowid AS _rid, id,lead_id,contact_id,actor,kind,data,created_at FROM activity`, paged: true },
  { name: 'conversations', sql: `SELECT rowid AS _rid, contact_id,last_message_at,last_inbound_at,last_preview,unread_count,assigned_to,status FROM conversations`, paged: true },
  { name: 'messages', sql: `SELECT rowid AS _rid, id,contact_id,direction,wamid,type,body,media_id,status,timestamp,created_at FROM messages`, paged: true },
  { name: 'media', sql: `SELECT rowid AS _rid, id,message_id,media_id,r2_key,mime,filename,size,status,attempts,last_error,created_at,stored_at FROM media`, paged: true },
  { name: 'quick_replies', sql: `SELECT id,shortcut,body,created_by,created_at FROM quick_replies ORDER BY id`, paged: false },
  { name: 'templates', sql: `SELECT rowid AS _rid, * FROM templates`, paged: true, optional: true },
]

/** Every section name, in output order. Part of the format contract (README). */
export const EXPORT_SECTIONS = ['settings', ...SECTIONS.map((s) => s.name)]

async function* fullJson(env: Env, instance: string, now: number): AsyncGenerator<string> {
  yield `{"whaleads_export":${EXPORT_VERSION},"exported_at":${JSON.stringify(iso(now))},"instance":${JSON.stringify(instance)}`
  const { results: srows } = await env.DB.prepare(`SELECT key,value FROM settings ORDER BY key`).all<{ key: string; value: string }>()
  const settings: Record<string, unknown> = {}
  for (const r of srows) {
    if (!EXPORT_SETTINGS.has(r.key)) continue
    try { settings[r.key] = JSON.parse(r.value) } catch { settings[r.key] = r.value }
  }
  yield `,"settings":${JSON.stringify(settings)}`
  for (const s of SECTIONS) {
    if (s.optional) {
      const has = await env.DB.prepare(`SELECT 1 x FROM sqlite_master WHERE type='table' AND name=?`).bind(s.name).first()
      if (!has) continue
    }
    yield `,${JSON.stringify(s.name)}:[`
    if (!s.paged) {
      const { results } = await env.DB.prepare(s.sql).all()
      yield results.map((r) => JSON.stringify(r)).join(',')
    } else {
      let last = 0, first = true
      for (;;) {
        const { results } = await env.DB.prepare(`${s.sql} WHERE rowid > ?1 ORDER BY rowid LIMIT ?2`).bind(last, JSON_PAGE).all<Record<string, unknown> & { _rid: number }>()
        if (!results.length) break
        last = results[results.length - 1]._rid
        yield (first ? '' : ',') + results.map(({ _rid, ...r }) => JSON.stringify(r)).join(',')
        first = false
        if (results.length < JSON_PAGE) break
      }
    }
    yield ']'
  }
  yield '}'
}

export function fullJsonStream(env: Env, instance: string, now: number): ReadableStream<Uint8Array> {
  const it = fullJson(env, instance, now)
  return new ReadableStream<Uint8Array>({
    async pull(ctl) {
      const n = await it.next()
      if (n.done) ctl.close(); else ctl.enqueue(enc.encode(n.value))
    },
    async cancel() { await it.return(undefined) },
  })
}
