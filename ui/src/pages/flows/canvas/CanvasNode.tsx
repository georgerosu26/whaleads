import { memo } from 'react'
import { AlertTriangle, Brain, Clock, Cog, FileText, Globe, GitBranch, Hourglass, MessageSquare, Target, Variable, Zap, type LucideIcon } from 'lucide-react'
import { TAG_STYLES } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { FlowNode, NodeType } from '@/lib/flows'
import { DESC_H, HEAD_H, NODE_META, PORT_LABEL, ROW_H, describeNode, outputsOf } from '../flow-types'

export const NODE_ICON: Record<NodeType, LucideIcon> = {
  trigger: Zap, message: MessageSquare, template: FileText, condition: GitBranch, action: Cog, delay: Clock, wait_event: Hourglass,
  variable: Variable, lead_writeback: Target, ai: Brain, http_request: Globe,
}

export type TraceTone = 'ok' | 'awaiting' | 'skipped' | 'failed'
interface Props {
  node: FlowNode
  selected: boolean
  /** Hard errors on this node (red) and soft warnings (amber). */
  errors: string[]
  warnings: string[]
  /** Output ports with nothing connected. */
  loose: string[]
  /** Set while a connection is being dragged: the node is a valid drop target. */
  dropTarget: boolean
  trace?: TraceTone
  readOnly: boolean
}

function CanvasNodeView({ node, selected, errors, warnings, loose, dropTarget, trace, readOnly }: Props) {
  const Icon = NODE_ICON[node.type] ?? Cog
  const meta = NODE_META[node.type]
  const outs = outputsOf(node)
  const bad = errors.length > 0
  const warn = warnings.length > 0
  return (
    <div
      data-node-id={node.id}
      data-node-type={node.type}
      data-selected={selected || undefined}
      aria-label={`${node.label}. ${describeNode(node)}`}
      className={cn(
        'absolute select-none rounded-lg border bg-surface shadow-sm',
        selected && 'ring-2 ring-accent',
        bad ? 'border-danger' : warn ? 'border-amber-500' : 'border',
        dropTarget && 'ring-2 ring-accent/60',
        trace === 'ok' && 'outline outline-2 outline-green-500',
        trace === 'failed' && 'outline outline-2 outline-danger',
        trace === 'awaiting' && 'outline outline-2 outline-amber-500',
        trace === 'skipped' && 'outline outline-2 outline-dashed outline-muted-foreground',
        readOnly ? 'cursor-default' : 'cursor-grab',
      )}
      style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
    >
      {node.type !== 'trigger' && (
        <span data-port-in={node.id} title="In" className="absolute -left-2.5 z-10 flex h-5 w-5 items-center justify-center rounded-full border-2 bg-surface hover:border-accent" style={{ top: HEAD_H / 2 - 10 }}>
          <span className="h-2 w-2 rounded-full bg-muted-foreground/50" />
        </span>
      )}
      <div data-drag className="flex items-center gap-2 border-b px-3" style={{ height: HEAD_H }}>
        <span className={cn('flex h-6 w-6 shrink-0 items-center justify-center rounded-md', TAG_STYLES[meta.tone] ?? TAG_STYLES.neutral)}><Icon aria-hidden className="h-3.5 w-3.5" /></span>
        <span className="min-w-0 flex-1 truncate text-xs font-bold">{node.label}</span>
        {(bad || warn) && <AlertTriangle aria-hidden className={cn('h-4 w-4 shrink-0', bad ? 'text-danger' : 'text-amber-600')} />}
      </div>
      <p data-drag className="line-clamp-2 px-3 py-1.5 text-xs leading-snug text-muted-foreground" style={{ height: DESC_H }}>{describeNode(node)}</p>
      {outs.map((p, i) => (
        <div key={p.id} className="relative flex items-center justify-end px-3 text-[11px] font-semibold text-muted-foreground" style={{ height: ROW_H }}>
          <span className={cn(loose.includes(p.id) && 'text-muted-foreground/70')}>{PORT_LABEL[p.id] ?? p.label}</span>
          <span
            data-port-out={`${node.id}:${p.id}`}
            title={PORT_LABEL[p.id] ?? p.label}
            className={cn('absolute -right-2.5 z-10 flex h-5 w-5 cursor-crosshair items-center justify-center rounded-full border-2 bg-surface hover:border-accent', loose.includes(p.id) ? 'border-dashed' : 'border-accent')}
            style={{ top: (ROW_H - 20) / 2 }}
            data-row={i}
          >
            <span className={cn('h-2 w-2 rounded-full', loose.includes(p.id) ? 'bg-muted-foreground/50' : 'bg-accent')} />
          </span>
        </div>
      ))}
    </div>
  )
}
export const CanvasNode = memo(CanvasNodeView)
