import { cn } from '@/lib/utils'
import type { Stage } from '@/lib/crm'

/** Every active stage as a chip; the current one is filled. One tap moves the lead (lost stages ask for a reason first). */
export function StageStepper({ stages, current, onPick, disabled }: { stages: Stage[]; current: string; onPick: (s: Stage) => void; disabled?: boolean }) {
  return (
    <div role="group" aria-label="Stage" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
      {stages.map((s) => (
        <button
          key={s.key} type="button" disabled={disabled} aria-pressed={s.key === current} onClick={() => s.key !== current && onPick(s)}
          className={cn('min-h-[40px] shrink-0 rounded-full border px-4 text-sm font-semibold transition-colors disabled:opacity-60',
            s.key === current
              ? s.kind === 'won' ? 'border-green-600 bg-green-600 text-white' : s.kind === 'lost' ? 'border-foreground bg-foreground text-surface' : 'border-accent bg-accent text-accent-foreground'
              : 'bg-surface hover:bg-muted')}
        >{s.label}</button>
      ))}
    </div>
  )
}
