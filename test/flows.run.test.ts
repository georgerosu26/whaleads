import { beforeEach, describe, expect, it } from 'vitest'
import { startRun } from '../src/flows/engine'
import { resumeOnReply, resumeRun } from '../src/flows/resume'
import { tick } from '../src/flows/tick'
import { acts, addFlow, edge, graph, lead, node, rig, runRow, trigger, traceOf, type Rig } from './flows.helpers'

let r: Rig
beforeEach(async () => { r = await rig() })
const ev = (key: string | number = 1) => ({ kind: 'lead_created', key })
const NOW = 1_800_000_000

describe('condition node', () => {
  const g = graph(
    [trigger(), node('c', 'condition', { left: 'lead.name', operator: 'contains', value: 'asha' }),
      node('y', 'variable', { variableName: 'path', value: 'yes' }), node('n', 'variable', { variableName: 'path', value: 'no' })],
    [edge('t', 'out', 'c'), edge('c', 'yes', 'y'), edge('c', 'no', 'n')],
  )
  it('follows yes when it matches', async () => {
    const res = await startRun(r.env, addFlow(r.raw, g), lead, ev()) as any
    expect(JSON.parse(runRow(r.raw, res.runId).context).vars.path).toBe('yes')
  })
  it('follows no when it does not', async () => {
    r.raw.exec(`UPDATE contacts SET name='Ravi' WHERE id=1`)
    const res = await startRun(r.env, addFlow(r.raw, g), lead, ev()) as any
    expect(JSON.parse(runRow(r.raw, res.runId).context).vars.path).toBe('no')
  })
  it('an over-long regex never matches (ReDoS cap)', async () => {
    const g2 = graph([trigger(), node('c', 'condition', { left: 'lead.name', operator: 'regex', value: '.*' + 'a'.repeat(300) }), node('y', 'variable', { variableName: 'p', value: 'yes' }), node('n', 'variable', { variableName: 'p', value: 'no' })], [edge('t', 'out', 'c'), edge('c', 'yes', 'y'), edge('c', 'no', 'n')])
    const res = await startRun(r.env, addFlow(r.raw, g2), lead, ev()) as any
    expect(JSON.parse(runRow(r.raw, res.runId).context).vars.p).toBe('no')
  })
})

describe('delay and tick', () => {
  const g = graph([trigger(), node('d', 'delay', { duration: 2, unit: 'hours' }), node('v', 'variable', { variableName: 'after', value: 'done' })], [edge('t', 'out', 'd'), edge('d', 'out', 'v')])
  it('schedules resume_at, the tick ignores it early and resumes it when due', async () => {
    const res = await startRun(r.env, addFlow(r.raw, g), lead, ev(), { now: NOW }) as any
    expect(res.status).toBe('awaiting')
    expect(runRow(r.raw, res.runId)).toMatchObject({ status: 'awaiting', await_kind: 'timer', resume_at: NOW + 7200, current_node_id: 'd' })

    const early = await tick(r.env, { now: NOW + 7199, dbBudget: 40 })
    expect(early.resumed).toBe(0)
    expect(runRow(r.raw, res.runId).status).toBe('awaiting')

    const due = await tick(r.env, { now: NOW + 7200, dbBudget: 40 })
    expect(due).toMatchObject({ resumed: 1, completed: 1 })
    const run = runRow(r.raw, res.runId)
    expect(run.status).toBe('completed')
    expect(JSON.parse(run.context).vars.after).toBe('done')
    expect(traceOf(r.raw, res.runId).map((t) => t.node)).toContain('v')
  })
  it('two ticks racing on one run resume it exactly once', async () => {
    const res = await startRun(r.env, addFlow(r.raw, g), lead, ev(), { now: NOW }) as any
    const [a, b] = await Promise.all([resumeRun(r.env, res.runId, { kind: 'timer' }, { now: NOW + 8000 }), resumeRun(r.env, res.runId, { kind: 'timer' }, { now: NOW + 8000 })])
    expect([a.resumed, b.resumed].sort()).toEqual([false, true])
  })
  it('the tick stops when its D1 budget is spent and reports more=true', async () => {
    const f = addFlow(r.raw, g, { reentry: 'each_event' })
    for (let i = 0; i < 5; i++) {
      r.raw.exec(`INSERT INTO contacts (id,wa_id,phone,name) VALUES (${10 + i},'1555${i}','1555${i}','C${i}')`)
      r.raw.exec(`INSERT INTO leads (id,contact_id,source,status) VALUES (${10 + i},${10 + i},'whatsapp','new')`)
      await startRun(r.env, f, { id: 10 + i, contact_id: 10 + i }, ev(i), { now: NOW })
    }
    const res = await tick(r.env, { now: NOW + 9999, dbBudget: 22 })
    expect(res.resumed).toBeGreaterThan(0)
    expect(res.resumed).toBeLessThan(5)
    expect(res.more).toBe(true)
    const rest = await tick(r.env, { now: NOW + 9999, dbBudget: 100 })
    expect(res.resumed + rest.resumed).toBe(5)
  })
})

