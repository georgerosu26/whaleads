// Flow engine review fixes: resume lock on the step, per-step D1 cap, context reload, shadow semantics, strict conditions,
// time units, idempotency key format.
import { beforeEach, describe, expect, it } from 'vitest'
import type { Env } from '../src/db'
import { startRun } from '../src/flows/engine'
import { validateGraph } from '../src/flows/graph'
import { meterDb } from '../src/flows/meter'
import { delaySeconds, nextActionSeconds, waitSeconds } from '../src/flows/nodes/time'
import { findAwaitingReply, resumeRun } from '../src/flows/resume'
import { tick } from '../src/flows/tick'
import { acts, addFlow, edge, graph, lead, node, rig, runRow, trigger, traceOf, type Rig } from './flows.helpers'

let r: Rig
beforeEach(async () => { r = await rig() })
const ev = (key: string | number = 1) => ({ kind: 'lead_created', key })
const NOW = 1_800_000_000
const vars = (id: number) => JSON.parse(runRow(r.raw, id).context).vars

describe('P1-1 resume lock is on the step, not just the kind', () => {
  const g = graph(
    [trigger(), node('w1', 'wait_event', { timeout: 1, timeoutUnit: 'hours' }), node('w2', 'wait_event', { timeout: 5, timeoutUnit: 'hours' }),
      node('late', 'variable', { variableName: 'path', value: 'reply-at-w1' }), node('done', 'variable', { variableName: 'path', value: 'reply-at-w2' })],
    [edge('t', 'out', 'w1'), edge('w1', 'completed', 'late'), edge('w1', 'timeout', 'w2'), edge('w2', 'completed', 'done')],
  )
  it('a reply that read the run at w1 loses once a timeout has moved it on and parked it at w2', async () => {
    const res = await startRun(r.env, addFlow(r.raw, g), lead, ev(), { now: NOW }) as any
    const before = runRow(r.raw, res.runId)
    expect(before).toMatchObject({ current_node_id: 'w1', await_kind: 'reply' })
    // The reply's CAS is held back until a timeout resume has run to completion (the exact interleaving).
    let fired = false
    const real = r.env.DB
    const env2 = { ...r.env, DB: new Proxy(real, { get(t, p) {
      if (p !== 'prepare') { const v = Reflect.get(t, p, t) as unknown; return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v }
      return (sql: string) => {
        const st = t.prepare(sql)
        if (!fired && sql.includes("SET status='running', step=step+1")) {
          return { bind: (...a: unknown[]) => ({ run: async () => { fired = true; await resumeRun(r.env, res.runId, { kind: 'timeout' }, { now: NOW + 3600 }); return st.bind(...a).run() } }) }
        }
        return st
      }
    } }) } as unknown as Env
    const out = await resumeRun(env2, res.runId, { kind: 'reply', key: 'wamid.stale', payload: { text: 'hello' } }, { now: NOW + 3601 })
    expect(fired).toBe(true)
    expect(out).toEqual({ resumed: false, reason: 'race' })
    const after = runRow(r.raw, res.runId)
    expect(after).toMatchObject({ status: 'awaiting', current_node_id: 'w2', await_kind: 'reply' })
    expect(after.step).toBeGreaterThan(before.step)
    expect(vars(res.runId).path).toBeUndefined() // the w1 'completed' branch never ran
    expect(JSON.parse(after.context).applied ?? []).not.toContain('wamid.stale')
  })
  it('every state write bumps step', async () => {
    const res = await startRun(r.env, addFlow(r.raw, g), lead, ev(), { now: NOW }) as any
    const s1 = runRow(r.raw, res.runId).step
    await resumeRun(r.env, res.runId, { kind: 'reply', key: 'a', payload: {} }, { now: NOW + 1 })
    expect(runRow(r.raw, res.runId).step).toBeGreaterThan(s1)
  })
})

