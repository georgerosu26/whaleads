// trigger hooks. Events enter through the real paths (inbound pipeline, lead intake route, staff PATCH).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'
import { CloudApiAdaptor } from '../src/adaptors/cloud-api'
import { processEvents } from '../src/inbound'
import { startRun } from '../src/flows/engine'
import { dispatchMessageReceived, messageMatches, onInboundMessage } from '../src/flows/triggers'
import { validateGraph } from '../src/flows/graph'
import { compileSafeRegex } from '../src/flows/regex'
import { LIMITS } from '../src/flows/types'
import { acts, addFlow, edge, graph, lead, node, rig, trigger, type Rig } from './flows.helpers'
import { fixture } from './helpers'

const cloud = new CloudApiAdaptor({ system_token: 't', app_secret: 'appsecret', phone_number_id: '1', waba_id: '2' })
let r: Rig
let waiting: Promise<unknown>[]
let sent: any[][]
const ctx = { waitUntil: (p: Promise<unknown>) => { waiting.push(p) }, passThroughOnException: () => {} } as unknown as ExecutionContext
const settle = async () => { while (waiting.length) { const w = waiting; waiting = []; await Promise.allSettled(w) } }
const hook = (wamid: string, from = '15550000001', body = 'hello there') => {
  const f = fixture('text')
  const v = f.entry[0].changes[0].value
  v.messages[0] = { ...v.messages[0], from, id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), text: { body } }
  v.contacts[0] = { ...v.contacts[0], wa_id: from, profile: { name: 'Test Person' } }
  return f
}
const feed = async (h: unknown) => { const res = await processEvents(r.env, ctx, cloud.parseWebhook(JSON.stringify(h))); await settle(); return res }
const runs = (flow?: number) => r.raw.prepare(`SELECT id,flow_id,lead_id,status,trigger,idem_key,shadow FROM flow_runs ${flow ? `WHERE flow_id=${flow}` : ''} ORDER BY id`).all() as any[]
const note = (text = 'ran') => node('n', 'action', { actionType: 'note', text })
const flowOf = (id: number, trig: Record<string, unknown>, o: { shadow?: 0 | 1; extra?: ReturnType<typeof node>[]; edges?: ReturnType<typeof edge>[] } = {}) =>
  addFlow(r.raw, graph([node('t', 'trigger', trig), ...(o.extra ?? [note()])], o.edges ?? [edge('t', 'out', 'n')]), { id, reentry: 'each_event', shadow: o.shadow })
const staff = (path: string, body: unknown) =>
  worker.fetch(new Request(`https://x.example${path}`, { method: 'PATCH', headers: { Authorization: 'Bearer k', 'content-type': 'application/json', Origin: 'https://x.example' }, body: JSON.stringify(body) }), r.env, ctx)

beforeEach(async () => {
  r = await rig(); waiting = []; sent = []
  r.env.LIVE = { idFromName: (n: string) => n, get: () => ({ broadcast: async (f: string[]) => { sent.push(f.map((x) => JSON.parse(x))); return 1 } }) } as any
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 200 }))
})
afterEach(() => vi.unstubAllGlobals())