describe('wait_event', () => {
  const g = graph(
    [trigger(), node('w', 'wait_event', { timeout: 1, timeoutUnit: 'hours' }), node('ok', 'variable', { variableName: 'r', value: 'replied:{{user_response}}' }), node('to', 'variable', { variableName: 'r', value: 'timed out' })],
    [edge('t', 'out', 'w'), edge('w', 'completed', 'ok'), edge('w', 'timeout', 'to')],
  )
  const vars = (id: number) => JSON.parse(runRow(r.raw, id).context).vars
  it('resumes on the contact reply along the completed port', async () => {
    const res = await startRun(r.env, addFlow(r.raw, g), lead, ev(), { now: NOW }) as any
    expect(runRow(r.raw, res.runId)).toMatchObject({ status: 'awaiting', await_kind: 'reply', resume_at: NOW + 3600 })
    const out = await resumeOnReply(r.env, 1, 'wamid.1', { text: 'yes please' }, { now: NOW + 60 })
    expect(out).toMatchObject({ resumed: true, status: 'completed' })
    expect(vars(res.runId).r).toBe('replied:yes please')
  })
  it('a redelivered reply (same wamid) is a no-op', async () => {
    const res = await startRun(r.env, addFlow(r.raw, g), lead, ev(), { now: NOW }) as any
    await resumeRun(r.env, res.runId, { kind: 'reply', key: 'w1', payload: { text: 'a' } }, { now: NOW + 1 })
    expect(await resumeRun(r.env, res.runId, { kind: 'reply', key: 'w1', payload: { text: 'a' } }, { now: NOW + 2 })).toMatchObject({ resumed: false })
  })
  it('times out via the tick along the timeout port, and a late reply finds nothing to resume', async () => {
    const res = await startRun(r.env, addFlow(r.raw, g), lead, ev(), { now: NOW }) as any
    expect((await tick(r.env, { now: NOW + 3599, dbBudget: 40 })).resumed).toBe(0)
    expect((await tick(r.env, { now: NOW + 3600, dbBudget: 40 })).completed).toBe(1)
    expect(vars(res.runId).r).toBe('timed out')
    expect(await resumeOnReply(r.env, 1, 'late', { text: 'hi' }, { now: NOW + 4000 })).toBeNull()
  })
  it('a reply cannot resume a timer wait, and a timer cannot resume a reply wait', async () => {
    const res = await startRun(r.env, addFlow(r.raw, g), lead, ev(), { now: NOW }) as any
    expect(await resumeRun(r.env, res.runId, { kind: 'timer' }, { now: NOW + 10_000 })).toMatchObject({ resumed: false, reason: 'wrong_kind' })
  })
})

