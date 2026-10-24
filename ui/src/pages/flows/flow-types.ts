// Node catalogue for the editor: labels, ports, geometry and the one-line card summary. Pure (no React), so the
// serialiser and its tests can use it. Contract constants come from the engine's own types.
import { OUTPUT_PORTS } from '../../../../src/flows/types'
import type { FlowNode, FlowNodePort, NodeType } from '../../lib/flows'

export const PORT_LABEL: Record<string, string> = {
  out: 'Next', yes: 'Yes', no: 'No', success: 'Success', error: 'On error', completed: 'Replied', timeout: 'No reply', window_closed: 'Window closed',
}

export interface NodeMeta { label: string; hint: string; tone: string }
export const NODE_META: Record<NodeType, NodeMeta> = {
  trigger: { label: 'Trigger', hint: 'What starts the flow', tone: 'coral' },
  message: { label: 'Send message', hint: 'Free text inside the 24 h window', tone: 'blue' },
  template: { label: 'Send template', hint: 'Approved template, any time', tone: 'teal' },
  condition: { label: 'Condition', hint: 'Branch yes / no', tone: 'violet' },
  action: { label: 'Update lead', hint: 'Stage, tag, owner, note', tone: 'green' },
  delay: { label: 'Delay', hint: 'Wait, then continue', tone: 'amber' },
  wait_event: { label: 'Wait for reply', hint: 'Park until they answer', tone: 'neutral' },
  variable: { label: 'Set variable', hint: 'Keep a value for later nodes', tone: 'blue' },
  lead_writeback: { label: 'Rate and close', hint: 'Score the lead, set a stage', tone: 'green' },
  ai: { label: 'AI answer', hint: 'Ask the model, keep the reply', tone: 'pink' },
  http_request: { label: 'HTTP request', hint: 'Call another system', tone: 'teal' },
}

/** Palette order. `trigger` is created with the flow, never from the palette. */
export const PALETTE: NodeType[] = ['message', 'template', 'condition', 'action', 'delay', 'wait_event', 'variable', 'lead_writeback', 'ai', 'http_request']

export const NODE_W = 220
export const HEAD_H = 36
export const DESC_H = 40
export const ROW_H = 24
export const PAD_B = 8

export const inputPort = (): FlowNodePort => ({ id: 'in', label: 'In', type: 'input' })
export function portsFor(type: NodeType): FlowNodePort[] {
  const outs = OUTPUT_PORTS[type].map((id): FlowNodePort => ({ id, label: PORT_LABEL[id] ?? id, type: 'output' }))
  return type === 'trigger' ? outs : [inputPort(), ...outs]
}
export const outputsOf = (n: FlowNode): FlowNodePort[] => n.ports.filter((p) => p.type === 'output')
export const nodeHeight = (n: Pick<FlowNode, 'ports'>) => HEAD_H + DESC_H + n.ports.filter((p) => p.type === 'output').length * ROW_H + PAD_B

/** Where a port's dot sits, in graph coordinates. */
export function portPos(n: FlowNode, port: FlowNodePort): { x: number; y: number } {
  if (port.type === 'input') return { x: n.x, y: n.y + HEAD_H / 2 }
  const i = Math.max(0, outputsOf(n).findIndex((p) => p.id === port.id))
  return { x: n.x + n.width, y: n.y + HEAD_H + DESC_H + i * ROW_H + ROW_H / 2 }
}

export function defaultData(type: NodeType): Record<string, unknown> {
  switch (type) {
    case 'message': return { text: '' }
    case 'template': return { templateId: '', templateName: '', bodyParams: [], headerParams: [] }
    case 'condition': return { left: 'user_response', operator: 'contains', value: '' }
    case 'action': return { actionType: 'add_tag', tag: '' }
    case 'delay': return { duration: 1, unit: 'hours' }
    case 'wait_event': return { timeout: 24, timeoutUnit: 'hours' }
    case 'variable': return { variableName: '', operation: 'set', value: '' }
    case 'lead_writeback': return { verdict: '', stage: '' }
    case 'ai': return { systemPrompt: '', prompt: '', outputVariable: 'ai_answer', maxTokens: 300 }
    case 'http_request': return { method: 'GET', url: '', headers: [], body: '', outputVariable: '' }
    default: return {}
  }
}

