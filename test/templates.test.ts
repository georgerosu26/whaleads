// template rules, both adaptors' request shapes (mocked fetch only), the routes, sync and the cron hook.
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'
import { CloudApiAdaptor } from '../src/adaptors/cloud-api'
import { WhaBuzzAdaptor } from '../src/adaptors/whabuzz'
import { saveConfig } from '../src/adaptors'
import { ensureSchema, type Env } from '../src/db'
import { buildComponents, validateTemplate, type TemplateInput } from '../src/templateRules'
import { normalizeRemote, syncPendingTemplates } from '../src/templates'
import { fakeD1 } from './d1'
import { fakeR2 } from './r2'

const SECRET = 'test-session-secret-0123456789'
const ORIGIN = 'https://leads.example.com'
const WB = { kind: 'whabuzz' as const, config: { api_key: 'k', phone_number_id: '1000000000000001', waba_id: '2', webhook_secret: 'whsec_TEST_x' } }
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6])

let env: Env
let raw: DatabaseSync
let r2: ReturnType<typeof fakeR2>
let waiting: Promise<unknown>[]
const ctx = { waitUntil: (p: Promise<unknown>) => { waiting.push(p) }, passThroughOnException: () => {} } as unknown as ExecutionContext
const q = <T = any>(sql: string, ...a: any[]) => raw.prepare(sql).get(...a) as T
const rows = <T = any>(sql: string, ...a: any[]) => raw.prepare(sql).all(...a) as T[]
const now = () => Math.floor(Date.now() / 1000)

type Call = { url: string; method: string; body: any; headers: Record<string, string> }
let calls: Call[]
let route: (c: Call) => { status?: number; json: any } | undefined
function mockFetch() {
  calls = []
  vi.stubGlobal('fetch', async (url: string, init: any = {}) => {
    let body = init.body
    if (typeof body === 'string') { try { body = JSON.parse(body) } catch { /* keep */ } }
    const c: Call = { url: String(url), method: init.method ?? 'GET', body, headers: Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])) }
    calls.push(c)
    const r = route(c) ?? { json: {} }
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 })
  })
}

