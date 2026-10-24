// the editor's pure model against the engine's contract: graph round trip, history stack, inspector <-> data.
import { describe, expect, it } from 'vitest'
import { validateGraph } from '../src/flows/graph'
import { durationError } from '../src/flows/nodes/time'
import { NODE_TYPES, OUTPUT_PORTS } from '../src/flows/types'
import { freeSpot, addNode, canRedo, canUndo, connect, createHistory, deleteNodes, deserialize, pushHistory, redo, serialize, undo, HISTORY_LIMIT, moveNodes, issuesByNode } from '../ui/src/pages/flows/graph-model'
import { createNode, portPos, portsFor, nodeHeight } from '../ui/src/pages/flows/flow-types'
import { dataToForm, formToData, headerIssue, httpUrlIssue, regexIssue, type Form } from '../ui/src/pages/flows/inspector-map'
import type { FlowData, NodeType } from '../ui/src/lib/flows'

const emptyFromServer: FlowData = { nodes: [{ id: 'trigger', type: 'trigger', label: 'Trigger', x: 80, y: 80, width: 220, height: 80, data: {}, ports: [{ id: 'out', label: 'Next', type: 'output' }] }], connections: [] }
const hard = (g: FlowData) => validateGraph(g).filter((e) => !e.soft)

describe('graph serialiser', () => {
  it('reads the graph a new flow starts with and rebuilds geometry', () => {
    const g = deserialize(emptyFromServer)
    expect(g.nodes[0]!.height).toBe(nodeHeight(g.nodes[0]!))
    expect(validateGraph(serialize(g)).map((e) => e.msg)).toEqual([expect.stringContaining('trigger kind')])
  })
  it('round-trips a graph that uses every node type with no hard errors', () => {
    let g = deserialize(emptyFromServer)
    g.nodes[0]!.data = formToData('trigger', { ...(dataToForm('trigger', {}) as object), kind: 'message_received', match: 'keyword', keywords: 'hi\nhello' } as Form)
    let prev = 'trigger'
    for (const t of NODE_TYPES.filter((x) => x !== 'trigger')) {
      const r = addNode(g, t as NodeType, 300 + g.nodes.length * 10, 80)!
      g = r.graph
      const n = g.nodes.find((x) => x.id === r.id)!
      n.data = t === 'message' ? { text: 'Hi {{lead.name}}' } : t === 'template' ? { templateId: '1', templateName: 't', bodyParams: [], headerParams: [] } : n.data
      const c = connect(g, prev, OUTPUT_PORTS[g.nodes.find((x) => x.id === prev)!.type][0]!, r.id)
      if ('error' in c) throw new Error(c.error)
      g = c.graph; prev = r.id
    }
    const wire = serialize(g)
    expect(hard(wire)).toEqual([])
    expect(JSON.parse(JSON.stringify(wire))).toEqual(wire)
    expect(serialize(deserialize(wire))).toEqual(wire)
    expect(wire.nodes.every((n) => n.ports.map((p) => p.id).join() === portsFor(n.type).map((p) => p.id).join())).toBe(true)
  })
  it('keeps one connection per port, refuses loops and links into the trigger', () => {
    let g = deserialize(emptyFromServer)
    const a = addNode(g, 'message', 300, 80)!; g = a.graph
    const b = addNode(g, 'delay', 600, 80)!; g = b.graph
    g = (connect(g, 'trigger', 'out', a.id) as { graph: FlowData }).graph
    g = (connect(g, 'trigger', 'out', b.id) as { graph: FlowData }).graph
    expect(g.connections).toHaveLength(1)
    expect(g.connections[0]!.toNodeId).toBe(b.id)
    expect('error' in connect(g, a.id, 'out', a.id)).toBe(true)
    expect('error' in connect(g, a.id, 'out', 'trigger')).toBe(true)
    expect('error' in connect(g, a.id, 'yes', b.id)).toBe(true)
  })
  it('never deletes the trigger and drops the connections of a deleted node', () => {
    let g = deserialize(emptyFromServer)
    const a = addNode(g, 'message', 300, 80)!; g = a.graph
    g = (connect(g, 'trigger', 'out', a.id) as { graph: FlowData }).graph
    expect(deleteNodes(g, ['trigger'])).toBe(g)
    const d = deleteNodes(g, [a.id])
    expect(d.nodes.map((n) => n.id)).toEqual(['trigger'])
    expect(d.connections).toEqual([])
  })
  it('puts ports where the card draws them', () => {
    const n = createNode('condition', [], 100, 100)
    expect(portPos(n, n.ports[0]!)).toEqual({ x: 100, y: 118 })
    const yes = n.ports.find((p) => p.id === 'yes')!, no = n.ports.find((p) => p.id === 'no')!
    expect(portPos(n, no).y - portPos(n, yes).y).toBe(24)
  })
  it('groups server issues by node', () => {
    expect(issuesByNode([{ node: 'a', msg: 'x' }, { node: 'a', msg: 'y' }, { node: null, msg: 'z' }]).get('a')).toEqual(['x', 'y'])
  })
  it('moves nodes by a delta', () => {
    const g = moveNodes(deserialize(emptyFromServer), ['trigger'], 10, -5)
    expect([g.nodes[0]!.x, g.nodes[0]!.y]).toEqual([90, 75])
  })
})