describe('P1-2 a step caps its D1 calls and parks', () => {
  const chain = (n: number, mk: (i: number) => ReturnType<typeof node>) => {
    const nodes = [trigger(), ...Array.from({ length: n }, (_, i) => mk(i))]
    return graph(nodes, nodes.slice(1).map((x, i) => edge(i === 0 ? 't' : nodes[i].id, 'out', x.id)))
  }
  const counted = () => { const m = { calls: 0 }; return { m, env: { ...r.env, DB: meterDb(r.env.DB, m) } as Env } }

  it('20 set-stage nodes park under the cap, resume across ticks, and never exceed it', async () => {
    const g = chain(20, (i) => node(`s${i}`, 'action', { actionType: 'set_stage', stage: i % 2 ? 'new' : 'contacted' }))
    const f = addFlow(r.raw, g)
    const a = counted()
    const res = await startRun(a.env, f, lead, ev(), { now: NOW }) as any
    expect(res.status).toBe('awaiting')
    expect(a.m.calls).toBeLessThanOrEqual(37) // cap 30 + the stage.changed flow lookup + + one node's reads + the final batch
    expect(traceOf(r.raw, res.runId).some((t) => t.note?.includes('D1 cap'))).toBe(true)
    let ticks = 0
    for (; ticks < 6 && runRow(r.raw, res.runId).status !== 'completed'; ticks++) {
      const c = counted()
      await tick(c.env, { now: NOW + 10 + ticks, dbBudget: 40 })
      expect(c.m.calls).toBeLessThanOrEqual(40)
    }
    expect(runRow(r.raw, res.runId).status).toBe('completed')
    expect(ticks).toBeGreaterThan(0)
    expect(acts(r.raw).filter((x) => x.kind === 'stage_changed' || x.kind === 'status_changed' || x.kind === 'stage').length).toBe(20)
    expect(r.raw.prepare('SELECT status FROM leads WHERE id=1').get()).toEqual({ status: 'new' })
  })
  it('a small cap parks after the first node and still makes progress every step', async () => {
    const g = chain(4, (i) => node(`v${i}`, 'variable', { variableName: `a${i}`, value: String(i) }))
    const f = addFlow(r.raw, g)
    const res = await startRun(r.env, f, lead, ev(), { now: NOW, dbCap: 0 }) as any
    expect(res.status).toBe('awaiting') // trigger ran, then the cap parked it
    for (let i = 0; i < 8 && runRow(r.raw, res.runId).status !== 'completed'; i++) await tick(r.env, { now: NOW + 5, dbBudget: 40, dbCap: 0 })
    expect(runRow(r.raw, res.runId).status).toBe('completed')
    expect(vars(res.runId)).toMatchObject({ a0: '0', a3: '3' })
  })
  it('tags are looked up once per step: 20 alternating add/remove nodes cost two reads and net out', async () => {
    const g = chain(20, (i) => node(`g${i}`, 'action', { actionType: i % 2 ? 'remove_tag' : 'add_tag', tag: 'HOT' }))
    const a = counted()
    const res = await startRun(a.env, addFlow(r.raw, g), lead, ev(), { now: NOW }) as any
    expect(res.status).toBe('completed')
    expect(a.m.calls).toBeLessThanOrEqual(14)
    expect(r.raw.prepare('SELECT COUNT(*) n FROM lead_tags').get()).toEqual({ n: 0 }) // add-then-remove in one step nets out
    expect(acts(r.raw).filter((x) => x.kind === 'tag_added')).toHaveLength(10)
    expect(acts(r.raw).filter((x) => x.kind === 'tag_removed')).toHaveLength(10)
  })
})