async function session() {
  const res = await worker.fetch(new Request(`${ORIGIN}/api/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ setup_key: SECRET, business_name: 'Example Co', default_country: 'US', timezone: 'UTC', admin: { name: 'Test Admin', email: 'admin@example.com', password: 'correct horse battery' } }),
  }), env, ctx)
  const body: any = await res.json()
  return { cookie: (res.headers.get('set-cookie') ?? '').split(';')[0]!, csrf: body.csrf as string }
}
let S: { cookie: string; csrf: string }
async function call(method: string, path: string, body?: unknown, o: { auth?: boolean; csrf?: boolean } = {}) {
  const headers: Record<string, string> = {}
  if (o.auth !== false) headers.Cookie = S.cookie
  if (o.csrf !== false && o.auth !== false) headers['X-CSRF-Token'] = S.csrf
  if (method !== 'GET') headers.Origin = ORIGIN
  let init: BodyInit | undefined
  if (body instanceof FormData) {
    const r = new Response(body); init = await r.arrayBuffer(); headers['content-type'] = r.headers.get('content-type')!; headers['content-length'] = String((init as ArrayBuffer).byteLength)
  } else if (body !== undefined) { headers['content-type'] = 'application/json'; init = JSON.stringify(body) }
  return worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers, body: init }), env, ctx)
}
const J = async (r: Response) => (await r.json()) as any

function seedContact(id = 1, inbound: number | null = now() - 60) {
  raw.prepare(`INSERT OR IGNORE INTO contacts (id,wa_id,phone,name) VALUES (?,?,?,?)`).run(id, `15550000${String(id).padStart(3, '0')}`, `15550000${String(id).padStart(3, '0')}`, `Person ${id}`)
  raw.prepare(`INSERT OR IGNORE INTO conversations (contact_id,last_message_at,last_inbound_at,last_preview,unread_count) VALUES (?,?,?,?,0)`).run(id, inbound ?? 0, inbound, 'hi')
}
function seedTemplate(o: Partial<{ id: string; name: string; status: string; fmt: string; body: string; bp: number; hp: number; key: string | null; synced: number | null; header: string }> = {}) {
  const comps: any[] = []
  const fmt = o.fmt ?? 'NONE'
  if (fmt === 'TEXT') comps.push({ type: 'HEADER', format: 'TEXT', text: o.header ?? 'Order {{1}}' })
  else if (fmt !== 'NONE') comps.push({ type: 'HEADER', format: fmt })
  comps.push({ type: 'BODY', text: o.body ?? 'Hi {{1}}, your order {{2}} shipped.' })
  raw.prepare(`INSERT INTO templates (id,name,language,status,components,header_format,header_media_r2_key,header_media_mime,body_params_count,header_params_count,synced_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(o.id ?? 't1', o.name ?? 'order_update', 'en', o.status ?? 'APPROVED', JSON.stringify(comps), fmt, o.key ?? null, o.key ? 'image/png' : null, o.bp ?? 2, o.hp ?? (fmt === 'TEXT' ? 1 : 0), o.synced === undefined ? now() : o.synced)
}

beforeEach(async () => {
  const f = fakeD1(); raw = f.raw; r2 = fakeR2(); waiting = []
  env = { DB: f.d1, MEDIA: r2.bucket, ADMIN_KEY: 'adminkey', SESSION_SECRET: SECRET, INSTANCE_NAME: 'inst', ALLOWED_ORIGINS: '', META_APP_SECRET: 'appsecret' } as unknown as Env
  await ensureSchema(f.d1)
  await saveConfig(env, WB)
  S = await session()
  route = () => undefined
  mockFetch()
})
afterEach(() => vi.unstubAllGlobals())

// ---- rules ----------------------------------------------------------------------------------------
const base: TemplateInput = { name: 'order_update', language: 'en', category: 'UTILITY', body: 'Hi {{1}}, order {{2}} is on its way.', body_samples: ['Asha', 'A100'] }
describe('validateTemplate', () => {
  const field = (t: Partial<TemplateInput>) => validateTemplate({ ...base, ...t }).errors.map((e) => e.field)
  it('accepts a valid template', () => expect(validateTemplate(base).errors).toEqual([]))
  const table: [string, Partial<TemplateInput>, string][] = [
    ['uppercase name', { name: 'Order' }, 'name'],
    ['dash in name', { name: 'order-update' }, 'name'],
    ['name over 512', { name: 'a'.repeat(513) }, 'name'],
    ['bad language', { language: 'english' }, 'language'],
    ['bad category', { category: 'PROMO' }, 'category'],
    ['empty body', { body: '  ' }, 'body'],
    ['body over 1024', { body: 'x'.repeat(1025), body_samples: [] }, 'body'],
    ['11 placeholders', { body: Array.from({ length: 11 }, (_, i) => `a {{${i + 1}}}`).join(' ') + ' end', body_samples: Array(11).fill('x') }, 'body'],
    ['gap in numbering', { body: 'a {{1}} b {{3}} c', body_samples: ['x', 'y'] }, 'body'],
    ['named variable', { body: 'a {{name}} b', body_samples: [] }, 'body'],
    ['missing sample', { body_samples: ['Asha'] }, 'body_samples'],
    ['footer too long', { footer: 'f'.repeat(61) }, 'footer'],
    ['footer variable', { footer: 'ref {{1}}' }, 'footer'],
    ['header text over 60', { header: { format: 'TEXT', text: 'h'.repeat(61) } }, 'header_text'],
    ['two header variables', { header: { format: 'TEXT', text: '{{1}} {{2}}', text_sample: 'x' } }, 'header_text'],
    ['header variable without sample', { header: { format: 'TEXT', text: 'Hi {{1}}' } }, 'header_sample'],
    ['image header without sample', { header: { format: 'IMAGE' }, has_media_sample: false }, 'media'],
  ]
  for (const [label, patch, f] of table) it(`rejects ${label}`, () => expect(field(patch)).toContain(f))
  it('warns (does not fail) when the body starts with a variable', () => {
    const r = validateTemplate({ ...base, body: '{{1}} your order {{2}}' })
    expect(r.errors).toEqual([]); expect(r.warnings[0]?.field).toBe('body')
  })
})

// ---- adaptor request shapes ----------------------------------------------------------------------------
describe('adaptor request shapes (mocked fetch)', () => {
  const wb = () => new WhaBuzzAdaptor(WB.config, fetch as any, 'https://api.whabuzz.com/v1')
  const ca = () => new CloudApiAdaptor({ system_token: 'tok', app_secret: 's', phone_number_id: '111', waba_id: '222', app_id: '333' }, fetch as any)
  const input: TemplateInput = { ...base, header: { format: 'IMAGE' }, footer: 'Reply STOP to opt out', has_media_sample: true }

  it('WhaBuzz create: waba_id + Meta body, components HEADER, BODY, FOOTER with example.header_handle', async () => {
    route = () => ({ json: { id: 'tpl_1', status: 'PENDING', category: 'UTILITY' } })
    await wb().templates.create({ name: 'order_update', language: 'en', category: 'UTILITY', components: buildComponents(input, '4::abc') })
    expect(calls[0]).toMatchObject({ url: 'https://api.whabuzz.com/v1/templates', method: 'POST', headers: { authorization: 'Bearer k' } })
    expect(calls[0]!.body).toEqual({
      waba_id: '2', name: 'order_update', language: 'en', category: 'UTILITY',
      components: [
        { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['4::abc'] } },
        { type: 'BODY', text: 'Hi {{1}}, order {{2}} is on its way.', example: { body_text: [['Asha', 'A100']] } },
        { type: 'FOOTER', text: 'Reply STOP to opt out' },
      ],
    })
  })
  it('WhaBuzz media-handle is multipart with file (and type)', async () => {
    route = () => ({ json: { h: '4::abc' } })
    const r = await wb().templates.mediaHandle(PNG, 'image/png')
    expect(r.data.h).toBe('4::abc')
    expect(calls[0]!.url).toBe('https://api.whabuzz.com/v1/templates/media-handle')
    expect(calls[0]!.body).toBeInstanceOf(FormData)
    expect((calls[0]!.body as FormData).get('file')).toBeInstanceOf(Blob)
  })
  it('WhaBuzz delete looks the id up by name, then DELETEs it', async () => {
    route = (c) => (c.method === 'GET' ? { json: { data: [{ id: 'tpl_9' }] } } : { json: { ok: true } })
    await wb().templates.delete({ name: 'order_update' })
    expect(calls.map((c) => `${c.method} ${c.url.replace('https://api.whabuzz.com/v1', '').split('?')[0]}`)).toEqual(['GET /templates', 'DELETE /templates/tpl_9'])
  })
  it('Cloud API create: POST {waba}/message_templates with Meta body, Bearer system token', async () => {
    route = () => ({ json: { id: '999', status: 'PENDING', category: 'UTILITY' } })
    await ca().templates.create({ name: 'order_update', language: 'en', category: 'UTILITY', components: buildComponents(input, '4::abc') })
    expect(calls[0]).toMatchObject({ url: expect.stringMatching(/graph\.facebook\.com\/v[\d.]+\/222\/message_templates$/), method: 'POST', headers: { authorization: 'Bearer tok' } })
    expect(calls[0]!.body.components[0]).toEqual({ type: 'HEADER', format: 'IMAGE', example: { header_handle: ['4::abc'] } })
  })
  it('Cloud API media handle: uploads session, then raw bytes with OAuth + file_offset 0', async () => {
    route = (c) => (c.url.includes('/333/uploads') ? { json: { id: 'upload:SESS' } } : { json: { h: '4::handle' } })
    const r = await ca().templates.mediaHandle(PNG, 'image/png')
    expect(r.data.h).toBe('4::handle')
    expect(calls[0]!.url).toMatch(/\/333\/uploads\?file_length=10&file_type=image%2Fpng$/)
    expect(calls[1]).toMatchObject({ method: 'POST', headers: { authorization: 'OAuth tok', file_offset: '0' } })
    expect(calls[1]!.url).toMatch(/\/upload:SESS$/)
  })
  it('Cloud API list asks for id, components and rejected_reason', async () => {
    await ca().templates.list()
    expect(calls[0]!.url).toMatch(/fields=id,name,status,category,language,rejected_reason,quality_score,components&limit=100/)
  })
  it('Cloud API delete by name (+ hsm_id)', async () => {
    await ca().templates.delete({ name: 'order_update', id: '999' })
    expect(calls[0]).toMatchObject({ method: 'DELETE' }); expect(calls[0]!.url).toMatch(/222\/message_templates\?name=order_update&hsm_id=999$/)
  })
  for (const [label, mk, urlRe] of [['WhaBuzz', wb, /\/messages$/], ['Cloud API', ca, /\/111\/messages$/]] as const) {
    it(`${label} sendTemplate: header image by id then body parameters`, async () => {
      route = () => ({ json: { messages: [{ id: 'wamid.T1' }] } })
      const r = await mk().sendTemplate('15550000001', 'order_update', 'en', ['Asha', 'A100'], { format: 'IMAGE', mediaId: 'mid_1' })
      expect(r.wamid).toBe('wamid.T1'); expect(calls[0]!.url).toMatch(urlRe)
      expect(calls[0]!.body.template).toEqual({
        name: 'order_update', language: { code: 'en' },
        components: [
          { type: 'header', parameters: [{ type: 'image', image: { id: 'mid_1' } }] },
          { type: 'body', parameters: [{ type: 'text', text: 'Asha' }, { type: 'text', text: 'A100' }] },
        ],
      })
      expect(calls[0]!.body).toMatchObject({ messaging_product: 'whatsapp', to: '15550000001', type: 'template' })
    })
    it(`${label} sendTemplate: header by link, document filename, text header params, no body component when none`, async () => {
      route = () => ({ json: { messages: [{ id: 'w' }] } })
      await mk().sendTemplate('1', 'n', 'en', [], { format: 'VIDEO', link: 'https://example.com/v.mp4' })
      expect(calls[0]!.body.template.components).toEqual([{ type: 'header', parameters: [{ type: 'video', video: { link: 'https://example.com/v.mp4' } }] }])
      await mk().sendTemplate('1', 'n', 'en', [], { format: 'DOCUMENT', mediaId: 'd1', filename: 'a.pdf' })
      expect(calls[1]!.body.template.components[0].parameters[0]).toEqual({ type: 'document', document: { id: 'd1', filename: 'a.pdf' } })
      await mk().sendTemplate('1', 'n', 'en', ['x'], { format: 'TEXT', params: ['H'] })
      expect(calls[2]!.body.template.components).toEqual([{ type: 'header', parameters: [{ type: 'text', text: 'H' }] }, { type: 'body', parameters: [{ type: 'text', text: 'x' }] }])
    })
  }
})

// ---- routes ----------------------------------------------------------------------------------------------
describe('gate and CSRF', () => {
  it('every route needs a session; state changes need the CSRF token', async () => {
    seedContact(); seedTemplate()
    for (const [m, p] of [['GET', '/api/templates'], ['POST', '/api/templates'], ['POST', '/api/templates/sync'], ['DELETE', '/api/templates/t1'], ['GET', '/api/templates/t1/media'], ['POST', '/api/inbox/1/send-template']] as const) {
      expect((await call(m, p, m === 'GET' ? undefined : {}, { auth: false })).status, `${m} ${p}`).toBe(401)
    }
    for (const [m, p] of [['POST', '/api/templates'], ['POST', '/api/templates/sync'], ['DELETE', '/api/templates/t1'], ['POST', '/api/inbox/1/send-template']] as const) {
      expect((await call(m, p, {}, { csrf: false })).status, `${m} ${p} csrf`).toBe(403)
    }
    expect(calls).toEqual([])
  })
})

describe('POST /api/templates', () => {
  const body = { name: 'order_update', language: 'en', category: 'UTILITY', body: 'Hi {{1}}, order {{2}} is on its way.', body_samples: ['Asha', 'A100'] }
  it('creates, stores PENDING with counts, no upstream call on invalid input', async () => {
    const bad = await call('POST', '/api/templates', { ...body, name: 'Bad Name' })
    expect(bad.status).toBe(400); expect(await J(bad)).toMatchObject({ ok: false, field: 'name' })
    expect(calls).toEqual([])
    route = () => ({ json: { id: 'tpl_1', status: 'PENDING', category: 'UTILITY' } })
    const r = await call('POST', '/api/templates', body)
    expect(r.status).toBe(200)
    const j = await J(r)
    expect(j.template).toMatchObject({ id: 'tpl_1', name: 'order_update', status: 'PENDING', header_format: 'NONE', body_params_count: 2 })
    expect(q(`SELECT status, body_params_count FROM templates WHERE id='tpl_1'`)).toEqual({ status: 'PENDING', body_params_count: 2 })
    expect(calls[0]!.body.components).toEqual([{ type: 'BODY', text: body.body, example: { body_text: [['Asha', 'A100']] } }])
  })
  it('media header: sample goes to media-handle first, the handle into the create body, the sample into R2', async () => {
    route = (c) => (c.url.endsWith('/media-handle') ? { json: { h: '4::H' } } : { json: { id: 'tpl_2', status: 'PENDING' } })
    const fd = new FormData()
    fd.set('payload', JSON.stringify({ ...body, name: 'promo_img', header: { format: 'IMAGE' } }))
    fd.set('sample', new File([PNG], 'p.png', { type: 'image/png' }))
    const r = await call('POST', '/api/templates', fd)
    expect(r.status).toBe(200)
    expect(calls.map((c) => c.url.split('/v1')[1])).toEqual(['/templates/media-handle', '/templates'])
    expect(calls[1]!.body.components[0]).toEqual({ type: 'HEADER', format: 'IMAGE', example: { header_handle: ['4::H'] } })
    const t = q(`SELECT header_format, header_media_r2_key k, header_media_mime m FROM templates WHERE id='tpl_2'`)
    expect(t).toMatchObject({ header_format: 'IMAGE', m: 'image/png' }); expect(r2.store.has(t.k)).toBe(true)
    const media = await call('GET', '/api/templates/tpl_2/media')
    expect(media.headers.get('content-type')).toBe('image/png')
  })
  it('media header without a file is a 400 on field media; a text file is refused 415', async () => {
    expect(await J(await call('POST', '/api/templates', { ...body, header: { format: 'IMAGE' } }))).toMatchObject({ field: 'media' })
    const fd = new FormData(); fd.set('payload', JSON.stringify({ ...body, header: { format: 'IMAGE' } })); fd.set('sample', new File(['hi'], 'x.txt', { type: 'text/plain' }))
    expect((await call('POST', '/api/templates', fd)).status).toBe(415)
    expect(calls).toEqual([])
  })
  it('passes Meta errors through verbatim and maps 2388293 to the body field', async () => {
    const meta = { message: 'Invalid parameter', type: 'OAuthException', code: 100, error_subcode: 2388293, error_user_msg: 'This message template has too many variables for its length.' }
    route = () => ({ status: 400, json: { source: 'meta', error: meta } })
    const r = await call('POST', '/api/templates', body)
    expect(r.status).toBe(502)
    const j = await J(r)
    expect(j).toMatchObject({ ok: false, field: 'body', source: 'meta', graph: meta, error: meta.error_user_msg, stage: 'create' })
    expect(j.hint).toMatch(/more fixed text/)
    expect(q(`SELECT COUNT(*) n FROM templates`).n).toBe(0)
  })
  it('create is admin only', async () => {
    raw.exec(`UPDATE staff SET role='staff'`)
    const r = await call('POST', '/api/templates', body)
    expect([401, 403]).toContain(r.status)
    expect(calls).toEqual([])
  })
})

describe('sync', () => {
  it('upserts statuses and keeps rejected_reason verbatim (WhaBuzz shape)', async () => {
    seedTemplate({ id: 'tpl_a', name: 'a_one', status: 'PENDING' })
    seedTemplate({ id: 'tpl_b', name: 'b_two', status: 'PENDING' })
    const reason = 'INVALID_FORMAT: Variable parameters cannot be placed at the start or end.'
    route = (c) => c.url.includes('/templates/sync') ? { json: { fetched: 3 } } : {
      json: { data: [
        { id: 'tpl_a', name: 'a_one', language: 'en', category: 'UTILITY', status: 'APPROVED', status_reason: null, meta_object: { components: [{ type: 'BODY', text: 'Hello {{1}} there' }] } },
        { id: 'tpl_b', name: 'b_two', language: 'en', category: 'MARKETING', status: 'REJECTED', status_reason: reason, meta_object: { components: [{ type: 'BODY', text: 'x' }] } },
        { id: 'tpl_c', name: 'c_new', language: 'en_US', category: 'UTILITY', status: 'APPROVED', meta_object: { components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'a {{1}} b {{2}}' }] } },
      ] },
    }
    const r = await call('POST', '/api/templates/sync')
    expect(r.status).toBe(200); expect(await J(r)).toMatchObject({ ok: true, count: 3, changed: 3 })
    expect(rows(`SELECT id, status, rejected_reason r, category, header_format h, body_params_count b FROM templates ORDER BY id`)).toEqual([
      { id: 'tpl_a', status: 'APPROVED', r: null, category: 'UTILITY', h: 'NONE', b: 1 },
      { id: 'tpl_b', status: 'REJECTED', r: reason, category: 'MARKETING', h: 'NONE', b: 0 },
      { id: 'tpl_c', status: 'APPROVED', r: null, category: 'UTILITY', h: 'IMAGE', b: 2 },
    ])
    const list = await J(await call('GET', '/api/templates'))
    expect(list.templates.find((t: any) => t.id === 'tpl_b')).toMatchObject({ status: 'REJECTED', rejected_reason: reason })
  })
  it('GET ?sync=1 is a no-op: the stored list comes back and the provider is never called', async () => {
    seedTemplate({ status: 'PENDING' })
    const j = await J(await call('GET', '/api/templates?sync=1'))
    expect(j.templates).toHaveLength(1); expect(j.sync).toBeUndefined(); expect(calls).toEqual([])
  })
  it('sync removes templates Meta no longer lists (old rows), keeps fresh ones, and counts them as changed', async () => {
    seedTemplate({ id: 'keep', name: 'keep_me' }); seedTemplate({ id: 'gone', name: 'gone_one' }); seedTemplate({ id: 'fresh', name: 'fresh_one' })
    raw.exec(`UPDATE templates SET created_at = ${now() - 3600} WHERE id IN ('keep','gone')`)
    route = (c) => c.url.includes('/templates/sync') ? { json: {} } : { json: { data: [
      { id: 'keep', name: 'keep_me', language: 'en', category: 'UTILITY', status: 'APPROVED', meta_object: { components: [{ type: 'BODY', text: 'Hi {{1}}, your order {{2}} shipped.' }] } },
      { id: 'x', name: 'x_deleted', language: 'en', category: 'UTILITY', status: 'DELETED', meta_object: { components: [{ type: 'BODY', text: 'x' }] } },
    ] } }
    const j = await J(await call('POST', '/api/templates/sync'))
    expect(j.removed).toBe(1)
    expect(rows(`SELECT id FROM templates ORDER BY id`).map((r: any) => r.id)).toEqual(['fresh', 'keep'])
  })
  it('a malformed template id in the path is a 400 with no exception text', async () => {
    const r = await call('DELETE', '/api/templates/%E0%A4%A')
    expect(r.status).toBe(400); const t = await r.text(); expect(t).not.toMatch(/URIError|malformed/i)
    expect((await call('GET', '/api/templates/%E0%A4%A/media')).status).toBe(400)
  })
  it('Cloud API list shape (rejected_reason "NONE" -> null, components top level) is normalised', async () => {
    await saveConfig(env, { kind: 'cloud_api', config: { system_token: 't', app_secret: 's', phone_number_id: '1', waba_id: '2' } })
    route = () => ({ json: { data: [{ id: '77', name: 'g_one', language: 'en', category: 'UTILITY', status: 'APPROVED', rejected_reason: 'NONE', components: [{ type: 'BODY', text: 'hi' }] }] } })
    expect((await call('POST', '/api/templates/sync')).status).toBe(200)
    expect(q(`SELECT id, status, rejected_reason r FROM templates`)).toEqual({ id: '77', status: 'APPROVED', r: null })
  })
})

