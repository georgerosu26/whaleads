import type { NodeType } from '@/lib/flows'
import { cn } from '@/lib/utils'
import { NODE_ICON } from './canvas/CanvasNode'
import { NODE_DRAG_MIME } from './canvas/FlowCanvas'
import { NODE_META, PALETTE } from './flow-types'

export function NodePalette({ onAdd, disabled, aiConfigured }: { onAdd: (t: NodeType) => void; disabled: boolean; aiConfigured: boolean | null }) {
  return (
    <nav aria-label="Add a step" className="flex flex-col gap-1 p-2" data-testid="palette">
      <h2 className="px-2 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Add a step</h2>
      {PALETTE.map((t) => {
        const Icon = NODE_ICON[t]
        const m = NODE_META[t]
        return (
          <button
            key={t} type="button" disabled={disabled} draggable={!disabled} data-testid={`palette-${t}`}
            onDragStart={(e) => { e.dataTransfer.setData(NODE_DRAG_MIME, t); e.dataTransfer.effectAllowed = 'copy' }}
            onClick={() => onAdd(t)}
            className={cn('flex min-h-[44px] items-center gap-2 rounded-md border bg-surface px-2 text-left hover:bg-muted disabled:opacity-50', !disabled && 'cursor-grab')}
          >
            <Icon aria-hidden className="h-4 w-4 shrink-0 text-accent" />
            <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{m.label}</span><span className="block truncate text-xs text-muted-foreground">{t === 'ai' && aiConfigured === false ? 'Needs an AI key' : m.hint}</span></span>
          </button>
        )
      })}
    </nav>
  )
}