export function nextNodeId(nodes: FlowNode[], type: NodeType, floor = 1): string {
  const ids = new Set(nodes.map((n) => n.id))
  for (let i = Math.max(1, floor); ; i++) { const id = `${type}_${i}`; if (!ids.has(id)) return id }
}

export function createNode(type: NodeType, nodes: FlowNode[], x: number, y: number, floor = 1): FlowNode {
  const n: FlowNode = { id: nextNodeId(nodes, type, floor), type, label: NODE_META[type].label, x, y, width: NODE_W, height: 0, data: defaultData(type), ports: portsFor(type) }
  n.height = nodeHeight(n)
  return n
}

/** Variables a `{{ }}` token can read: the lead snapshot, the contact, business hours, and the incoming text. */
export const FLOW_VARIABLES: { token: string; label: string }[] = [
  { token: 'lead.name', label: 'Lead name' }, { token: 'lead.phone', label: 'Lead phone' }, { token: 'lead.stage', label: 'Lead stage' },
  { token: 'lead.source', label: 'Lead source' }, { token: 'contact.email', label: 'Contact email' }, { token: 'business.open', label: 'Open now' },
  { token: 'user_response', label: 'Latest message text' },
]

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}...` : s)
const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v))

/** The one or two lines on a node card. */
export function describeNode(n: FlowNode): string {
  const d = n.data as Record<string, any>
  switch (n.type) {
    case 'trigger':
      if (d.kind === 'lead_created') return 'When a lead is created'
      if (d.kind === 'stage_changed') return 'When a lead changes stage'
      if (d.kind === 'message_received') return d.match === 'keyword' && d.keywords?.length ? `Message with: ${clip(d.keywords.join(', '), 40)}` : d.match === 'regex' ? `Message matching ${clip(str(d.regexPattern), 30)}` : 'When a message arrives'
      return 'Choose what starts this flow'
    case 'message': return str(d.text).trim() ? clip(str(d.text), 70) : 'Write the message'
    case 'template': return str(d.templateName) ? `Template: ${clip(str(d.templateName), 40)}` : 'Pick a template'
    case 'condition': return `${str(d.left) || 'user_response'} ${str(d.operator).replace(/_/g, ' ') || 'contains'} ${clip(str(d.value), 24)}`.trim()
    case 'action':
      switch (d.actionType) {
        case 'set_stage': return `Move to ${str(d.stage) || '...'}`
        case 'add_tag': return `Add tag ${str(d.tag) || '...'}`
        case 'remove_tag': return `Remove tag ${str(d.tag) || '...'}`
        case 'assign': return d.staffId ? 'Assign to a teammate' : 'Unassign'
        case 'note': return clip(`Note: ${str(d.text)}`, 70)
        case 'set_next_action': return `Next action in ${str(d.duration)} ${str(d.unit) || 'hours'}`
        default: return 'Choose an action'
      }
    case 'delay': return `Wait ${str(d.duration) || '?'} ${str(d.unit) || 'minutes'}`
    case 'wait_event': return `Wait up to ${str(d.timeout) || '24'} ${str(d.timeoutUnit) || 'hours'} for a reply`
    case 'variable': return str(d.variableName) ? `${str(d.operation) || 'set'} ${str(d.variableName)}` : 'Name the variable'
    case 'lead_writeback': return str(d.stage) ? `Close into ${str(d.stage)}` : str(d.verdict) ? `Verdict: ${str(d.verdict)}` : 'Rate the lead'
    case 'ai': return str(d.prompt).trim() ? clip(str(d.prompt), 70) : 'Write the prompt'
    case 'http_request': return str(d.url) ? `${str(d.method) || 'GET'} ${clip(str(d.url).replace(/^https?:\/\//, ''), 36)}` : 'Enter a URL'
    default: return ''
  }
}