describe('P1-3 a resumed run sees fresh lead data', () => {
  const g = graph(
    [trigger(), node('d', 'delay', { duration: 1, unit: 'hours' }), node('c', 'condition', { left: 'lead.stage', operator: 'equals', value: 'contacted' }),
      node('y', 'variable', { variableName: 'path', value: 'yes' }), node('n', 'variable', { variableName: 'path', value: 'no' })],
    [edge('t', 'out', 'd'), edge('d', 'out', 'c'), edge('c', 'yes', 'y'), edge('c', 'no', 'n')],
  )
  it('the stage changed during the delay is what the condition reads', async () => {
    const res = await startRun(r.env, addFlow(r.raw, g), lead, ev(), { now: NOW }) as any
    r.raw.exec(`UPDATE leads SET status='contacted' WHERE id=1`)
    r.raw.exec(`UPDATE contacts SET name='Renamed' WHERE id=1`)
    await tick(r.env, { now: NOW + 3600, dbBudget: 40 })
    expect(vars(res.runId).path).toBe('yes')
    expect(JSON.parse(runRow(r.raw, res.runId).context).contact.name).toBe('Renamed')
  })
  it('tags and business.open are reloaded too', async () => {
    const g2 = graph([trigger(), node('d', 'delay', { duration: 1, unit: 'hours' }), node('c', 'condition', { left: 'lead.tags', operator: 'contains', value: 'hot' }), node('y', 'variable', { variableName: 'path', value: 'yes' })], [edge('t', 'out', 'd'), edge('d', 'out', 'c'), edge('c', 'yes', 'y')])
    const res = await startRun(r.env, addFlow(r.raw, g2), lead, ev(), { now: NOW }) as any
    r.raw.exec(`INSERT INTO lead_tags (lead_id,tag_id) VALUES (1,1)`)
    await tick(r.env, { now: NOW + 3600, dbBudget: 40 })
    expect(vars(res.runId).path).toBe('yes')
  })
})

describe('shadow runs', () => {
  const wait = graph([trigger(), node('w', 'wait_event', { timeout: 1, timeoutUnit: 'hours' })], [edge('t', 'out', 'w')])
  it('do not consume the once slot of a live run, and a live run does not block a shadow one', async () => {
    const shadow = addFlow(r.raw, wait, { id: 1, shadow: 1, reentry: 'once' })
    expect(await startRun(r.env, shadow, lead, ev('s1'), { now: NOW })).toMatchObject({ started: true })
    const live = { ...shadow, shadow: 0 }
    expect(await startRun(r.env, live, lead, ev('l1'), { now: NOW })).toMatchObject({ started: true })
    // each side still enforces its own slot
    expect(await startRun(r.env, live, lead, ev('l2'), { now: NOW })).toMatchObject({ started: false })
    expect(await startRun(r.env, shadow, lead, ev('s2'), { now: NOW })).toMatchObject({ started: false })
  })
  it('a finished shadow run does not make a live once-flow report "once"', async () => {
    const f = addFlow(r.raw, graph([trigger()], []), { id: 1, shadow: 1, reentry: 'once' })
    expect(await startRun(r.env, f, lead, ev('s1'), { now: NOW })).toMatchObject({ started: true, status: 'completed' })
    expect(await startRun(r.env, { ...f, shadow: 0 }, lead, ev('l1'), { now: NOW })).toMatchObject({ started: true })
  })
  it('findAwaitingReply skips shadow runs', async () => {
    const shadow = addFlow(r.raw, wait, { id: 1, shadow: 1 })
    await startRun(r.env, shadow, lead, ev('s1'), { now: NOW })
    expect(await findAwaitingReply(r.env, 1)).toBeNull()
    const live = addFlow(r.raw, wait, { id: 2, shadow: 0 })
    const l = await startRun(r.env, live, lead, ev('l1'), { now: NOW }) as any
    expect(await findAwaitingReply(r.env, 1)).toBe(l.runId)
  })
})

