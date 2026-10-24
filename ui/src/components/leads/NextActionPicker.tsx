import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { epochToInputs, inputsToEpoch, presetEpoch } from '@/lib/crm'

const PRESETS = [['today', 'Today'], ['tomorrow', 'Tomorrow'], ['3d', 'In 3 days'], ['week', 'Next week']] as const

/** Preset chips plus date and time inputs, all in the instance timezone. Calls onChange with unix seconds or null. */
export function NextActionPicker({ value, tz, onChange, disabled }: { value: number | null; tz: string; onChange: (v: number | null) => void; disabled?: boolean }) {
  const cur = epochToInputs(value, tz)
  const [date, setDate] = useState(cur.date)
  const [time, setTime] = useState(cur.time)
  const apply = (d: string, t: string) => { if (!d) return; const e = inputsToEpoch(d, t, tz); if (e) onChange(e) }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {PRESETS.map(([k, label]) => (
          <button key={k} type="button" disabled={disabled} onClick={() => { const e = presetEpoch(k, tz); const i = epochToInputs(e, tz); setDate(i.date); setTime(i.time); onChange(e) }}
            className="min-h-[36px] rounded-full border bg-surface px-3 text-xs font-semibold hover:bg-muted disabled:opacity-60">{label}</button>
        ))}
        {value !== null && <button type="button" disabled={disabled} onClick={() => { setDate(''); onChange(null) }} className="min-h-[36px] rounded-full px-3 text-xs font-semibold text-danger hover:bg-muted disabled:opacity-60">Clear</button>}
      </div>
      <div className="flex gap-2">
        <Input type="date" aria-label="Next action date" value={date} disabled={disabled} onChange={(e) => { setDate(e.target.value); apply(e.target.value, time) }} />
        <Input type="time" aria-label="Next action time" className="max-w-[8rem]" value={time} disabled={disabled} onChange={(e) => { setTime(e.target.value); apply(date, e.target.value) }} />
      </div>
    </div>
  )
}