describe('lead.created', () => {
  it('a new lead from the inbound path starts the flow once; a redelivered wamid starts nothing', async () => {
    flowOf(1, { kind: 'lead_created' })
    await feed(hook('wamid.N1', '15550000077'))
    expect(runs()).toHaveLength(1)
    expect(runs()[0]).toMatchObject({ flow_id: 1, status: 'completed', trigger: 'lead_created' })
    await feed(hook('wamid.N1', '15550000077')) // duplicate delivery
    expect(runs()).toHaveLength(1)
  })
  it('filters on source and stage', async () => {
    flowOf(1, { kind: 'lead_created', sources: ['pilot_form'] })
    flowOf(2, { kind: 'lead_created', sources: ['whatsapp'], stages: ['new'] })
    flowOf(3, { kind: 'lead_created', stages: ['won'] })
    await feed(hook('wamid.N2', '15550000078'))
    expect(runs().map((x) => x.flow_id)).toEqual([2])
  })
  it('the intake form route fires it, keyed on the lead id', async () => {
    flowOf(1, { kind: 'lead_created', sources: ['pilot_form'] })
    const req = () => new Request('https://x.example/api/leads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'pilot_form', phone: '+15551230000', name: 'Ravi' }) })
    const res = await worker.fetch(req(), r.env, ctx); await settle()
    expect(res.status).toBe(200)
    expect(runs()).toHaveLength(1)
    expect(runs()[0].idem_key).toBe(`1:${runs()[0].lead_id}:lead_created:${runs()[0].lead_id}`)
  })
  it('paused and draft flows never run; shadow flows run in shadow', async () => {
    addFlow(r.raw, graph([trigger('lead_created'), note()], [edge('t', 'out', 'n')]), { id: 1, status: 'paused' })
    flowOf(2, { kind: 'lead_created' }, { shadow: 1 })
    await feed(hook('wamid.N3', '15550000079'))
    expect(runs().map((x) => [x.flow_id, x.shadow])).toEqual([[2, 1]])
  })
})

describe('message.received', () => {
  it('any / keyword / regex, each flow starts once per wamid', async () => {
    flowOf(1, { kind: 'message_received', match: 'any' })
    flowOf(2, { kind: 'message_received', match: 'keyword', keywords: ['PRICE', 'cost'] })
    flowOf(3, { kind: 'message_received', match: 'regex', regexPattern: '^order\\s+#\\d+' })
    flowOf(4, { kind: 'message_received', match: 'keyword', keywords: ['refund'] })
    await feed(hook('wamid.M1', '15550000001', 'what is the Price?'))
    expect(runs().map((x) => x.flow_id)).toEqual([1, 2])
    await feed(hook('wamid.M2', '15550000001', 'Order #123 please'))
    expect(runs().filter((x) => x.trigger === 'message_received' && x.idem_key!.endsWith('wamid.M2')).map((x) => x.flow_id)).toEqual([1, 3])
    // same wamid dispatched again directly: nothing new
    const before = runs().length
    await dispatchMessageReceived(r.env, { id: 1, contact_id: 1, source: 'whatsapp', status: 'new' }, 'wamid.M2', 'Order #123 please')
    expect(runs()).toHaveLength(before)
  })
  it('regex guard: catastrophic shapes never match and are refused at publish; long patterns and long texts are capped', () => {
    expect(messageMatches({ match: 'regex', regexPattern: '(a+)+$' }, 'a'.repeat(5000) + '!')).toBe(false)
    expect(messageMatches({ match: 'regex', regexPattern: 'x'.repeat(LIMITS.MAX_REGEX + 1) }, 'x')).toBe(false)
    expect(messageMatches({ match: 'regex', regexPattern: '(' }, 'x')).toBe(false)
    expect(messageMatches({ match: 'regex', regexPattern: '(a)\\1' }, 'aa')).toBe(false)
    expect(messageMatches({ match: 'keyword', keywords: ['late'] }, 'x'.repeat(LIMITS.MAX_MATCH_TEXT) + 'late')).toBe(false) // beyond the clip
    expect(messageMatches({ match: 'keyword', keywords: [] }, 'anything')).toBe(false)
    const bad = (t: Record<string, unknown>) => validateGraph(graph([node('t', 'trigger', { kind: 'message_received', ...t }), note()], [edge('t', 'out', 'n')])).map((e) => e.msg).join()
    expect(bad({ match: 'regex', regexPattern: '(a+)+$' })).toMatch(/regex/)
    expect(bad({ match: 'regex', regexPattern: 'x'.repeat(LIMITS.MAX_REGEX + 1) })).toMatch(/regex/)
    expect(bad({ match: 'keyword', keywords: [] })).toMatch(/keyword/)
    expect(bad({ match: 'regex', regexPattern: '^hi\\b' })).toBe('')
  })
  it('regex guard: polynomial and nested-repeat shapes are refused and cheap to reject', () => {
    const bad = ['\\w*\\w*\\w*\\w*!', '(a+)+$', '(.*a){20}', '.*a.*b.*c!']
    const text = 'a'.repeat(200)
    const t0 = Date.now()
    for (const pattern of bad) {
      expect(messageMatches({ match: 'regex', regexPattern: pattern }, text + '!')).toBe(false)
      expect(validateGraph(graph([node('t', 'trigger', { kind: 'message_received', match: 'regex', regexPattern: pattern }), note()], [edge('t', 'out', 'n')])).length).toBeGreaterThan(0)
    }
    expect(Date.now() - t0).toBeLessThan(200)
    for (const pattern of ['^order\\s+#\\d+', '[a-z]+@[a-z]+\\.com', '(\\d{3})-(\\d{4})']) expect(compileSafeRegex(pattern).ok).toBe(true)
  })
  it('only an open lead receives message.received; a contact with only a lost lead starts nothing', async () => {
    flowOf(1, { kind: 'message_received', match: 'any' })
    r.raw.exec(`UPDATE leads SET status='lost' WHERE id=1`)
    await onInboundMessage(r.env, undefined, { contactId: 1, wamid: 'wamid.LOST1', text: 'hello' })
    expect(runs()).toHaveLength(0)
    r.raw.exec(`UPDATE leads SET status='contacted' WHERE id=1`)
    await onInboundMessage(r.env, undefined, { contactId: 1, wamid: 'wamid.LOST2', text: 'hello' })
    expect(runs()).toHaveLength(1)
  })
  it('reply-loop cap: one flow starts at most 10 runs per contact per hour, then refuses once with an activity row', async () => {
    flowOf(1, { kind: 'message_received', match: 'any' })
    for (let i = 1; i <= 13; i++) await onInboundMessage(r.env, undefined, { contactId: 1, wamid: `wamid.LOOP${i}`, text: 'ok' })
    expect(runs(1)).toHaveLength(LIMITS.MESSAGE_RUNS_PER_HOUR)
    const capped = acts(r.raw).filter((a) => a.kind === 'flow_run' && a.data!.includes('rate_capped'))
    expect(capped).toHaveLength(1)
    expect(JSON.parse(capped[0]!.data!)).toMatchObject({ reason: 'rate_capped', status: 'rate_capped', flow: 'flow-1' })
    await onInboundMessage(r.env, undefined, { contactId: 1, wamid: 'wamid.LOOP3', text: 'ok' }) // a redelivery stays a quiet duplicate
    expect(runs(1)).toHaveLength(LIMITS.MESSAGE_RUNS_PER_HOUR)
    // an hour later the window has rolled
    r.raw.exec(`UPDATE flow_runs SET started_at = started_at - 3700`)
    await onInboundMessage(r.env, undefined, { contactId: 1, wamid: 'wamid.LOOP99', text: 'ok' })
    expect(runs(1)).toHaveLength(LIMITS.MESSAGE_RUNS_PER_HOUR + 1)
  })
  it('a run waiting for a reply takes the message; no message.received flow starts for it', async () => {
    const wait = addFlow(r.raw, graph([trigger('lead_created'), node('w', 'wait_event', { timeout: 1, timeoutUnit: 'hours' }), node('n', 'action', { actionType: 'note', text: 'got it' })], [edge('t', 'out', 'w'), edge('w', 'completed', 'n')]), { id: 1 })
    flowOf(2, { kind: 'message_received', match: 'any' })
    const st = (await startRun(r.env, wait, lead, { kind: 'lead_created', key: 1 })) as any
    expect(st.status).toBe('awaiting')
    await feed(hook('wamid.R1'))
    expect(runs(1)[0].status).toBe('completed')
    expect(acts(r.raw).some((a) => a.kind === 'note' && a.data!.includes('got it'))).toBe(true)
    expect(runs(2)).toHaveLength(0)
    await feed(hook('wamid.R2')) // nothing is waiting now, so this one is a normal message
    expect(runs(2)).toHaveLength(1)
  })
})

describe('stage.changed', () => {
  it('a staff stage edit fires it with from/to filters, keyed on the activity id', async () => {
    flowOf(1, { kind: 'stage_changed', from: ['new'], to: ['contacted'] })
    flowOf(2, { kind: 'stage_changed', to: ['won'] })
    const res = await staff('/api/leads/1', { status: 'contacted' }); await settle()
    expect(res.status).toBe(200)
    expect(runs().map((x) => x.flow_id)).toEqual([1])
    const actId = (r.raw.prepare(`SELECT id FROM activity WHERE kind='stage_changed'`).get() as any).id
    expect(runs()[0].idem_key).toBe(`1:1:stage_changed:${actId}`)
    await staff('/api/leads/1', { status: 'contacted' }); await settle() // no change, no event
    expect(runs()).toHaveLength(1)
  })
  it('two back-to-back staff stage edits start two runs, one per activity row', async () => {
    flowOf(1, { kind: 'stage_changed' })
    const a = staff('/api/leads/1', { status: 'contacted' })
    const b = a.then(() => staff('/api/leads/1', { status: 'qualified' }))
    await b; await settle()
    expect(runs()).toHaveLength(2)
    const ids = (r.raw.prepare(`SELECT id FROM activity WHERE kind='stage_changed' ORDER BY id`).all() as any[]).map((x) => x.id)
    expect(runs().map((x) => x.idem_key)).toEqual(ids.map((i) => `1:1:stage_changed:${i}`))
  })
  const mover = (id: number, to: string, trig: Record<string, unknown>) =>
    flowOf(id, { kind: 'stage_changed', ...trig }, { extra: [node('n', 'action', { actionType: 'set_stage', stage: to })] })

  it('loop guard: a flow that moves the stage does not re-trigger itself', async () => {
    mover(1, 'qualified', {})
    await staff('/api/leads/1', { status: 'contacted' }); await settle()
    expect(runs(1)).toHaveLength(1)
    expect(r.raw.prepare(`SELECT status FROM leads WHERE id=1`).get()).toEqual({ status: 'qualified' })
    expect(acts(r.raw).filter((a) => a.kind === 'stage_changed').map((a) => a.actor)).toEqual(['staff:' + 0, 'flow:1'].map((x, i) => (i ? x : acts(r.raw).find((a) => a.kind === 'stage_changed')!.actor)))
  })
  it('depth cap: two flows moving each other stop after MAX_TRIGGER_DEPTH starts', async () => {
    mover(1, 'qualified', { to: ['contacted'] })
    mover(2, 'contacted', { to: ['qualified'] })
    await staff('/api/leads/1', { status: 'contacted' }); await settle()
    // staff -> A(depth 1) -> B(2) -> A(3) -> B would be depth 4: refused
    expect(runs().map((x) => x.flow_id)).toEqual([1, 2, 1])
    expect(runs()).toHaveLength(LIMITS.MAX_TRIGGER_DEPTH)
    expect(runs().every((x) => x.status === 'completed')).toBe(true)
  })
})

describe('live and timeline', () => {
  it('publishes flow.run started/completed frames and writes flow_run activity rows with the flow actor', async () => {
    flowOf(1, { kind: 'lead_created' })
    await feed(hook('wamid.L1', '15550000090'))
    const frames = sent.flat().filter((f) => f.type === 'flow.run')
    expect(frames.map((f) => f.data.status)).toEqual(['started', 'completed'])
    expect(frames[0].data).toMatchObject({ flow_id: 1, flow: 'flow-1', shadow: false })
    const leadId = runs()[0].lead_id
    const rows = acts(r.raw, leadId).filter((a) => a.kind === 'flow_run')
    expect(rows.map((a) => a.actor)).toEqual(['flow:1', 'flow:1'])
    expect(rows.map((a) => JSON.parse(a.data!))).toMatchObject([{ flow: 'flow-1', status: 'started', shadow: false }, { flow: 'flow-1', status: 'completed', shadow: false }])
  })
  it('a failing hook never breaks the webhook', async () => {
    r.raw.exec(`UPDATE flows SET graph='x'`)
    flowOf(1, { kind: 'lead_created' })
    r.raw.exec(`UPDATE flows SET published_graph='{bad'`)
    const res = await feed(hook('wamid.L2', '15550000091'))
    expect(res.messages).toBe(1)
    expect(runs()).toHaveLength(0)
  })
})