describe('cron sync', () => {
  it('runs only while a PENDING template is stale; never when none are pending or all are fresh', async () => {
    route = () => ({ json: { data: [] } })
    seedTemplate({ id: 'ok1', name: 'ok_one', status: 'APPROVED', synced: null })
    await syncPendingTemplates(env); expect(calls).toEqual([])
    seedTemplate({ id: 'p1', name: 'p_one', status: 'PENDING', synced: now() - 60 })
    await syncPendingTemplates(env); expect(calls).toEqual([])
    raw.exec(`UPDATE templates SET synced_at = ${now() - 4000} WHERE id='p1'`)
    await syncPendingTemplates(env); expect(calls.length).toBeGreaterThan(0)
  })
  it('a PENDING row that no longer exists upstream is dropped after one miss, so the cron stops re-syncing it', async () => {
    route = () => ({ json: { data: [] } })
    seedTemplate({ id: 'p9', name: 'p_nine', status: 'PENDING', synced: now() - 4000 })
    raw.exec(`UPDATE templates SET created_at = ${now() - 7200} WHERE id='p9'`)
    await syncPendingTemplates(env)
    expect(q(`SELECT COUNT(*) n FROM templates`).n).toBe(0)
    const before = calls.length
    await syncPendingTemplates(env); expect(calls.length).toBe(before)
  })
})

