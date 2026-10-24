// /api/export/* and /api/import/leads. Admin only; the auth gate in index.ts has already checked the CSRF token on
// the POST. Exports are GET downloads (streamed), logged as `export` events; imports log an `import` event.
import { require, type Actor } from '../auth'
import { logEvent, type Env } from '../db'
import { json } from '../leads'
import { Bad, actorLabel, nowSec } from '../crm'
import { getSettings, phoneCountry } from '../settings'
import { isTimezone, localDate } from '../daytime'
import { fullJsonStream, leadsCsvStream } from '../export'
import { MAX_BYTES, MAX_CHUNK_ROWS, MAX_ROWS, checkMapping, commitImport, detectMapping, parseUpload, planImport, previewRows } from '../import'
import { actorId } from './settings'

const dl = (body: ReadableStream<Uint8Array>, type: string, name: string): Response =>
  new Response(body, { headers: { 'content-type': type, 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })

async function stamp(env: Env): Promise<string> {
  const cfg = await getSettings(env)
  return localDate(nowSec(), isTimezone(cfg.timezone) ? cfg.timezone : 'UTC')
}

async function log(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT id, kind, payload, created_at FROM events WHERE kind IN ('export','import') ORDER BY id DESC LIMIT 20`,
  ).all<{ id: number; kind: string; payload: string | null; created_at: number }>()
  return json({
    ok: true,
    events: results.map((e) => { let p: unknown = null; try { p = e.payload ? JSON.parse(e.payload) : null } catch { /* keep null */ } return { id: e.id, kind: e.kind, at: e.created_at, ...(p && typeof p === 'object' ? p : {}) } }),
    limits: { max_rows: MAX_ROWS, max_bytes: MAX_BYTES },
  })
}

/** Reads the request body with a hard byte cap: a declared Content-Length over the cap is a 413 before any byte is read,
 *  and a body that streams past it (no or false length) is cut off the same way. */
async function readCapped(req: Request, cap: number): Promise<Uint8Array> {
  const tooBig = () => new Bad(`the request is larger than ${Math.round(cap / 1024)} KB`, 'file', 413, { error: 'file_too_large', limit: cap })
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > cap) throw tooBig()
  if (!req.body) return new Uint8Array(0)
  const reader = req.body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > cap) { await reader.cancel().catch(() => {}); throw tooBig() }
    parts.push(value)
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.byteLength }
  return out
}

async function importLeads(req: Request, env: Env, actor: Actor | null): Promise<Response> {
  try {
    const ct = req.headers.get('content-type') ?? ''
    if (!ct.includes('multipart/form-data')) throw new Bad('send the CSV as multipart form data (field "file")', 'file', 415)
    const bytes = await readCapped(req, MAX_BYTES + 64 * 1024) // the file plus multipart framing
    const form = await new Response(bytes, { headers: { 'content-type': ct } }).formData()
    const file = form.get('file')
    if (!file || typeof file === 'string') throw new Bad('attach a CSV file in the "file" field', 'file')
    if (file.size > MAX_BYTES) throw new Bad(`the file is larger than ${MAX_BYTES / 1024 / 1024} MB`, 'file', 413, { error: 'file_too_large', limit: MAX_BYTES })
    const mode = String(form.get('mode') ?? 'inspect')
    if (mode === 'commit') throw new Bad('commit rows in chunks of at most 100 with POST /api/import/leads/commit', 'mode', 400, { error: 'use_chunked_commit', chunk_rows: MAX_CHUNK_ROWS })
    if (!['inspect', 'preview'].includes(mode)) throw new Bad('mode must be inspect or preview', 'mode')
    const parsed = parseUpload(await file.text())
    if (mode === 'inspect') {
      return json({ ok: true, mode, headers: parsed.headers, sample: parsed.rows.slice(0, 5), row_count: parsed.rows.length, mapping: detectMapping(parsed.headers), limits: { max_rows: MAX_ROWS, chunk_rows: MAX_CHUNK_ROWS } })
    }
    let rawMap: unknown
    try { rawMap = JSON.parse(String(form.get('mapping') ?? '')) } catch { throw new Bad('mapping must be JSON', 'mapping') }
    const mapping = checkMapping(rawMap, parsed.headers.length)
    const plan = await planImport(env, parsed, mapping, await phoneCountry(env))
    return json({ ok: true, mode, dry_run: true, counts: plan.counts, preview: previewRows(plan), errors: plan.errors, errors_truncated: plan.errors_truncated, new_tags: plan.newTags.slice(0, 50) })
  } catch (e) {
    if (e instanceof Bad) return json({ ok: false, error: e.message, ...(e.field ? { field: e.field } : {}), ...e.extra }, e.status)
    throw e
  }
}

const IMPORT_ID = /^[A-Za-z0-9_-]{8,64}$/
const CHUNK_BYTES = 256 * 1024
const MAX_COLS = 100
const MAX_CELL = 4000

/** One chunk of an import: at most 100 already-split rows plus the column mapping. Safe to send twice: every row carries
 *  a stable key, so a replayed chunk finds its leads already there and writes nothing. `last` closes the import in the log. */
async function importChunk(req: Request, env: Env, actor: Actor | null): Promise<Response> {
  try {
    const ct = req.headers.get('content-type') ?? ''
    if (!ct.includes('application/json')) throw new Bad('send JSON', 'body', 415)
    let body: any
    try { body = JSON.parse(new TextDecoder().decode(await readCapped(req, CHUNK_BYTES))) } catch (e) { if (e instanceof Bad) throw e; throw new Bad('body must be JSON', 'body') }
    if (!body || typeof body !== 'object') throw new Bad('body must be a JSON object', 'body')
    if (typeof body.import_id !== 'string' || !IMPORT_ID.test(body.import_id)) throw new Bad('import_id must be 8 to 64 letters, digits, - or _', 'import_id')
    if (!Number.isInteger(body.chunk) || body.chunk < 0 || body.chunk * MAX_CHUNK_ROWS >= MAX_ROWS) throw new Bad('chunk is out of range', 'chunk')
    const rows = body.rows
    if (!Array.isArray(rows) || !rows.length) throw new Bad('rows must be a non-empty array', 'rows')
    if (rows.length > MAX_CHUNK_ROWS) throw new Bad(`at most ${MAX_CHUNK_ROWS} rows per request`, 'rows', 413, { error: 'chunk_too_large', limit: MAX_CHUNK_ROWS })
    for (const r of rows) {
      if (!Array.isArray(r) || r.length > MAX_COLS || r.some((c: unknown) => typeof c !== 'string' || c.length > MAX_CELL)) throw new Bad('every row must be a list of text cells', 'rows')
    }
    const mapping = checkMapping(body.mapping, MAX_COLS)
    const file = typeof body.file === 'string' && body.file ? body.file.slice(0, 120) : 'import.csv'
    const plan = await planImport(env, { headers: [], rows, delimiter: ',' }, mapping, await phoneCountry(env), nowSec(), body.chunk * MAX_CHUNK_ROWS)
    const result = await commitImport(env, plan, { label: actorLabel(actor), id: actorId(actor) }, file)
    if (body.last === true) {
      const t = body.totals && typeof body.totals === 'object' ? body.totals : {}
      // `totals` is what the client has summed over the earlier chunks; this chunk is added here
      const n = (k: string) => (Number.isFinite(t[k]) ? Math.max(0, Math.trunc(t[k])) : 0)
      const add = (k: string, mine: number) => (k === 'rows' ? n(k) + rows.length : n(k) + mine)
      await logEvent(env.DB, 'import', { format: 'leads_csv', file, by: actorId(actor), import_id: body.import_id, rows: add('rows', 0), leads_created: add('leads_created', result.leads_created), contacts_created: add('contacts_created', result.contacts_created), duplicates: add('duplicates', result.duplicates), errors: add('errors', result.errors) })
    }
    return json({ ok: true, import_id: body.import_id, chunk: body.chunk, counts: plan.counts, errors: plan.errors, errors_truncated: plan.errors_truncated, result })
  } catch (e) {
    if (e instanceof Bad) return json({ ok: false, error: e.message, ...(e.field ? { field: e.field } : {}), ...e.extra }, e.status)
    throw e
  }
}

export async function handleExport(req: Request, env: Env, _ctx: ExecutionContext, path: string, actor: Actor | null, _url: URL): Promise<Response | null> {
  const isExport = path === '/api/export/leads.csv' || path === '/api/export/full.json' || path === '/api/export/log'
  const isImport = path === '/api/import/leads' || path === '/api/import/leads/commit'
  if (!isExport && !isImport) return null
  if (isExport && req.method !== 'GET') return json({ ok: false, error: 'method not allowed' }, 405)
  if (isImport && req.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405)
  const denied = require(actor, 'admin')
  if (denied) return denied
  if (path === '/api/export/log') return log(env)
  if (path === '/api/import/leads/commit') return importChunk(req, env, actor)
  if (isImport) return importLeads(req, env, actor)
  const day = await stamp(env)
  const by = actorId(actor)
  if (path === '/api/export/leads.csv') {
    await logEvent(env.DB, 'export', { format: 'leads_csv', by })
    return dl(leadsCsvStream(env), 'text/csv; charset=utf-8', `whaleads-leads-${day}.csv`)
  }
  await logEvent(env.DB, 'export', { format: 'full_json', by })
  return dl(fullJsonStream(env, (await getSettings(env)).business_name, nowSec()), 'application/json; charset=utf-8', `whaleads-export-${day}.json`)
}
