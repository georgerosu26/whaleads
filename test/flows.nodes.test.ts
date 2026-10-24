// the send-style nodes (message, template, ai, http_request) and their shadow behaviour, driven through startRun.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveConfig } from '../src/adaptors'
import { startRun } from '../src/flows/engine'
import { LIMITS } from '../src/flows/types'
import { setAnthropicKey } from '../src/settings'
import { acts, addFlow, edge, graph, lead, node, rig, runRow, traceOf, trigger, type Rig } from './flows.helpers'

const WB = { kind: 'whabuzz' as const, config: { api_key: 'k', phone_number_id: '1000000000000001', waba_id: '2', webhook_secret: 'whsec_TEST_x' } }
const now = () => Math.floor(Date.now() / 1000)
let r: Rig
let calls: { url: string; init: any; body: any }[]
let seq: number
let route: (url: string, init: any) => Response | Promise<Response> | undefined

const ev = (key: number | string = 1) => ({ kind: 'lead_created', key })
const go = async (g: ReturnType<typeof graph>, o: { shadow?: 0 | 1; key?: number } = {}) => {
  const res = (await startRun(r.env, addFlow(r.raw, g, { shadow: o.shadow }), lead, ev(o.key ?? 1))) as any
  return { res, run: runRow(r.raw, res.runId) }
}
const gatewayCalls = () => calls.filter((c) => !/anthropic|example\.com/.test(c.url))
const msgs = () => r.raw.prepare(`SELECT direction,body,origin,type FROM messages ORDER BY id`).all() as any[]
const openWindow = (open = true) => r.raw.exec(`INSERT OR REPLACE INTO conversations (contact_id,last_message_at,last_inbound_at,last_preview,unread_count) VALUES (1,${now() - 60},${open ? now() - 60 : now() - 90000},'hi',0)`)
function seedTemplate(o: { id?: string; status?: string; bp?: number; fmt?: string; key?: string | null } = {}) {
  const fmt = o.fmt ?? 'NONE'
  const comps: any[] = fmt === 'NONE' ? [] : [{ type: 'HEADER', format: fmt }]
  comps.push({ type: 'BODY', text: 'Hi {{1}}, your order {{2}} shipped.' })
  r.raw.prepare(`INSERT INTO templates (id,name,language,status,components,header_format,header_media_r2_key,header_media_mime,body_params_count,header_params_count,synced_at) VALUES (?,?,?,?,?,?,?,?,?,0,?)`)
    .run(o.id ?? 't1', 'order_update', 'en', o.status ?? 'APPROVED', JSON.stringify(comps), fmt, o.key ?? null, o.key ? 'image/png' : null, o.bp ?? 2, now())
}

beforeEach(async () => {
  r = await rig()
  await saveConfig(r.env, WB)
  openWindow()
  calls = []; seq = 0; route = () => undefined
  vi.stubGlobal('fetch', async (url: string, init: any) => {
    let body: any = null
    try { body = init?.body ? JSON.parse(init.body) : null } catch { body = init?.body }
    calls.push({ url: String(url), init, body })
    return (await route(String(url), init)) ?? new Response(JSON.stringify({ messages: [{ id: `wamid.F${++seq}` }] }), { status: 200 })
  })
})
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('message node', () => {
  const g = (extra: ReturnType<typeof edge>[] = [], more: ReturnType<typeof node>[] = []) =>
    graph([trigger(), node('m', 'message', { text: 'Hello {{lead.name}}' }), ...more], [edge('t', 'out', 'm'), ...extra])

  it('inside the window it sends through the one send path: row, origin, no first_response', async () => {
    const { res, run } = await go(g())
    expect(res.status).toBe('completed')
    expect(gatewayCalls()).toHaveLength(1)
    expect(msgs()).toEqual([{ direction: 'out', body: 'Hello Asha Rao', origin: 'flow:1', type: 'text' }])
    expect(r.raw.prepare(`SELECT first_response_at FROM leads WHERE id=1`).get()).toEqual({ first_response_at: null })
    expect(JSON.parse(run.context).nodes.m.output).toMatchObject({ ok: true, wamid: 'wamid.F1' })
  })

  it('outside the window with no window_closed port the run fails with a readable error and sends nothing', async () => {
    openWindow(false)
    const { res, run } = await go(g())
    expect(res.status).toBe('failed')
    expect(run.error).toMatch(/window_closed.*24-hour/)
    expect(gatewayCalls()).toHaveLength(0)
    expect(msgs()).toEqual([])
  })

  it('outside the window the window_closed port takes the run to a template', async () => {
    openWindow(false); seedTemplate()
    const { res } = await go(g([edge('m', 'window_closed', 'tp')], [node('tp', 'template', { templateId: 't1', bodyParams: ['{{lead.name}}', 'A1'] })]))
    expect(res.status).toBe('completed')
    expect(msgs()).toMatchObject([{ type: 'template', origin: 'flow:1' }])
  })
})

