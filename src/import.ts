// Lead import: CSV -> mapped rows -> plan (dry run, one request) -> commit in client-driven chunks of at most 100 rows.
// Contacts dedupe by phone (E.164 digits, same key as contacts.wa_id): an existing contact only has blanks filled.
// Leads dedupe per row on a stable row key kept in leads.external_id: the CSV's own id when it has one, otherwise
// phone|source|created_at|stage. A row whose key already exists is skipped for every stage, so re-uploading a file (or
// replaying a chunk after a dropped response) creates nothing. An open row is also skipped when the contact already has
// an open lead. Every write for a row is one guarded statement chain, so a concurrent create cannot produce two open
// leads and a lost race writes nothing.
import { Bad, nowSec } from './crm'
import type { Env } from './db'
import { parseCsv, detectDelimiter, unguardCell } from './csv'
import { phoneError, toWaDigits } from './phone'

export const MAX_ROWS = 5000
export const MAX_CHUNK_ROWS = 100
export const MAX_BYTES = 2 * 1024 * 1024
export const BATCH_ROWS = 100
const LOOKUP_CHUNK = 500
const MAX_TAGS_PER_ROW = 10
const MAX_ERRORS = 200
const MAX_PREVIEW = 50

export const FIELDS = ['phone', 'name', 'email', 'source', 'stage', 'tags', 'notes', 'owner_email', 'message', 'created_at', 'next_action_at', 'lost_reason', 'external_id'] as const
export type Field = (typeof FIELDS)[number]
export type Mapping = Partial<Record<Field, number>>

const SYNONYMS: Record<Field, string[]> = {
  phone: ['phone', 'phonenumber', 'mobile', 'mobilenumber', 'mobileno', 'whatsapp', 'whatsappnumber', 'tel', 'telephone', 'cell', 'contactnumber'],
  name: ['name', 'fullname', 'customername', 'leadname', 'contactname', 'customer'],
  email: ['email', 'emailaddress', 'mail', 'emailid'],
  source: ['source', 'leadsource', 'channel'],
  stage: ['stage', 'status', 'leadstatus', 'leadstage'],
  tags: ['tags', 'tag', 'labels'],
  notes: ['notes', 'note', 'comments', 'comment', 'remarks'],
  owner_email: ['owneremail', 'assignedtoemail', 'owner', 'assignedto'],
  message: ['message', 'enquiry', 'inquiry', 'requirement'],
  created_at: ['createdat', 'created', 'createdon', 'date', 'createddate'],
  next_action_at: ['nextactionat', 'nextaction', 'followup', 'followupat'],
  lost_reason: ['lostreason'],
  external_id: ['externalid', 'leadid', 'crmid', 'referenceid', 'reference', 'ref'],
}
const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '')

export function detectMapping(headers: string[]): Mapping {
  const out: Mapping = {}
  const used = new Set<number>()
  for (const f of FIELDS) {
    for (const syn of SYNONYMS[f]) { // synonyms are in priority order: owner_email beats a plain "owner" column
      const i = headers.findIndex((h, idx) => !used.has(idx) && norm(h) === syn)
      if (i >= 0) { out[f] = i; used.add(i); break }
    }
  }
  return out
}

export function checkMapping(raw: unknown, width: number): Mapping {
  if (!raw || typeof raw !== 'object') throw new Bad('mapping is required', 'mapping')
  const out: Mapping = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === null || v === '' || v === undefined) continue
    if (!(FIELDS as readonly string[]).includes(k)) throw new Bad(`unknown field ${k}`, 'mapping')
    if (!Number.isInteger(v) || (v as number) < 0 || (v as number) >= width) throw new Bad(`column for ${k} is out of range`, 'mapping')
    out[k as Field] = v as number
  }
  if (out.phone === undefined) throw new Bad('map a phone column', 'mapping')
  return out
}