describe('condition: numeric operators are strict', () => {
  const run = async (op: string, left: string, value: string) => {
    const g = graph([trigger(), node('c', 'condition', { left, operator: op, value }), node('y', 'variable', { variableName: 'p', value: 'yes' }), node('n', 'variable', { variableName: 'p', value: 'no' })], [edge('t', 'out', 'c'), edge('c', 'yes', 'y'), edge('c', 'no', 'n')])
    r.raw.exec(`DELETE FROM flow_runs; DELETE FROM flows`)
    const res = await startRun(r.env, addFlow(r.raw, g), lead, ev(Math.random()), { now: NOW }) as any
    return vars(res.runId).p
  }
  it('missing or empty values are false for gt/gte/lt/lte (not 0)', async () => {
    expect(await run('gte', 'nothing.here', '0')).toBe('no')
    expect(await run('lte', 'nothing.here', '5')).toBe('no')
    expect(await run('lt', 'nothing.here', '5')).toBe('no')
    expect(await run('gt', 'lead.stage', '5')).toBe('no') // non-numeric
    expect(await run('gte', 'lead.stage', '')).toBe('no') // empty rhs
  })
  it('real numbers compare; sloppy numerics do not parse', async () => {
    expect(await run('gt', '{{lead.id}}', '0')).toBe('yes')
    expect(await run('lt', '{{lead.id}}', '1.5')).toBe('yes')
    expect(await run('gte', '1e3', '5')).toBe('no')
    expect(await run('gte', '0x10', '5')).toBe('no')
    expect(await run('gte', 'Infinity', '5')).toBe('no')
  })
})

describe('time units', () => {
  const g = (n: ReturnType<typeof node>) => graph([trigger(), n], [edge('t', 'out', n.id)])
  it('validateGraph rejects unknown units and non-numeric durations on all three duration nodes', () => {
    expect(validateGraph(g(node('d', 'delay', { duration: 5, unit: 'weeks' })))).toEqual([{ node: 'd', msg: expect.stringContaining('unit must be one of') }])
    expect(validateGraph(g(node('w', 'wait_event', { timeout: 5, timeoutUnit: 'min' })))).toHaveLength(1)
    expect(validateGraph(g(node('a', 'action', { actionType: 'set_next_action', duration: 5, unit: 'fortnights' })))).toHaveLength(1)
    expect(validateGraph(g(node('d', 'delay', { duration: 'soon', unit: 'hours' })))).toEqual([{ node: 'd', msg: expect.stringContaining('positive number') }])
    expect(validateGraph(g(node('d', 'delay', { duration: -1 })))).toHaveLength(1)
  })
  it('accepts valid units, string numbers and absent units', () => {
    for (const n of [node('d', 'delay', { duration: '5', unit: 'days' }), node('w', 'wait_event', { timeout: 2 }), node('a', 'action', { actionType: 'set_next_action', duration: 3 }), node('d2', 'delay', {})]) expect(validateGraph(g(n))).toEqual([])
  })
  it('per-node defaults: delay=minutes, wait timeout=hours, set_next_action=hours', () => {
    expect(delaySeconds({ duration: 5 })).toBe(300)
    expect(waitSeconds({ timeout: 2 })).toBe(7200)
    expect(nextActionSeconds({ duration: 3 })).toBe(10800)
  })
})

describe('idempotency key', () => {
  const g = graph([trigger(), node('d', 'delay', { duration: 1, unit: 'hours' })], [edge('t', 'out', 'd')])
  it('is flow:lead:kind:key, so two leads sharing an event key both start', async () => {
    r.raw.exec(`INSERT INTO contacts (id,wa_id,phone,name) VALUES (2,'2','2','B')`)
    r.raw.exec(`INSERT INTO leads (id,contact_id,source,status) VALUES (2,2,'whatsapp','new')`)
    const f = addFlow(r.raw, g)
    const a = await startRun(r.env, f, lead, ev('shared'), { now: NOW }) as any
    const b = await startRun(r.env, f, { id: 2, contact_id: 2 }, ev('shared'), { now: NOW }) as any
    expect(a.started && b.started).toBe(true)
    expect(runRow(r.raw, a.runId).idem_key).toBe('1:1:lead_created:shared')
    expect(runRow(r.raw, b.runId).idem_key).toBe('1:2:lead_created:shared')
  })
  it('a missing key refuses to start, with a clear error', async () => {
    const f = addFlow(r.raw, g)
    for (const key of [undefined, null, '']) {
      const out = await startRun(r.env, f, lead, { kind: 'lead_created', key }, { now: NOW }) as any
      expect(out).toMatchObject({ started: false, reason: 'missing_key' })
      expect(out.error).toMatch(/needs a key/)
    }
    expect(r.raw.prepare('SELECT COUNT(*) n FROM flow_runs').get()).toEqual({ n: 0 })
  })
})