describe('template node', () => {
  const g = (data: Record<string, unknown>, ports: ReturnType<typeof edge>[] = [], more: ReturnType<typeof node>[] = []) =>
    graph([trigger(), node('tp', 'template', data), ...more], [edge('t', 'out', 'tp'), ...ports])

  it('maps variables and lead fields to body params and sends any time (window closed)', async () => {
    openWindow(false); seedTemplate()
    const { res, run } = await go(graph(
      [trigger(), node('v', 'variable', { variableName: 'order', value: 'A100' }), node('tp', 'template', { templateId: 't1', bodyParams: ['{{lead.name}}', '{{order}}'] })],
      [edge('t', 'out', 'v'), edge('v', 'out', 'tp')],
    ))
    expect(res.status).toBe('completed')
    const out = JSON.parse(run.context).nodes.tp.output
    expect(out.text).toBe('Hi Asha Rao, your order A100 shipped.')
    const sent = gatewayCalls()[0]!.body
    expect(JSON.stringify(sent)).toContain('order_update')
    expect(JSON.stringify(sent)).toContain('Asha Rao')
    expect(JSON.stringify(sent)).toContain('A100')
    expect(msgs()).toMatchObject([{ type: 'template', origin: 'flow:1' }])
  })

  it.each([['PENDING'], ['REJECTED'], ['PAUSED']])('a %s template is never sent', async (status) => {
    seedTemplate({ status })
    const { res, run } = await go(g({ templateId: 't1', bodyParams: ['a', 'b'] }))
    expect(res.status).toBe('failed')
    expect(run.error).toMatch(/template/i)
    expect(gatewayCalls()).toHaveLength(0)
  })

  it('a wrong parameter count fails readably (or routes to the error port)', async () => {
    seedTemplate()
    const a = await go(g({ templateId: 't1', bodyParams: ['only one'] }))
    expect(a.res.status).toBe('failed'); expect(a.run.error).toMatch(/needs 2 body values, the node has 1/)
    expect(gatewayCalls()).toHaveLength(0)
  })

  it('an unknown template fails readably', async () => {
    const { res, run } = await go(g({ templateId: 'nope', bodyParams: [] }))
    expect(res.status).toBe('failed'); expect(run.error).toMatch(/template/i)
  })
})

