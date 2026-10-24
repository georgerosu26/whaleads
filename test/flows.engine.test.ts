import { beforeEach, describe, expect, it } from 'vitest'
import { startRun } from '../src/flows/engine'
import { EXECUTORS } from '../src/flows/nodes'
import { validateGraph } from '../src/flows/graph'
import { LIMITS } from '../src/flows/types'
import { acts, addFlow, edge, graph, lead, node, rig, runRow, trigger, traceOf, type Rig } from './flows.helpers'

let r: Rig
beforeEach(async () => { r = await rig() })

describe('dispatcher ordering and persistence', () => {
  it('runs nodes in connection order, records each output under its id, persists once and completes', async () => {
    const g = graph(
      [trigger(), node('v1', 'variable', { variableName: 'who', value: '{{lead.name}}' }), node('v2', 'variable', { variableName: 'msg', value: 'hi {{who}} from {{v1.value}}' })],
      [edge('t', 'out', 'v1'), edge('v1', 'out', 'v2')],
    )
    const flow = addFlow(r.raw, g)
    let batches = 0
    const real = r.env.DB.batch.bind(r.env.DB)
    ;(r.env.DB as any).batch = (s: any) => { batches++; return real(s) }
    const res = await startRun(r.env, flow, lead, { kind: 'lead_created', key: 1 })
    expect(res).toMatchObject({ started: true, status: 'completed', error: null })
    const run = runRow(r.raw, (res as any).runId)
    expect(run.status).toBe('completed')
    expect(run.completed_at).not.toBeNull()
    const ctx = JSON.parse(run.context)
    expect(ctx.vars).toEqual({ who: 'Asha Rao', msg: 'hi Asha Rao from Asha Rao' })
    expect(ctx.nodes.v1.output.value).toBe('Asha Rao')
    expect(traceOf(r.raw, run.id).map((t) => t.node)).toEqual(['t', 'v1', 'v2'])
    expect(batches).toBe(1) // one persist for the whole step
  })

  it('a node with no connection on its chosen port ends the run as completed', async () => {
    const g = graph([trigger(), node('c', 'condition', { left: 'lead.stage', operator: 'equals', value: 'new' })], [edge('t', 'out', 'c')]) // yes has no edge
    const res = await startRun(r.env, addFlow(r.raw, g), lead, { kind: 'lead_created', key: 1 })
    expect(res).toMatchObject({ started: true, status: 'completed' })
  })

  it('a node that cannot run fails the run cleanly with an error row, nothing half-applied', async () => {
    // The message node: with the 24h window closed (a lead that never wrote) and no window_closed port it fails readably.
    const g = graph([trigger(), node('m', 'message', { text: 'hello' })], [edge('t', 'out', 'm')])
    const res = await startRun(r.env, addFlow(r.raw, g), lead, { kind: 'lead_created', key: 1 })
    expect(res).toMatchObject({ started: true, status: 'failed' })
    const run = runRow(r.raw, (res as any).runId)
    expect(run.status).toBe('failed')
    expect(run.error).toMatch(/window_closed/)
    expect(r.raw.prepare('SELECT COUNT(*) n FROM messages').get()).toEqual({ n: 0 })
  })
})

describe('variable node', () => {
  const run = async (data: Record<string, unknown>, pre?: string) => {
    const nodes = [trigger(), ...(pre ? [node('p', 'variable', { variableName: 'x', value: pre })] : []), node('v', 'variable', data)]
    const cons = pre ? [edge('t', 'out', 'p'), edge('p', 'out', 'v')] : [edge('t', 'out', 'v')]
    const res = await startRun(r.env, addFlow(r.raw, graph(nodes, cons)), lead, { kind: 'lead_created', key: 1 }) as any
    return JSON.parse(runRow(r.raw, res.runId).context).vars
  }
  it('set, append, increment, clear', async () => {
    expect(await run({ variableName: 'x', value: 'a' })).toEqual({ x: 'a' })
    r = await rig(); expect(await run({ variableName: 'x', operation: 'append', value: 'b' }, 'a')).toEqual({ x: 'ab' })
    r = await rig(); expect(await run({ variableName: 'x', operation: 'increment', value: '2' }, '5')).toEqual({ x: 7 })
    r = await rig(); expect(await run({ variableName: 'x', operation: 'clear' }, 'a')).toEqual({})
  })
  it('refuses engine-reserved and prototype names; reads of them resolve to nothing', async () => {
    for (const name of ['__appliedEvents', '__proto__', 'constructor']) {
      r = await rig()
      const res = await startRun(r.env, addFlow(r.raw, graph([trigger(), node('v', 'variable', { variableName: name, value: 'x' })], [edge('t', 'out', 'v')])), lead, { kind: 'lead_created', key: 1 }) as any
      const ctx = JSON.parse(runRow(r.raw, res.runId).context)
      expect(ctx.nodes.v.output.error).toBe('invalid_variable_name')
      expect(Object.keys(ctx.vars)).toEqual([])
    }
  })
  it('{{constructor}} / {{__proto__.x}} interpolate to empty, never to Object internals', async () => {
    const res = await startRun(r.env, addFlow(r.raw, graph([trigger(), node('v', 'variable', { variableName: 'o', value: '[{{constructor}}][{{__proto__.polluted}}][{{lead.constructor}}]' })], [edge('t', 'out', 'v')])), lead, { kind: 'lead_created', key: 1 }) as any
    expect(JSON.parse(runRow(r.raw, res.runId).context).vars.o).toBe('[][][]')
  })
})