describe('history stack', () => {
  it('undoes and redoes, and a new edit clears redo', () => {
    let h = createHistory(0)
    h = pushHistory(h, 1); h = pushHistory(h, 2)
    h = undo(h); expect(h.present).toBe(1); expect(canRedo(h)).toBe(true)
    h = redo(h); expect(h.present).toBe(2)
    h = undo(h); h = pushHistory(h, 9)
    expect(canRedo(h)).toBe(false); expect(undo(h).present).toBe(1)
  })
  it('keeps 50 steps', () => {
    let h = createHistory(0)
    for (let i = 1; i <= 80; i++) h = pushHistory(h, i)
    expect(h.past).toHaveLength(HISTORY_LIMIT)
    for (let i = 0; i < 100; i++) h = undo(h)
    expect(h.present).toBe(30); expect(canUndo(h)).toBe(false)
  })
  it('folds edits with the same key into one step', () => {
    let h = createHistory('')
    for (const v of ['a', 'ab', 'abc']) h = pushHistory(h, v, 'text:n1')
    expect(h.past).toEqual(['']); expect(undo(h).present).toBe('')
    h = pushHistory(h, 'x', 'text:n2'); expect(h.past).toHaveLength(2)
  })
  it('ignores a no-op push', () => {
    const h = createHistory({ a: 1 }); expect(pushHistory(h, h.present)).toBe(h)
  })
})