describe('DELETE /api/templates/:id', () => {
  it('deletes upstream then locally; an upstream failure keeps the row', async () => {
    seedTemplate({ id: 'tpl_d', name: 'd_one' })
    route = () => ({ status: 400, json: { source: 'meta', error: { message: 'nope', code: 100 } } })
    expect((await call('DELETE', '/api/templates/tpl_d')).status).toBe(502)
    expect(q(`SELECT COUNT(*) n FROM templates`).n).toBe(1)
    route = () => ({ json: { success: true } })
    expect((await call('DELETE', '/api/templates/tpl_d')).status).toBe(200)
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE' })
    expect(q(`SELECT COUNT(*) n FROM templates`).n).toBe(0)
  })
})

describe('POST /api/inbox/:id/send-template', () => {
  const send = (b: unknown) => call('POST', '/api/inbox/1/send-template', b)
  const sent = () => calls.filter((c) => c.url.endsWith('/messages'))
  beforeEach(() => { route = (c) => (c.url.endsWith('/media') ? { json: { id: 'mid_up' } } : { json: { messages: [{ id: 'wamid.TS1' }] } }) })

  it('validates counts and values before any upstream call', async () => {
    seedContact(); seedTemplate()
    expect(await J(await send({ template_id: 't1', body_params: ['Asha'] }))).toMatchObject({ field: 'body_params' })
    expect(await J(await send({ template_id: 't1', body_params: ['Asha', 'a\nb'] }))).toMatchObject({ field: 'body_params' })
    expect(await J(await send({ template_id: 't1', body_params: ['Asha', ' '] }))).toMatchObject({ field: 'body_params' })
    expect((await send({ template_id: 'nope', body_params: [] })).status).toBe(404)
    expect(calls).toEqual([])
  })
  it('refuses templates that are not approved', async () => {
    seedContact(); seedTemplate({ status: 'PENDING' })
    const r = await send({ template_id: 't1', body_params: ['a', 'b'] })
    expect(r.status).toBe(422); expect((await J(r)).error).toBe('template_not_approved')
  })
  it('window CLOSED: free text is 409 window_closed, the template goes through, row + live publish like any outbound', async () => {
    seedContact(1, now() - 3 * 86400); seedTemplate()
    const text = await call('POST', '/api/inbox/1/send', { text: 'hello' })
    expect(text.status).toBe(409); expect((await J(text)).error).toBe('window_closed')
    const r = await send({ template_id: 't1', body_params: ['Asha', 'A100'] })
    expect(r.status).toBe(200)
    const j = await J(r)
    expect(j).toMatchObject({ ok: true, wamid: 'wamid.TS1', message: { id: null, direction: 'out', type: 'template', body: 'Hi Asha, your order A100 shipped.', status: 'sent', media: null } })
    expect(sent()[0]!.body.template).toEqual({ name: 'order_update', language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Asha' }, { type: 'text', text: 'A100' }] }] })
    await Promise.allSettled(waiting)
    expect(q(`SELECT type, body, direction, wamid FROM messages WHERE contact_id=1`)).toEqual({ type: 'template', body: 'Hi Asha, your order A100 shipped.', direction: 'out', wamid: 'wamid.TS1' })
    expect(q(`SELECT last_preview p FROM conversations WHERE contact_id=1`).p).toBe('Hi Asha, your order A100 shipped.')
  })
  it('window OPEN also works; a text header takes header_params', async () => {
    seedContact(); seedTemplate({ fmt: 'TEXT', header: 'Order {{1}}', body: 'Thanks {{1}}.', bp: 1, hp: 1 })
    expect((await send({ template_id: 't1', body_params: ['Asha'] })).status).toBe(400) // header_params missing
    const r = await send({ template_id: 't1', body_params: ['Asha'], header_params: ['A100'] })
    expect(r.status).toBe(200)
    expect(sent()[0]!.body.template.components[0]).toEqual({ type: 'header', parameters: [{ type: 'text', text: 'A100' }] })
    expect((await J(r)).message.body).toBe('Order A100\nThanks Asha.')
  })
  it('image header, default sample: bytes from R2 are uploaded, sent by id, the media row shares the R2 key', async () => {
    seedContact(1, now() - 3 * 86400)
    await r2.bucket.put('t/sample', PNG)
    seedTemplate({ fmt: 'IMAGE', body: 'Sale {{1}}', bp: 1, hp: 0, key: 't/sample' })
    const r = await send({ template_id: 't1', body_params: ['today'] })
    expect(r.status).toBe(200)
    expect(calls.map((c) => c.url.split('/v1')[1])).toEqual(['/media', '/messages'])
    expect(sent()[0]!.body.template.components[0]).toEqual({ type: 'header', parameters: [{ type: 'image', image: { id: 'mid_up' } }] })
    expect((await J(r)).message.media).toMatchObject({ status: 'stored', mime: 'image/png' })
    await Promise.allSettled(waiting)
    expect(q(`SELECT d.r2_key k, d.status s, d.mime m, m.type t, m.media_id mid FROM media d JOIN messages m ON m.id = d.message_id`)).toEqual({ k: 't/sample', s: 'stored', m: 'image/png', t: 'template', mid: 'mid_up' })
  })
  it('image header, fresh upload: stored under a new key; a non-image file is refused; a missing header is a 400', async () => {
    seedContact(1, now() - 3 * 86400); seedTemplate({ fmt: 'IMAGE', body: 'Sale {{1}}', bp: 1, hp: 0 })
    expect(await J(await send({ template_id: 't1', body_params: ['x'] }))).toMatchObject({ field: 'header_media' })
    const bad = new FormData(); bad.set('template_id', 't1'); bad.set('body_params', JSON.stringify(['x'])); bad.set('file', new File(['x'], 'a.txt', { type: 'text/plain' }))
    expect((await send(bad)).status).toBe(415)
    const fd = new FormData(); fd.set('template_id', 't1'); fd.set('body_params', JSON.stringify(['x'])); fd.set('file', new File([PNG], 'a.png', { type: 'image/png' }))
    expect((await send(fd)).status).toBe(200)
    await Promise.allSettled(waiting)
    const k = q(`SELECT r2_key k FROM media`).k
    expect(k).toMatch(/^o\//); expect(r2.store.has(k)).toBe(true)
  })
  it('an upstream failure is a 502 with Meta\'s error and writes no row', async () => {
    seedContact(); seedTemplate({ bp: 0, body: 'Hello' })
    route = () => ({ status: 400, json: { source: 'meta', error: { message: 'Template paused', code: 132015 } } })
    const r = await send({ template_id: 't1', body_params: [] })
    expect(r.status).toBe(502); expect(await J(r)).toMatchObject({ source: 'meta', graph: { code: 132015 }, stage: 'send' })
    await Promise.allSettled(waiting)
    expect(q(`SELECT COUNT(*) n FROM messages`).n).toBe(0)
  })
})

describe('GET /api/templates/recent-media', () => {
  it('lists stored outbound files of the kind only', async () => {
    seedContact()
    raw.exec(`INSERT INTO messages (id,contact_id,direction,type,timestamp) VALUES (1,1,'out','image',1),(2,1,'in','image',2),(3,1,'out','document',3)`)
    raw.exec(`INSERT INTO media (message_id,r2_key,mime,filename,size,status) VALUES (1,'o/a','image/png','a.png',3,'stored'),(2,'m/2','image/png','b.png',3,'stored'),(3,'o/c','application/pdf','c.pdf',3,'stored')`)
    const j = await J(await call('GET', '/api/templates/recent-media?format=IMAGE'))
    expect(j.files.map((f: any) => f.message_id)).toEqual([1])
    expect((await call('GET', '/api/templates/recent-media?format=NOPE')).status).toBe(400)
  })
})

describe('templates review fixes', () => {
  const send = (b: unknown) => call('POST', '/api/inbox/1/send-template', b)
  beforeEach(() => { route = (c) => (c.url.endsWith('/media') ? { json: { id: 'mid_up' } } : { json: { messages: [{ id: 'wamid.RF1' }] } }) })

  it('send-template carries Server-Timing and logs a send_timing event', async () => {
    seedContact(); seedTemplate()
    const r = await send({ template_id: 't1', body_params: ['Asha', 'A100'] })
    expect(r.status).toBe(200)
    expect(r.headers.get('Server-Timing')).toMatch(/worker;dur=/)
    await Promise.all(waiting)
    const ev = rows<{ payload: string }>(`SELECT payload FROM events WHERE kind='send_timing'`).map((e) => JSON.parse(e.payload))
    expect(ev.at(-1)).toMatchObject({ route: '/api/inbox/1/send-template', status: 200 })
  })
  it('template header files: only jpeg/png, mp4, pdf (the inbox allowlist is wider)', async () => {
    const mk = (type: string, name: string, bytes: number[]) => { const fd = new FormData(); fd.set('payload', JSON.stringify({ name: 'hdr_one', language: 'en', category: 'UTILITY', body: 'Hello there friend', body_samples: [], header: { format: type === 'video/3gpp' || type === 'video/mp4' ? 'VIDEO' : 'DOCUMENT' } })); fd.set('sample', new File([new Uint8Array(bytes)], name, { type })); return fd }
    expect((await call('POST', '/api/templates', mk('video/3gpp', 'a.3gp', [0, 0, 0, 24]))).status).toBe(415)
    expect((await call('POST', '/api/templates', mk('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'a.docx', [1, 2, 3]))).status).toBe(415)
    expect(calls).toEqual([])
  })
  it.each([
    ['named variables', [{ type: 'BODY', text: 'Hi {{first_name}}' }], 'UTILITY'],
    ['button variables', [{ type: 'BODY', text: 'Hi' }, { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Track', url: 'https://e.com/{{1}}' }] }], 'UTILITY'],
    ['authentication', [{ type: 'BODY', text: 'Code {{1}}' }], 'AUTHENTICATION'],
    ['location header', [{ type: 'HEADER', format: 'LOCATION' }, { type: 'BODY', text: 'Hi' }], 'UTILITY'],
  ])('not sendable (%s): listed with sendable=false and a reason, and the send is refused 422', async (_n, comps, cat) => {
    seedContact()
    raw.prepare(`INSERT INTO templates (id,name,language,category,status,components,header_format,body_params_count,header_params_count,synced_at) VALUES ('ns','ns_one','en',?,'APPROVED',?,'NONE',0,0,?)`).run(cat, JSON.stringify(comps), now())
    const list = await J(await call('GET', '/api/templates'))
    expect(list.templates[0]).toMatchObject({ sendable: false, unsendable_reason: expect.stringMatching(/\S/) })
    const r = await send({ template_id: 'ns', body_params: [] })
    expect(r.status).toBe(422); expect((await J(r)).error).toBe('template_not_sendable')
    expect(calls).toEqual([])
  })
  it('a normal positional template stays sendable', async () => {
    seedTemplate(); expect((await J(await call('GET', '/api/templates'))).templates[0]).toMatchObject({ sendable: true, unsendable_reason: null })
  })
})

// ---- S9a: authentication create, buttons, quality, delete guard -----------------------------------
describe('S9a template management', () => {
  const wb = () => new WhaBuzzAdaptor(WB.config, fetch as any, 'https://api.whabuzz.com/v1')
  const ca = () => new CloudApiAdaptor({ system_token: 'tok', app_secret: 's', phone_number_id: '111', waba_id: '222', app_id: '333' }, fetch as any)
  const btn = [{ index: 0, sub_type: 'url' as const, text: '123456' }]
  const expectBtn = { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: '123456' }] }

  for (const [label, mk] of [['WhaBuzz', wb], ['Cloud API', ca]] as const) {
    it(`${label} sendTemplate serialises a button component after the body`, async () => {
      await mk().sendTemplate('1', 'login_code', 'en', ['123456'], undefined, btn)
      expect(calls[0]!.body.template.components).toEqual([{ type: 'body', parameters: [{ type: 'text', text: '123456' }] }, expectBtn])
    })
  }

  it('create route: AUTHENTICATION posts the Meta auth components and stores the row', async () => {
    route = () => ({ json: { id: 'tpl_a', status: 'PENDING', category: 'AUTHENTICATION' } })
    const r = await call('POST', '/api/templates', { name: 'login_code', language: 'en', category: 'AUTHENTICATION', auth: { security_note: true, expiry_minutes: 5 } })
    expect(r.status).toBe(200)
    expect(calls[0]!.body.components).toEqual([
      { type: 'BODY', add_security_recommendation: true },
      { type: 'FOOTER', code_expiration_minutes: 5 },
      { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE' }] },
    ])
    expect(q(`SELECT category, status FROM templates WHERE name='login_code'`)).toMatchObject({ category: 'AUTHENTICATION', status: 'PENDING' })
  })
  it('create route: bad expiry and ONE_TAP are 400 with field auth, and nothing goes upstream', async () => {
    const b = { name: 'login_code', language: 'en', category: 'AUTHENTICATION' }
    const r1 = await call('POST', '/api/templates', { ...b, auth: { expiry_minutes: 120 } })
    expect(r1.status).toBe(400); expect((await J(r1)).field).toBe('auth')
    expect((await call('POST', '/api/templates', { ...b, auth: { button_type: 'ONE_TAP' } })).status).toBe(400)
    expect(calls).toEqual([])
  })

  it('create route: AUTHENTICATION with a custom body is 400 on field body, never silently dropped', async () => {
    const r = await call('POST', '/api/templates', { name: 'login_code', language: 'en', category: 'AUTHENTICATION', body: 'Your code is {{1}}', auth: { security_note: true } })
    expect(r.status).toBe(400); expect((await J(r)).field).toBe('body')
    expect(calls).toEqual([])
  })

  it('an authentication template is never sendable from the inbox composer', async () => {
    seedContact()
    raw.prepare(`INSERT INTO templates (id,name,language,category,status,components,header_format,body_params_count,header_params_count,synced_at) VALUES ('ta','login_code','en','AUTHENTICATION','APPROVED',?,'NONE',1,0,?)`)
      .run(JSON.stringify([{ type: 'BODY', text: '{{1}} is your code' }, { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE' }] }]), now())
    const r = await call('POST', '/api/inbox/1/send-template', { template_id: 'ta', body_params: ['123456'] })
    expect(r.status).toBe(422); expect((await J(r)).error).toBe('template_not_sendable')
    expect(calls).toEqual([])
  })

  it('quality is read from the Graph object, the WhaBuzz meta_object, and a bare string; unknown values are null', () => {
    const base = { name: 'a', language: 'en', status: 'APPROVED', components: [] }
    expect(normalizeRemote({ ...base, quality_score: { score: 'GREEN', date: 1 } })!.quality).toBe('GREEN')
    expect(normalizeRemote({ ...base, meta_object: { quality_score: { score: 'red' } } })!.quality).toBe('RED')
    expect(normalizeRemote({ ...base, quality: 'YELLOW' })!.quality).toBe('YELLOW')
    expect(normalizeRemote({ ...base, quality_score: { score: 'WEIRD' } })!.quality).toBeNull()
    expect(normalizeRemote(base)!.quality).toBeNull()
  })
  it('quality shows up in the list JSON and survives a sync that does not carry it', async () => {
    seedTemplate({ id: 'tq', name: 'q_one' })
    raw.prepare(`UPDATE templates SET quality='GREEN' WHERE id='tq'`).run()
    expect((await J(await call('GET', '/api/templates'))).templates[0].quality).toBe('GREEN')
    route = () => ({ json: { data: [{ id: 'tq', name: 'q_one', language: 'en', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'x' }] }] } })
    await call('POST', '/api/templates/sync')
    expect(q(`SELECT quality FROM templates WHERE id='tq'`).quality).toBe('GREEN')
  })

  it('delete is refused (409) while a draft, queued, running or paused broadcast uses the template, and allowed after it finishes', async () => {
    seedTemplate({ id: 'tb', name: 'b_one' })
    const ins = (status: string) => raw.prepare(`INSERT INTO broadcasts (id,name,template_id,template_name,language,category,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).run('bc_' + status, 'Spring ' + status, 'tb', 'b_one', 'en', 'UTILITY', status, now(), now())
    for (const s of ['draft', 'queued', 'running', 'paused']) {
      ins(s)
      const r = await call('DELETE', '/api/templates/tb')
      expect(r.status).toBe(409)
      expect(await J(r)).toMatchObject({ error: 'template_in_use', broadcast_id: 'bc_' + s })
      raw.prepare(`DELETE FROM broadcasts`).run()
    }
    expect(calls).toEqual([])
    ins('finished')
    route = () => ({ json: { success: true } })
    expect((await call('DELETE', '/api/templates/tb')).status).toBe(200)
  })
})