export interface Parsed { headers: string[]; rows: string[][]; delimiter: string }
/** Parses and enforces the file limits. The first row is the header. */
export function parseUpload(text: string): Parsed {
  const delimiter = detectDelimiter(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  const all = parseCsv(text, delimiter, MAX_ROWS + 2) // header + one row past the limit, then stop
  if (!all.length) throw new Bad('the file is empty', 'file')
  const [headers, ...rows] = all
  if (rows.length > MAX_ROWS) throw new Bad(`the file has more than ${MAX_ROWS} rows; the limit is ${MAX_ROWS}`, 'file', 413, { error: 'too_many_rows', limit: MAX_ROWS })
  return { headers: headers.map((h) => h.trim()), rows, delimiter }
}

export function parseWhen(raw: string, now: number): number | 'bad' | null {
  const s = raw.trim()
  if (!s) return null
  let t: number
  if (/^\d{9,10}$/.test(s)) t = Number(s)
  else if (/^\d{12,13}$/.test(s)) t = Math.floor(Number(s) / 1000)
  else { const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T00:00:00Z' : s); if (Number.isNaN(ms)) return 'bad'; t = Math.floor(ms / 1000) }
  if (t < 946684800 || t > 4102444800) return 'bad'
  return Math.min(t, now)
}

export type Action = 'create_lead' | 'duplicate_open_lead' | 'duplicate_in_file' | 'already_imported' | 'error'
export interface PlannedRow {
  row: number; key: string; action: Action; phone: string; wa: string; name: string; email: string; source: string; stage: string; kind: 'open' | 'won' | 'lost'
  tags: string[]; note: string; message: string; owner: number | null; created_at: number; next_action_at: number | null; lost_reason: string
  existing_contact: boolean; warnings: string[]
}
export interface RowError { row: number; message: string; phone?: string }
export interface Plan {
  counts: { rows: number; to_create: number; new_contacts: number; existing_contacts: number; duplicates: number; duplicates_open_lead: number; duplicates_in_file: number; duplicates_imported: number; errors: number; new_tags: number; warnings: number }
  planned: PlannedRow[]; errors: RowError[]; errors_truncated: boolean; newTags: string[]
}

interface Dims { sources: Map<string, string>; stages: Map<string, { key: string; kind: 'open' | 'won' | 'lost' }>; staff: Map<string, number>; tags: Map<string, number> }

async function loadDims(env: Env): Promise<Dims> {
  const [src, stg, stf, tg] = await Promise.all([
    env.DB.prepare(`SELECT key,label FROM sources WHERE archived=0`).all<{ key: string; label: string }>(),
    env.DB.prepare(`SELECT key,label,kind FROM stages WHERE archived=0`).all<{ key: string; label: string; kind: 'open' | 'won' | 'lost' }>(),
    env.DB.prepare(`SELECT id,email FROM staff WHERE active=1`).all<{ id: number; email: string }>(),
    env.DB.prepare(`SELECT id,label FROM tags`).all<{ id: number; label: string }>(),
  ])
  const sources = new Map<string, string>(), stages = new Map<string, { key: string; kind: 'open' | 'won' | 'lost' }>()
  for (const s of src.results) { sources.set(s.key.toLowerCase(), s.key); sources.set(s.label.toLowerCase(), s.key) }
  for (const s of stg.results) { stages.set(s.key.toLowerCase(), { key: s.key, kind: s.kind }); stages.set(s.label.toLowerCase(), { key: s.key, kind: s.kind }) }
  return { sources, stages, staff: new Map(stf.results.map((r) => [r.email.toLowerCase(), r.id])), tags: new Map(tg.results.map((t) => [t.label.toLowerCase(), t.id])) }
}

/** Existing contacts (by wa_id or form-captured phone) and whether they hold an open lead. */
async function lookupContacts(env: Env, phones: string[]): Promise<Map<string, { id: number; open: boolean }>> {
  const out = new Map<string, { id: number; open: boolean }>()
  for (let i = 0; i < phones.length; i += LOOKUP_CHUNK) {
    const chunk = JSON.stringify(phones.slice(i, i + LOOKUP_CHUNK))
    const { results } = await env.DB.prepare(
      `SELECT c.id, COALESCE(c.wa_id, c.phone) AS p,
              EXISTS (SELECT 1 FROM leads l JOIN stages s ON s.key = l.status WHERE l.contact_id = c.id AND s.kind = 'open') AS open
         FROM contacts c
        WHERE c.wa_id IN (SELECT value FROM json_each(?1)) OR (c.wa_id IS NULL AND c.phone IN (SELECT value FROM json_each(?1)))`,
    ).bind(chunk).all<{ id: number; p: string; open: number }>()
    for (const r of results) out.set(r.p, { id: r.id, open: !!r.open })
  }
  return out
}

/** Which of these row keys already sit on a lead (leads_external_idx). */
async function lookupKeys(env: Env, keys: string[]): Promise<Set<string>> {
  const out = new Set<string>()
  for (let i = 0; i < keys.length; i += LOOKUP_CHUNK) {
    const { results } = await env.DB.prepare(`SELECT external_id AS k FROM leads WHERE external_id IN (SELECT value FROM json_each(?1))`)
      .bind(JSON.stringify(keys.slice(i, i + LOOKUP_CHUNK))).all<{ k: string }>()
    for (const r of results) out.add(r.k)
  }
  return out
}

/** The stable identity of a CSV row. `created` is the parsed created_at, or null when the row has none (never "now",
 *  which would change on every upload). */
export function rowKey(wa: string, ext: string, source: string, created: number | null, stage: string): string {
  return ext ? `imp:x:${wa}:${ext.slice(0, 100)}` : `imp:h:${wa}|${source}|${created ?? 'na'}|${stage}`
}

const cell = (row: string[], m: Mapping, f: Field): string => (m[f] === undefined ? '' : unguardCell((row[m[f]!] ?? '').trim()))

export async function planImport(env: Env, parsed: Parsed, mapping: Mapping, country: string | null, now = nowSec(), rowBase = 0): Promise<Plan> {
  const dims = await loadDims(env)
  const planned: PlannedRow[] = [], errors: RowError[] = []
  let errCount = 0
  const addErr = (e: RowError) => { errCount++; if (errors.length < MAX_ERRORS) errors.push(e) }
  const seenKeys = new Set<string>(), seenOpen = new Set<string>(), phones = new Set<string>()
  const staged: PlannedRow[] = []
  parsed.rows.forEach((row, idx) => {
    const n = rowBase + idx + 2 // spreadsheet row number: header is row 1
    const rawPhone = cell(row, mapping, 'phone')
    const wa = toWaDigits(rawPhone, country)
    if (!wa) { addErr({ row: n, message: phoneError(rawPhone, country), phone: rawPhone.slice(0, 40) }); planned.push(errRow(n, rawPhone)); return }
    phones.add(wa)
    const warnings: string[] = []
    const name = cell(row, mapping, 'name').slice(0, 120)
    let email = cell(row, mapping, 'email')
    if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) { warnings.push('email ignored (not valid)'); email = '' }
    const srcRaw = cell(row, mapping, 'source')
    let source = 'import'
    if (srcRaw) { const k = dims.sources.get(srcRaw.toLowerCase()); if (k) source = k; else warnings.push(`unknown source "${srcRaw.slice(0, 30)}", used import`) }
    const stRaw = cell(row, mapping, 'stage')
    let stage = 'new', kind: 'open' | 'won' | 'lost' = 'open'
    if (stRaw) { const s = dims.stages.get(stRaw.toLowerCase()); if (s) { stage = s.key; kind = s.kind } else warnings.push(`unknown stage "${stRaw.slice(0, 30)}", used new`) }
    const tagRaw = cell(row, mapping, 'tags')
    const tagParts = tagRaw ? (tagRaw.includes(';') || tagRaw.includes('|') ? tagRaw.split(/[;|]/) : tagRaw.split(',')) : []
    const tags = [...new Map(tagParts.map((t) => t.trim().slice(0, 60)).filter(Boolean).map((t) => [t.toLowerCase(), t])).values()]
    if (tags.length > MAX_TAGS_PER_ROW) warnings.push(`only the first ${MAX_TAGS_PER_ROW} tags were kept`)
    const ownerRaw = cell(row, mapping, 'owner_email')
    let owner: number | null = null
    if (ownerRaw) { owner = dims.staff.get(ownerRaw.toLowerCase()) ?? null; if (owner === null) warnings.push('owner not found, left unassigned') }
    let created = now, createdRaw: number | null = null
    const cr = parseWhen(cell(row, mapping, 'created_at'), now)
    if (cr === 'bad') warnings.push('created date not understood, used now'); else if (cr !== null) { created = cr; createdRaw = cr }
    let next: number | null = null
    const nx = parseWhen(cell(row, mapping, 'next_action_at'), 4102444800)
    if (nx === 'bad') warnings.push('next action date not understood, ignored'); else if (nx !== null) next = nx
    const base = {
      row: n, key: rowKey(wa, cell(row, mapping, 'external_id'), source, createdRaw, stage), phone: '+' + wa, wa, name, email, source, stage, kind, tags: tags.slice(0, MAX_TAGS_PER_ROW), note: cell(row, mapping, 'notes').slice(0, 2000),
      message: cell(row, mapping, 'message').slice(0, 2000), owner, created_at: created, next_action_at: kind === 'open' ? next : null,
      lost_reason: kind === 'lost' ? cell(row, mapping, 'lost_reason').slice(0, 200) : '', existing_contact: false, warnings,
    }
    if (seenKeys.has(base.key) || (kind === 'open' && seenOpen.has(wa))) { planned.push({ ...base, action: 'duplicate_in_file' }); return }
    seenKeys.add(base.key)
    if (kind === 'open') seenOpen.add(wa)
    const r: PlannedRow = { ...base, action: 'create_lead' }
    planned.push(r); staged.push(r)
  })
  const [found, imported] = await Promise.all([lookupContacts(env, [...phones]), lookupKeys(env, staged.map((r) => r.key))])
  for (const r of staged) {
    const c = found.get(r.wa)
    if (c) { r.existing_contact = true; if (c.open && r.kind === 'open') r.action = 'duplicate_open_lead' }
    if (imported.has(r.key)) r.action = 'already_imported'
  }
  const newTags = new Set<string>()
  for (const r of planned) if (r.action === 'create_lead') for (const t of r.tags) if (!dims.tags.has(t.toLowerCase())) newTags.add(t)
  const c = (a: Action) => planned.filter((r) => r.action === a).length
  const people = (existing: boolean) => new Set(planned.filter((r) => r.action !== 'error' && r.action !== 'duplicate_in_file' && r.existing_contact === existing).map((r) => r.wa)).size
  const counts = {
    rows: parsed.rows.length, to_create: c('create_lead'), new_contacts: people(false), existing_contacts: people(true),
    duplicates: c('duplicate_open_lead') + c('duplicate_in_file') + c('already_imported'), duplicates_open_lead: c('duplicate_open_lead'), duplicates_in_file: c('duplicate_in_file'),
    duplicates_imported: c('already_imported'),
    errors: errCount, new_tags: newTags.size, warnings: planned.reduce((a, r) => a + r.warnings.length, 0),
  }
  return { counts, planned, errors, errors_truncated: errCount > errors.length, newTags: [...newTags] }
}
const errRow = (row: number, phone: string): PlannedRow => ({
  row, key: '', action: 'error', phone, wa: '', name: '', email: '', source: '', stage: '', kind: 'open', tags: [], note: '', message: '', owner: null, created_at: 0,
  next_action_at: null, lost_reason: '', existing_contact: false, warnings: [],
})

/** Rows for the preview table (errors are listed separately). */
export function previewRows(plan: Plan) {
  return plan.planned.filter((r) => r.action !== 'error').slice(0, MAX_PREVIEW).map((r) => ({
    row: r.row, action: r.action, phone: r.phone, name: r.name, source: r.source, stage: r.stage, tags: r.tags, existing_contact: r.existing_contact, warnings: r.warnings,
  }))
}

export interface CommitResult { contacts_created: number; contacts_updated: number; leads_created: number; duplicates: number; errors: number; tags_created: number; batches: number }

const CID = `(SELECT id FROM contacts WHERE wa_id=?1 OR (wa_id IS NULL AND phone=?1) ORDER BY (wa_id IS NOT NULL) DESC, id LIMIT 1)`
const NEWEST = `(SELECT id FROM leads WHERE contact_id=${CID} ORDER BY id DESC LIMIT 1)`

export async function commitImport(env: Env, plan: Plan, by: { label: string; id: number | null }, file: string, now = nowSec()): Promise<CommitResult> {
  const res: CommitResult = { contacts_created: 0, contacts_updated: 0, leads_created: 0, duplicates: plan.counts.duplicates, errors: plan.counts.errors, tags_created: 0, batches: 0 }
  // tags first, in their own batch, so rows only reference ids that exist
  const tagIds = new Map<string, number>()
  if (plan.newTags.length) {
    const r = await env.DB.batch(plan.newTags.map((t) => env.DB.prepare(`INSERT OR IGNORE INTO tags (label,color) VALUES (?,'neutral')`).bind(t)))
    res.tags_created = r.reduce((a, x) => a + (x.meta.changes ?? 0), 0)
  }
  const want = [...new Set(plan.planned.filter((r) => r.action === 'create_lead').flatMap((r) => r.tags.map((t) => t.toLowerCase())))]
  for (let i = 0; i < want.length; i += LOOKUP_CHUNK) {
    const { results } = await env.DB.prepare(`SELECT id,label FROM tags WHERE lower(label) IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(want.slice(i, i + LOOKUP_CHUNK))).all<{ id: number; label: string }>()
    for (const t of results) tagIds.set(t.label.toLowerCase(), t.id)
  }
  const todo = plan.planned.filter((r) => r.action === 'create_lead')
  for (let i = 0; i < todo.length; i += BATCH_ROWS) {
    const stmts: D1PreparedStatement[] = []
    const marks: { rowIdx: number; kind: 'contact' | 'update' | 'lead' }[] = []
    for (const r of todo.slice(i, i + BATCH_ROWS)) {
      const add = (s: D1PreparedStatement, kind?: 'contact' | 'update' | 'lead') => { if (kind) marks.push({ rowIdx: stmts.length, kind }); stmts.push(s) }
      add(env.DB.prepare(
        `INSERT INTO contacts (wa_id,phone,name,email,source,first_seen_at,last_seen_at)
         SELECT ?1,?1,?2,?3,'import',?4,?4 WHERE NOT EXISTS (SELECT 1 FROM contacts WHERE wa_id=?1 OR (wa_id IS NULL AND phone=?1))`,
      ).bind(r.wa, r.name || null, r.email || null, now), 'contact')
      if (r.existing_contact) {
        add(env.DB.prepare(
          `UPDATE contacts SET wa_id=COALESCE(wa_id,?1), name=COALESCE(NULLIF(name,''),?2), email=COALESCE(NULLIF(email,''),?3)
            WHERE id=${CID}`,
        ).bind(r.wa, r.name || null, r.email || null), 'update')
      }
      // historical rows carry their own date: a won lead from last March must not land in this week's report
      const won = r.kind === 'won' ? r.created_at : null, closed = r.kind === 'open' ? null : r.created_at
      add(env.DB.prepare(
        `INSERT INTO leads (contact_id,source,message,status,assigned_to,next_action_at,created_at,updated_at,last_activity_at,won_at,closed_at,lost_reason,external_id)
         SELECT ${CID},?2,?3,?4,?5,?6,?7,?8,?8,?9,?10,?11,?12
          WHERE NOT EXISTS (SELECT 1 FROM leads WHERE contact_id=${CID} AND external_id=?12)
            AND (?13 = 0 OR NOT EXISTS (SELECT 1 FROM leads l JOIN stages s ON s.key=l.status WHERE l.contact_id=${CID} AND s.kind='open'))`,
      ).bind(r.wa, r.source, r.message || null, r.stage, r.owner, r.next_action_at, r.created_at, now, won, closed, r.lost_reason || null, r.key, r.kind === 'open' ? 1 : 0), 'lead')
      // every statement below inserts exactly one row, so changes() stays 1 after a created lead and 0 after a lost race
      add(env.DB.prepare(`INSERT INTO activity (lead_id,contact_id,actor,kind,data,created_at) SELECT ${NEWEST},${CID},?2,'imported',?3,?4 WHERE changes() > 0`)
        .bind(r.wa, by.label, JSON.stringify({ source: r.source, file: file.slice(0, 120), row: r.row, tags: r.tags, by: by.id }), now))
      if (r.note) {
        add(env.DB.prepare(`INSERT INTO activity (lead_id,contact_id,actor,kind,data,created_at) SELECT ${NEWEST},${CID},?2,'note',?3,?4 WHERE changes() > 0`)
          .bind(r.wa, by.label, JSON.stringify({ text: r.note }), now))
      }
      for (const t of r.tags) {
        const id = tagIds.get(t.toLowerCase())
        if (id !== undefined) add(env.DB.prepare(`INSERT OR IGNORE INTO lead_tags (lead_id,tag_id) SELECT ${NEWEST},?2 WHERE changes() > 0`).bind(r.wa, id))
      }
    }
    const out = await env.DB.batch(stmts)
    res.batches++
    for (const m of marks) {
      const ch = out[m.rowIdx].meta.changes ?? 0
      if (m.kind === 'contact') res.contacts_created += ch
      else if (m.kind === 'update') res.contacts_updated += ch ? 1 : 0
      else if (ch) res.leads_created += ch; else res.duplicates++
    }
  }
  return res
}