describe('inspector mapping', () => {
  const rt = (type: NodeType, form: Form) => formToData(type, form)
  const asGraph = (type: NodeType, data: Record<string, unknown>): FlowData => {
    const g = deserialize(emptyFromServer)
    g.nodes[0]!.data = { kind: 'lead_created' }
    const n = createNode(type, g.nodes, 300, 80); n.data = data
    const c = connect({ ...g, nodes: [...g.nodes, n] }, 'trigger', 'out', n.id) as { graph: FlowData }
    return c.graph
  }
  it('trigger: filters per kind, keywords split on lines and commas', () => {
    const base = dataToForm('trigger', {}) as any
    expect(rt('trigger', { ...base, kind: 'message_received', match: 'keyword', keywords: 'hi, hello\nnamaste' })).toEqual({ kind: 'message_received', reentry: 'once', match: 'keyword', keywords: ['hi', 'hello', 'namaste'] })
    expect(rt('trigger', { ...base, kind: 'message_received', match: 'regex', regexPattern: '^price' })).toMatchObject({ match: 'regex', regexPattern: '^price' })
    expect(rt('trigger', { ...base, kind: 'lead_created', sources: ['web'], stages: [] })).toEqual({ kind: 'lead_created', reentry: 'once', sources: ['web'] })
    expect(rt('trigger', { ...base, kind: 'stage_changed', from: ['new'], to: ['won'] })).toEqual({ kind: 'stage_changed', reentry: 'once', from: ['new'], to: ['won'] })
    expect(dataToForm('trigger', { kind: 'message_received', match: 'keyword', keywords: ['a', 'b'] })).toMatchObject({ keywords: 'a\nb' })
  })
  it('trigger: an unsafe regex is flagged before and by validateGraph', () => {
    expect(regexIssue('(a+)+$')).toMatch(/repeat/)
    expect(regexIssue('')).toBeTruthy()
    expect(regexIssue('^hi')).toBeNull()
    const g = asGraph('message', { text: 'x' }); g.nodes[0]!.data = { kind: 'message_received', match: 'regex', regexPattern: '(a+)+$' }
    expect(validateGraph(g).some((e) => /regex/.test(e.msg))).toBe(true)
  })
  it('message, template, variable, condition', () => {
    expect(rt('message', { text: 'Hi {{lead.name}}' })).toEqual({ text: 'Hi {{lead.name}}' })
    expect(rt('template', { templateId: '7', templateName: 'welcome', bodyParams: ['{{lead.name}}'], headerParams: [] })).toEqual({ templateId: '7', templateName: 'welcome', bodyParams: ['{{lead.name}}'], headerParams: [] })
    expect(rt('variable', { variableName: ' city ', operation: 'set', value: 'Pune' })).toEqual({ variableName: 'city', operation: 'set', value: 'Pune' })
    expect(rt('variable', { variableName: 'n', operation: 'clear', value: 'x' })).toEqual({ variableName: 'n', operation: 'clear' })
    expect(rt('condition', { left: '', operator: 'contains', value: 'price' })).toEqual({ left: 'user_response', operator: 'contains', value: 'price' })
    expect(rt('condition', { left: 'lead.name', operator: 'is_empty', value: 'stale' })).toEqual({ left: 'lead.name', operator: 'is_empty' })
  })
  it('action: only the fields of the chosen action', () => {
    const a = dataToForm('action', {}) as any
    expect(rt('action', { ...a, actionType: 'set_stage', stage: 'won', tag: 'x' })).toEqual({ actionType: 'set_stage', stage: 'won' })
    expect(rt('action', { ...a, actionType: 'add_tag', tag: 'hot' })).toEqual({ actionType: 'add_tag', tag: 'hot' })
    expect(rt('action', { ...a, actionType: 'assign', staffId: '3' })).toEqual({ actionType: 'assign', staffId: 3 })
    expect(rt('action', { ...a, actionType: 'assign', staffId: '' })).toEqual({ actionType: 'assign', staffId: null })
    expect(rt('action', { ...a, actionType: 'note', text: 'called' })).toEqual({ actionType: 'note', text: 'called' })
    expect(rt('action', { ...a, actionType: 'set_next_action', duration: '2', unit: 'days' })).toEqual({ actionType: 'set_next_action', duration: 2, unit: 'days' })
  })
  it('delay and wait_event: numbers and units the engine accepts', () => {
    expect(rt('delay', { duration: '90', unit: 'minutes' })).toEqual({ duration: 90, unit: 'minutes' })
    expect(rt('wait_event', { timeout: '2', timeoutUnit: 'days' })).toEqual({ timeout: 2, timeoutUnit: 'days' })
    expect(durationError('delay', rt('delay', { duration: '90', unit: 'minutes' }))).toBeNull()
    expect(durationError('delay', rt('delay', { duration: '1', unit: 'weeks' }))).toBeTruthy()
    expect(rt('delay', { duration: '', unit: 'hours' })).toEqual({ unit: 'hours' })
  })
  it('ai: prompt, output variable, max tokens', () => {
    expect(rt('ai', { systemPrompt: '', prompt: 'Summarise {{user_response}}', outputVariable: ' summary ', maxTokens: '200' })).toEqual({ prompt: 'Summarise {{user_response}}', outputVariable: 'summary', maxTokens: 200 })
  })
  it('http_request: headers list, body only off GET, static guard messages', () => {
    const f = { method: 'POST', url: ' https://api.example.com/x ', headers: [{ name: 'X-Key', value: 'v' }, { name: ' ', value: 'no' }], body: '{"a":1}', outputVariable: 'out' }
    expect(rt('http_request', f)).toEqual({ method: 'POST', url: 'https://api.example.com/x', headers: [{ name: 'X-Key', value: 'v' }], body: '{"a":1}', outputVariable: 'out' })
    expect(rt('http_request', { ...f, method: 'GET' })).not.toHaveProperty('body')
    expect(dataToForm('http_request', { headers: { 'X-A': '1' } })).toMatchObject({ headers: [{ name: 'X-A', value: '1' }] })
    expect(httpUrlIssue('')).toBeTruthy()
    expect(httpUrlIssue('http://localhost/x')).toMatch(/blocked/)
    expect(httpUrlIssue('http://169.254.169.254/latest')).toMatch(/blocked/)
    expect(httpUrlIssue('ftp://example.com')).toMatch(/protocol/)
    expect(httpUrlIssue('https://api.example.com/x')).toBeNull()
    expect(httpUrlIssue('{{base}}/x')).toMatch(/http/)
    expect(httpUrlIssue('https://{{host}}/x')).toBeNull()
    expect(headerIssue('Cookie')).toMatch(/dropped/)
    expect(headerIssue('X-Forwarded-For')).toMatch(/dropped/)
    expect(headerIssue('X-Api-Key')).toBeNull()
    expect(headerIssue('Authorization')).toBeNull()
  })
  it('lead_writeback: field map into ratingRules', () => {
    const d = rt('lead_writeback', { verdict: 'hot', score: '80', stage: 'won', signals: [{ path: 'lead.name', weight: '2' }, { path: '', weight: '1' }], thresholds: [{ min: '50', verdict: 'hot', stage: 'won' }] })
    expect(d).toEqual({ verdict: 'hot', score: 80, stage: 'won', ratingRules: { signals: [{ path: 'lead.name', weight: 2 }], thresholds: [{ min: 50, verdict: 'hot', stage: 'won' }] } })
    expect(dataToForm('lead_writeback', d)).toMatchObject({ score: '80', signals: [{ path: 'lead.name', weight: '2' }] })
  })
  it('every mapped node passes the engine graph validator', () => {
    const cases: [NodeType, Record<string, unknown>][] = [
      ['message', rt('message', { text: 'hello' })], ['condition', rt('condition', { left: 'user_response', operator: 'contains', value: 'a' })],
      ['action', rt('action', { ...(dataToForm('action', {}) as object), actionType: 'add_tag', tag: 'hot' } as Form)],
      ['delay', rt('delay', { duration: '5', unit: 'minutes' })], ['wait_event', rt('wait_event', { timeout: '1', timeoutUnit: 'hours' })],
      ['variable', rt('variable', { variableName: 'v', operation: 'set', value: '1' })],
    ]
    for (const [t, data] of cases) expect(hard(asGraph(t, data)), t).toEqual([])
  })
})