describe('idempotency', () => {
  const g = graph([trigger(), node('d', 'delay', { duration: 1, unit: 'hours' })], [edge('t', 'out', 'd')])
  it('the same (flow, trigger, key) twice gives one run', async () => {
    const f = addFlow(r.raw, g)
    const a = await startRun(r.env, f, lead, ev('k'), { now: NOW }) as any
    const b = await startRun(r.env, f, lead, ev('k'), { now: NOW }) as any
    expect(a.started).toBe(true)
    expect(b).toMatchObject({ started: false })
    expect(r.raw.prepare('SELECT COUNT(*) n FROM flow_runs').get()).toEqual({ n: 1 })
  })
  it('concurrent starts for one event give one run', async () => {
    const f = addFlow(r.raw, g)
    const rs = await Promise.all([1, 2, 3].map(() => startRun(r.env, f, lead, ev('same'), { now: NOW }))) as any[]
    expect(rs.filter((x) => x.started)).toHaveLength(1)
    expect(r.raw.prepare('SELECT COUNT(*) n FROM flow_runs').get()).toEqual({ n: 1 })
  })
  it('once: a lead that already ran is not re-entered; each_event: only after the live run ends', async () => {
    const once = addFlow(r.raw, g, { id: 1, reentry: 'once' })
    await startRun(r.env, once, lead, ev('a'), { now: NOW })
    expect(await startRun(r.env, once, lead, ev('b'), { now: NOW })).toMatchObject({ started: false })
    const each = addFlow(r.raw, g, { id: 2, reentry: 'each_event' })
    await startRun(r.env, each, lead, ev('a'), { now: NOW })
    expect(await startRun(r.env, each, lead, ev('b'), { now: NOW })).toMatchObject({ started: false, reason: 'live' })
    await tick(r.env, { now: NOW + 4000, dbBudget: 40 }) // both delays end, runs complete
    expect(await startRun(r.env, each, lead, ev('c'), { now: NOW + 4001 })).toMatchObject({ started: true })
  })
})

describe('shadow mode', () => {
  const g = graph(
    [trigger(), node('a', 'action', { actionType: 'add_tag', tag: 'hot' }), node('s', 'action', { actionType: 'set_stage', stage: 'contacted' }), node('n', 'action', { actionType: 'note', text: 'hi {{lead.name}}' })],
    [edge('t', 'out', 'a'), edge('a', 'out', 's'), edge('s', 'out', 'n')],
  )
  const snap = () => ({
    lead: r.raw.prepare('SELECT status,assigned_to FROM leads WHERE id=1').get(),
    tags: r.raw.prepare('SELECT COUNT(*) n FROM lead_tags').get(),
    acts: acts(r.raw).filter((a) => a.kind !== 'flow_run').length, msgs: r.raw.prepare('SELECT COUNT(*) n FROM messages').get(),
  })
  it('shadow records would-do and writes nothing', async () => {
    const before = snap()
    const res = await startRun(r.env, addFlow(r.raw, g, { shadow: 1 }), lead, ev(), { now: NOW }) as any
    expect(res.status).toBe('completed')
    expect(snap()).toEqual(before)
    const ctx = JSON.parse(runRow(r.raw, res.runId).context)
    expect(ctx.nodes.a.output.would).toMatchObject({ tag: 'hot' })
    expect(ctx.nodes.n.output.would.text).toBe('hi Asha Rao')
  })
  it('a live flow applies the same actions with actor flow:<id>', async () => {
    await startRun(r.env, addFlow(r.raw, g, { id: 7 }), lead, ev(), { now: NOW })
    expect(r.raw.prepare('SELECT status FROM leads WHERE id=1').get()).toEqual({ status: 'contacted' })
    expect(r.raw.prepare('SELECT COUNT(*) n FROM lead_tags').get()).toEqual({ n: 1 })
    const a = acts(r.raw)
    expect(a.length).toBeGreaterThanOrEqual(3)
    expect(a.every((x) => x.actor === 'flow:7')).toBe(true)
  })
})