describe('ai node', () => {
  const g = (data: Record<string, unknown> = {}, ports: ReturnType<typeof edge>[] = [], more: ReturnType<typeof node>[] = []) =>
    graph([trigger(), node('a', 'ai', { systemPrompt: 'You write one line for {{lead.name}}.', prompt: 'Greet {{lead.name}}', outputVariable: 'greeting', ...data }), ...more], [edge('t', 'out', 'a'), ...ports])
  const reply = (over: any = {}) => new Response(JSON.stringify({ model: 'claude-haiku-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Welcome, Asha!' }], usage: { input_tokens: 12, output_tokens: 5 }, ...over }), { status: 200 })

  it('posts the Messages API shape with the stored key and puts the answer in the variable', async () => {
    await setAnthropicKey(r.env, 'sk-ant-secret-key-1234', null)
    route = (u) => (u.includes('anthropic') ? reply() : undefined)
    const { res, run } = await go(g())
    expect(res.status).toBe('completed')
    const c = calls.find((x) => x.url.includes('anthropic'))!
    expect(c.url).toBe('https://api.anthropic.com/v1/messages')
    expect(c.init.method).toBe('POST')
    expect(c.init.headers).toMatchObject({ 'x-api-key': 'sk-ant-secret-key-1234', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' })
    expect(c.body).toEqual({
      model: 'claude-haiku-5-5', max_tokens: LIMITS.AI_MAX_TOKENS, system: 'You write one line for Asha Rao.',
      messages: [{ role: 'user', content: 'Greet Asha Rao' }], thinking: { type: 'disabled' }, output_config: { effort: 'low' },
    })
    expect(JSON.parse(run.context).vars.greeting).toBe('Welcome, Asha!')
    // the key is nowhere in what the run persisted
    expect(JSON.stringify(run)).not.toContain('sk-ant-secret-key-1234')
  })

  it('model comes from the ai_model setting; other models get no Haiku-only fields; max_tokens is capped', async () => {
    await setAnthropicKey(r.env, 'sk-ant-secret-key-1234', null)
    r.raw.prepare(`INSERT INTO settings (key,value) VALUES ('ai_model', ?)`).run(JSON.stringify('claude-sonnet-5-5'))
    route = (u) => (u.includes('anthropic') ? reply() : undefined)
    await go(g({ maxTokens: 999999 }))
    const b = calls.find((x) => x.url.includes('anthropic'))!.body
    expect(b.model).toBe('claude-sonnet-5-5')
    expect(b.max_tokens).toBe(LIMITS.AI_MAX_TOKENS_CEILING)
    expect(b.thinking).toBeUndefined(); expect(b.output_config).toBeUndefined()
  })

  it('no key: fails with ai_not_configured and calls nothing; with an error port it routes there', async () => {
    const a = await go(g())
    expect(a.res.status).toBe('failed'); expect(a.run.error).toMatch(/ai_not_configured/)
    expect(calls).toHaveLength(0)
    r = await rig(); await saveConfig(r.env, WB); openWindow(); calls = []
    const b = await go(g({}, [edge('a', 'error', 'm')], [node('m', 'message', { text: 'fallback' })]))
    expect(b.res.status).toBe('completed')
    expect(msgs()).toMatchObject([{ body: 'fallback' }])
  })

  it('times out at 8 s (aborts the request) and reports ai_timeout', async () => {
    await setAnthropicKey(r.env, 'sk-ant-secret-key-1234', null)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let aborted = false
    route = (u, init) => (u.includes('anthropic') ? new Promise<Response>((_, rej) => init.signal.addEventListener('abort', () => { aborted = true; rej(Object.assign(new Error('aborted'), { name: 'AbortError' })) })) : undefined)
    let reached!: () => void
    const at = new Promise<void>((ok) => { reached = ok })
    const inner = route
    route = (u, init) => { if (u.includes('anthropic')) reached(); return inner(u, init) }
    const p = go(g())
    await at // the request is in flight, so the 8 s timer is armed
    await vi.advanceTimersByTimeAsync(LIMITS.AI_TIMEOUT_MS - 1)
    expect(aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    const { res, run } = await p
    expect(aborted).toBe(true)
    expect(LIMITS.AI_TIMEOUT_MS).toBe(8000)
    expect(res.status).toBe('failed'); expect(run.error).toMatch(/ai_timeout/)
  })

  it.each([[401, 'ai_auth_failed'], [429, 'ai_rate_limited'], [500, 'ai_error']])('HTTP %i maps to %s', async (status, code) => {
    await setAnthropicKey(r.env, 'sk-ant-secret-key-1234', null)
    route = (u) => (u.includes('anthropic') ? new Response(JSON.stringify({ error: { message: 'nope' } }), { status }) : undefined)
    const { res, run } = await go(g())
    expect(res.status).toBe('failed'); expect(run.error).toContain(code)
    expect(JSON.stringify(run)).not.toContain('sk-ant-secret-key-1234')
  })

  it('counts as exactly one subrequest in the step meter', async () => {
    await setAnthropicKey(r.env, 'sk-ant-secret-key-1234', null)
    route = (u) => (u.includes('anthropic') ? reply() : undefined)
    // 31 ai nodes in a row: the step parks after STEP_SUBREQUESTS (30) fetches and resumes on the next tick.
    const n = LIMITS.STEP_SUBREQUESTS + 1
    const nodes = Array.from({ length: n }, (_, i) => node(`a${i}`, 'ai', { prompt: 'x' }))
    const g31 = graph([trigger(), ...nodes], [edge('t', 'out', 'a0'), ...nodes.slice(1).map((x, i) => edge(`a${i}`, 'out', x.id))])
    const { res, run } = await go(g31)
    expect(res.status).toBe('awaiting')
    expect(calls.filter((c) => c.url.includes('anthropic'))).toHaveLength(LIMITS.STEP_SUBREQUESTS)
    expect(traceOf(r.raw, run.id).at(-1)?.note).toMatch(/30 fetches/)
  })
})

describe('http_request node', () => {
  const g = (data: Record<string, unknown>) => graph([trigger(), node('h', 'http_request', data)], [edge('t', 'out', 'h')])

  it('goes through the guard with templating and puts the JSON response in the variable', async () => {
    route = (u) => (u.includes('example.com') ? new Response(JSON.stringify({ plan: 'gold', n: 3 }), { status: 200 }) : undefined)
    const { res, run } = await go(g({ method: 'POST', url: 'https://api.example.com/lookup?name={{lead.name}}', body: '{"id":{{lead.id}}}', outputVariable: 'info', headers: [{ name: 'X-Trace', value: 'f' }] }))
    expect(res.status).toBe('completed')
    const c = calls[0]!
    expect(c.url).toContain('https://api.example.com/lookup?name=Asha%20Rao')
    expect(c.body).toEqual({ id: 1 })
    expect(JSON.parse(run.context).vars.info).toEqual({ plan: 'gold', n: 3 })
  })

  it('Authorization goes out only when the node sets it explicitly', async () => {
    route = (u) => (u.includes('example.com') ? new Response('{}', { status: 200 }) : undefined)
    await go(g({ url: 'https://api.example.com/a', headers: [{ name: 'Authorization', value: 'Bearer tok' }] }))
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe('Bearer tok')
    r = await rig(); calls = []
    await go(g({ url: 'https://api.example.com/a', headers: [{ name: 'X-Other', value: '1' }] }))
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBeNull()
  })

  it('a private address is refused by the guard and routes error without fetching', async () => {
    const { res, run } = await go(g({ url: 'http://169.254.169.254/latest/meta-data' }))
    expect(res.status).toBe('failed'); expect(run.error).toMatch(/http_failed/)
    expect(calls).toHaveLength(0)
  })

  it('a non-2xx answer takes the error port', async () => {
    route = (u) => (u.includes('example.com') ? new Response('{"e":1}', { status: 500 }) : undefined)
    const { res } = await go(graph([trigger(), node('h', 'http_request', { url: 'https://api.example.com/x' }), node('n', 'action', { actionType: 'note', text: 'handled' })], [edge('t', 'out', 'h'), edge('h', 'error', 'n')]))
    expect(res.status).toBe('completed')
    expect(acts(r.raw).some((a) => a.kind === 'note')).toBe(true)
  })
})

describe('shadow mode', () => {
  it('message / template / ai / http are skipped with a trace entry and nothing leaves the building', async () => {
    seedTemplate(); await setAnthropicKey(r.env, 'sk-ant-secret-key-1234', null)
    const g = graph(
      [trigger(), node('m', 'message', { text: 'hi' }), node('tp', 'template', { templateId: 't1', bodyParams: ['a', 'b'] }), node('a', 'ai', { prompt: 'x', outputVariable: 'o' }), node('h', 'http_request', { url: 'https://api.example.com/x' })],
      [edge('t', 'out', 'm'), edge('m', 'out', 'tp'), edge('tp', 'out', 'a'), edge('a', 'out', 'h')],
    )
    const { res, run } = await go(g, { shadow: 1 })
    expect(res.status).toBe('completed')
    expect(calls).toHaveLength(0)
    expect(msgs()).toEqual([])
    const tr = traceOf(r.raw, run.id)
    for (const id of ['m', 'tp', 'a', 'h']) expect(tr.find((t) => t.node === id)).toMatchObject({ status: 'skipped' })
    expect(acts(r.raw).filter((a) => a.kind === 'flow_run').map((a) => JSON.parse(a.data!).shadow)).toEqual([true, true])
  })
})