import { applyFlowRunFrame, mergeRunsFirstPage } from '../ui/src/lib/liveReduce'
describe('live run reducers', () => {
  const r = (id: number, status = 'running', node: string | null = 'n1') => ({ id, status, current_node_id: node, updated_at: 1, completed_at: null as number | null })
  it('patches a held run, null for an unknown one', () => {
    const rows = [r(2), r(1)]
    expect(applyFlowRunFrame(rows, { run_id: 1, status: 'waiting', node: 'n2' }, 9)![1]).toMatchObject({ status: 'waiting', current_node_id: 'n2', updated_at: 9 })
    expect(applyFlowRunFrame(rows, { run_id: 7, status: 'running', node: null })).toBeNull()
  })
  it('stamps completion and never reopens a finished run', () => {
    const done = applyFlowRunFrame([r(1)], { run_id: 1, status: 'completed', node: null }, 5)!
    expect(done[0]!.completed_at).toBe(5)
    expect(applyFlowRunFrame(done, { run_id: 1, status: 'running', node: 'n1' })).toBe(done)
  })
  it('returns the same array for a repeat frame', () => {
    const rows = [r(1)]; expect(applyFlowRunFrame(rows, { run_id: 1, status: 'running', node: 'n1' })).toBe(rows)
  })
  it('merges a refetched first page without duplicates', () => {
    expect(mergeRunsFirstPage([r(3), r(2), r(1)], [r(4), r(3, 'completed')]).map((x) => [x.id, x.status])).toEqual([[4, 'running'], [3, 'completed'], [2, 'running'], [1, 'running']])
  })
})