describe('limits abort cleanly', () => {
  it('node cap: a loop with no delay fails with an error row after MAX_NODES_PER_STEP, and rolls back planned writes', async () => {
    const g = graph(
      [trigger(), node('n', 'action', { actionType: 'note', text: 'again' }), node('v', 'variable', { variableName: 'i', operation: 'increment', value: '1' })],
      [edge('t', 'out', 'n'), edge('n', 'out', 'v'), edge('v', 'out', 'n')],
    )
    expect(validateGraph(g).map((e) => e.msg).join()).toMatch(/loop must pass through a Delay/) // the publish guard would refuse it
    const res = await startRun(r.env, addFlow(r.raw, g), lead, { kind: 'lead_created', key: 1 }, { skipValidation: true }) as any
    expect(res).toMatchObject({ started: true, status: 'failed' })
    const run = runRow(r.raw, res.runId)
    expect(run.status).toBe('failed')
    expect(run.error).toMatch(/node cap/)
    expect(run.completed_at).not.toBeNull()
    expect(acts(r.raw).filter((a) => a.kind !== 'flow_run')).toEqual([]) // the 25 queued notes were dropped with the step
    expect(traceOf(r.raw, run.id).at(-1)?.note).toMatch(/step rolled back/)
    expect(LIMITS.MAX_NODES_PER_STEP).toBe(50)
  })

  it('step budget: a spent wall clock parks the run as a due timer with pendingExec, and the next step continues it', async () => {
    const g = graph([trigger(), node('v1', 'variable', { variableName: 'a', value: '1' }), node('v2', 'variable', { variableName: 'b', value: '2' })], [edge('t', 'out', 'v1'), edge('v1', 'out', 'v2')])
    const flow = addFlow(r.raw, g)
    let t = 0
    // the clock jumps 30 s per read: the first check (deadline computed) passes, the second check is past the budget
    const clock = () => (t += 15_000)
    const res = await startRun(r.env, flow, lead, { kind: 'lead_created', key: 1 }, { now: 1000, clock, stepBudgetMs: 20_000 }) as any
    expect(res.status).toBe('awaiting')
    const run = runRow(r.raw, res.runId)
    expect(run).toMatchObject({ status: 'awaiting', await_kind: 'timer', resume_at: 1000, current_node_id: 'v1' })
    expect(JSON.parse(run.context).pendingExec).toBe('v1')
  })

  it('context over 32 KB fails the run with context_too_large instead of persisting it', async () => {
    const big = 'x'.repeat(5000)
    const nodes = [trigger(), ...Array.from({ length: 8 }, (_, i) => node(`v${i}`, 'variable', { variableName: `b${i}`, value: big }))]
    const cons = nodes.slice(0, -1).map((n, i) => edge(n.id, 'out', nodes[i + 1].id))
    const res = await startRun(r.env, addFlow(r.raw, graph(nodes, cons)), lead, { kind: 'lead_created', key: 1 }) as any
    expect(res.status).toBe('failed')
    expect(runRow(r.raw, res.runId).error).toBe('context_too_large')
  })
})

describe('validateGraph', () => {
  const ok = graph([trigger(), node('d', 'delay', { duration: 1, unit: 'hours' }), node('a', 'action', { actionType: 'note', text: 'x' })], [edge('t', 'out', 'd'), edge('d', 'out', 'a')])
  it('accepts a sound graph, including a loop that passes through a delay', () => {
    expect(validateGraph(ok)).toEqual([])
    expect(validateGraph(graph([...ok.nodes], [...ok.connections, edge('a', 'out', 'd')]))).toEqual([])
  })
  it('rejects: no trigger, two triggers, unknown kind, bad port, unreachable node, double-connected port, dangling edge, unknown type', () => {
    const msgs = (g: any) => validateGraph(g).map((e) => e.msg).join(' | ')
    expect(msgs(graph([node('a', 'action')], []))).toMatch(/needs a trigger/)
    expect(msgs(graph([trigger(), { ...trigger(), id: 't2' }], []))).toMatch(/exactly one trigger/)
    expect(msgs(graph([trigger('nope')], []))).toMatch(/trigger kind/)
    expect(msgs(graph([trigger(), node('c', 'condition')], [edge('t', 'out', 'c'), edge('c', 'out', 't')]))).toMatch(/no "out" port/)
    expect(msgs(graph([trigger(), node('a', 'action')], []))).toMatch(/not connected to the trigger/)
    expect(msgs(graph([trigger(), node('a', 'action'), node('b', 'action')], [edge('t', 'out', 'a'), edge('t', 'out', 'b')]))).toMatch(/connected twice/)
    expect(msgs(graph([trigger()], [edge('t', 'out', 'zz')]))).toMatch(/missing node/)
    expect(msgs(graph([trigger(), { ...node('x', 'action'), type: 'bogus' as any }], [edge('t', 'out', 'x')]))).toMatch(/unknown node type/)
    expect(msgs(null)).toMatch(/must be/)
  })
  it('every node type has has a registered executor', () => {
    expect(Object.keys(EXECUTORS).sort()).toEqual(['action', 'ai', 'condition', 'delay', 'http_request', 'lead_writeback', 'message', 'template', 'trigger', 'variable', 'wait_event'])
  })
})
