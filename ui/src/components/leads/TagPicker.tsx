import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { Tag } from '@/lib/crm'

/** Toggle chips for the admin-defined tags. Tags themselves are managed in Settings > Pipeline. */
export function TagPicker({ all, selected, onChange, disabled }: { all: Tag[]; selected: number[]; onChange: (ids: number[]) => void; disabled?: boolean }) {
  if (!all.length) return <p className="text-sm text-muted-foreground">No tags yet. An admin can add them in Settings.</p>
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Tags">
      {all.map((t) => {
        const on = selected.includes(t.id)
        return (
          <button key={t.id} type="button" disabled={disabled} aria-pressed={on} onClick={() => onChange(on ? selected.filter((x) => x !== t.id) : [...selected, t.id])}
            className={cn('min-h-[36px] rounded-full border px-1 transition-opacity disabled:opacity-60', on ? 'border-foreground' : 'opacity-60 hover:opacity-100')}>
            <Badge tone={t.color}>{on ? '✓ ' : ''}{t.label}</Badge>
          </button>
        )
      })}
    </div>
  )
}
