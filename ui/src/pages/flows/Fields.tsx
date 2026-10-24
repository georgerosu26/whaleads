import { Plus, X } from 'lucide-react'
import { forwardRef, useRef, type ReactNode } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { FLOW_VARIABLES } from './flow-types'

export function F({ label, hint, error, id, children }: { label: string; hint?: ReactNode; error?: string | null; id: string; children: ReactNode }) {
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? <p role="alert" className="mt-1 text-xs text-danger">{error}</p> : hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

export const Area = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...p }, ref) => (
  <textarea ref={ref} className={cn('min-h-[88px] w-full rounded-md border bg-surface px-3 py-2 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60', className)} {...p} />
))
Area.displayName = 'Area'

/** A text area with an "Insert variable" menu: drops `{{token}}` at the caret. */
export function VarArea({ id, value, onChange, extra, rows = 4, disabled, placeholder }: { id: string; value: string; onChange: (v: string) => void; extra: string[]; rows?: number; disabled?: boolean; placeholder?: string }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const insert = (token: string) => {
    const el = ref.current; if (!token) return
    const a = el?.selectionStart ?? value.length, b = el?.selectionEnd ?? value.length
    const t = `{{${token}}}`
    onChange(value.slice(0, a) + t + value.slice(b))
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(a + t.length, a + t.length) })
  }
  return (
    <div className="space-y-1.5">
      <Area id={id} ref={ref} rows={rows} value={value} disabled={disabled} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      {!disabled && <VarMenu extra={extra} onPick={insert} />}
    </div>
  )
}

export function VarMenu({ extra, onPick }: { extra: string[]; onPick: (t: string) => void }) {
  return (
    <Select aria-label="Insert variable" value="" className="min-h-[32px] text-xs" onChange={(e) => onPick(e.target.value)}>
      <option value="">Insert variable...</option>
      <optgroup label="Lead and message">{FLOW_VARIABLES.map((v) => <option key={v.token} value={v.token}>{v.label} ({v.token})</option>)}</optgroup>
      {extra.length > 0 && <optgroup label="From earlier steps">{extra.map((t) => <option key={t} value={t}>{t}</option>)}</optgroup>}
    </Select>
  )
}

/** A text input that can take `{{token}}`s through the same menu. */
export function VarInput({ id, value, onChange, extra, disabled, placeholder }: { id: string; value: string; onChange: (v: string) => void; extra: string[]; disabled?: boolean; placeholder?: string }) {
  return (
    <div className="space-y-1.5">
      <Input id={id} value={value} disabled={disabled} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      {!disabled && <VarMenu extra={extra} onPick={(t) => onChange(`${value}{{${t}}}`)} />}
    </div>
  )
}

export function RowList<T>({ rows, onChange, blank, render, addLabel, disabled, max = 20 }: { rows: T[]; onChange: (r: T[]) => void; blank: T; render: (row: T, set: (patch: Partial<T>) => void, i: number) => ReactNode; addLabel: string; disabled?: boolean; max?: number }) {
  return (
    <div className="space-y-2">
      {rows.map((r, i) => (
        <div key={i} className="flex items-start gap-2 rounded-md border bg-background p-2">
          <div className="min-w-0 flex-1 space-y-2">{render(r, (patch) => onChange(rows.map((x, j) => (j === i ? { ...x, ...patch } : x))), i)}</div>
          {!disabled && <button type="button" aria-label="Remove row" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted" onClick={() => onChange(rows.filter((_, j) => j !== i))}><X aria-hidden className="h-4 w-4" /></button>}
        </div>
      ))}
      {!disabled && rows.length < max && <button type="button" className="inline-flex min-h-[32px] items-center gap-1 text-xs font-semibold text-accent" onClick={() => onChange([...rows, blank])}><Plus aria-hidden className="h-3.5 w-3.5" />{addLabel}</button>}
    </div>
  )
}

/** Multi-select as toggle chips (stages, sources). */
export function Chips({ options, value, onChange, disabled, label }: { options: { value: string; label: string }[]; value: string[]; onChange: (v: string[]) => void; disabled?: boolean; label: string }) {
  if (!options.length) return <p className="text-xs text-muted-foreground">None set up yet.</p>
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = value.includes(o.value)
        return <button key={o.value} type="button" disabled={disabled} aria-pressed={on} onClick={() => onChange(on ? value.filter((x) => x !== o.value) : [...value, o.value])} className={cn('min-h-[32px] rounded-full border px-3 text-xs font-semibold disabled:opacity-60', on ? 'border-accent bg-accent/15 text-accent' : 'bg-surface text-muted-foreground hover:bg-muted')}>{o.label}</button>
      })}
    </div>
  )
}