describe('flow editor review fixes', () => {
  it('never reuses a deleted step id, and the counter survives a round trip', () => {
    let g = deserialize({ nodes: [{ id: 'trigger', type: 'trigger', label: 'Trigger', x: 0, y: 0, width: 220, height: 0, data: {}, ports: [] }], connections: [] })
    const a = addNode(g, 'message', 300, 0)!; g = a.graph
    expect(a.id).toBe('message_1')
    g = deleteNodes(g, [a.id])
    const b = addNode(g, 'message', 300, 0)!
    expect(b.id).toBe('message_2')
    const back = deserialize(JSON.parse(JSON.stringify(serialize(b.graph))))
    expect(back.next_ids).toEqual({ message: 3 })
  })
  it('says when connecting moves an existing connection', () => {
    let g = deserialize({ nodes: [{ id: 'trigger', type: 'trigger', label: 'Trigger', x: 0, y: 0, width: 220, height: 0, data: {}, ports: [] }], connections: [] })
    const a = addNode(g, 'message', 300, 0)!; const b = addNode(a.graph, 'message', 600, 0)!
    const one = connect(b.graph, 'trigger', 'out', a.id) as any
    expect(one.moved).toBeUndefined()
    const two = connect(one.graph, 'trigger', 'out', b.id) as any
    expect(two.moved).toMatch(/already led to/)
  })
  it('keeps the flow column reentry when the trigger data has none', () => {
    expect(dataToForm('trigger', {}, 'each_event')).toMatchObject({ reentry: 'each_event' })
    expect(dataToForm('trigger', { reentry: 'once' }, 'each_event')).toMatchObject({ reentry: 'once' })
  })
  it('never shows a bare code', async () => {
    const { ApiError } = await import('../ui/src/lib/api')
    const { flowErrorText } = await import('../ui/src/lib/flows')
    for (const c of ['name_taken', 'not_cancellable', 'dry_run_timeout', 'not_active', 'payload_too_large', 'flow_archived', 'rate_limited']) expect(flowErrorText(new ApiError(409, c, { error: c }))).not.toBe(c)
    expect(flowErrorText(new ApiError(500, 'internal_thing'))).toBe('Something went wrong. Try again.')
  })
})

describe('flowErrorText', () => {
  it('turns coded flow API errors into plain words', async () => {
    const { ApiError } = await import('../ui/src/lib/api')
    const { flowErrorText, isRateLimited } = await import('../ui/src/lib/flows')
    expect(flowErrorText(new ApiError(429, 'rate_limited', { error: 'rate_limited' }))).toMatch(/Too many changes/)
    expect(isRateLimited(new ApiError(429, 'x'))).toBe(true)
    expect(flowErrorText(new ApiError(400, 'invalid', { error: 'invalid', field: 'id' }))).toMatch(/not valid/)
    expect(flowErrorText(new ApiError(409, 'flow_archived'))).toBe('This flow was archived.')
    expect(flowErrorText(new Error('Could not reach the server.'))).toBe('Could not reach the server.')
  })
})

describe('freeSpot', () => {
  const t = createNode('trigger', [], 80, 80)
  it('keeps a clear spot as asked', () => { expect(freeSpot([t], 400, 80, 220, 120)).toEqual({ x: 400, y: 80 }) })
  it('moves a spot that lands on a card to the right of the right-most card', () => {
    const p = freeSpot([t], 90, 90, 220, 120)
    expect(p.x).toBeGreaterThanOrEqual(t.x + t.width)
  })
  it('stacks into rows when the right side is taken too', () => {
    const m = createNode('message', [t], 380, 80)
    const p = freeSpot([t, m], 380, 80, 220, 120)
    expect(p.x >= m.x + m.width || p.y >= m.y + m.height).toBe(true)
  })
})
