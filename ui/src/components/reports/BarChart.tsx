import { useEffect, useId, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

export interface Series { key: string; label: string; color: string }
export interface Group { label: string; title: string; values: number[] }

const H = 180, TOP = 12, BOT = 28, LEFT = 36, MIN_STEP = 56, MAX_STEP = 96, GAP = 2

const niceMax = (m: number) => {
  if (m <= 4) return 4
  const p = 10 ** Math.floor(Math.log10(m)), f = m / p
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p
}
// a bar with a 4px rounded top and a flat baseline
const barPath = (x: number, y: number, w: number, h: number) => {
  const r = Math.min(4, w / 2, h)
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`
}

export function BarChart({ title, series, groups, unit }: { title: string; series: Series[]; groups: Group[]; unit: string }) {
  const [active, setActive] = useState<number | null>(null)
  const [table, setTable] = useState(false)
  const id = useId()
  const total = groups.reduce((a, g) => a + g.values.reduce((x, v) => x + v, 0), 0)
  const box = useRef<HTMLDivElement>(null)
  const [cw, setCw] = useState(0)
  useEffect(() => {
    const el = box.current
    if (!el) return
    setCw(el.clientWidth)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setCw(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [table, total === 0])
  const max = niceMax(Math.max(0, ...groups.flatMap((g) => g.values)))
  const STEP = Math.min(MAX_STEP, Math.max(MIN_STEP, (cw - LEFT - 8) / Math.max(1, groups.length)))
  const width = Math.max(320, LEFT + groups.length * STEP + 8)
  const plotH = H - TOP - BOT
  const y = (v: number) => TOP + plotH - (v / max) * plotH
  const slot = STEP - 12
  const barW = (slot - GAP * (series.length - 1)) / series.length
  const ticks = [0, max / 2, max]
  const act = active !== null ? groups[active] : null

  return (
    <section className="mb-4 rounded-lg border bg-surface p-4" aria-labelledby={`${id}-t`}>
      <div className="mb-2 flex items-start justify-between gap-2">
        <h2 id={`${id}-t`} className="text-base font-semibold">{title}</h2>
        <button type="button" onClick={() => setTable((t) => !t)} aria-pressed={table} className="min-h-[40px] shrink-0 rounded-md px-3 text-sm font-semibold text-muted-foreground hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
          {table ? 'Show chart' : 'Show table'}
        </button>
      </div>
      {series.length > 1 && (
        <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1" aria-label="Legend">
          {series.map((s) => <li key={s.key} className="flex items-center gap-2 text-sm"><span aria-hidden className="inline-block h-3 w-3 rounded-sm" style={{ background: s.color }} />{s.label}</li>)}
        </ul>
      )}
      {total === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">Nothing to chart in this range.</p>
      ) : table ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[280px] text-sm">
            <thead><tr className="border-b text-left text-muted-foreground"><th className="py-2 pr-3 font-semibold">Week of</th>{series.map((s) => <th key={s.key} className="px-2 py-2 text-right font-semibold">{s.label}</th>)}</tr></thead>
            <tbody>{groups.map((g) => <tr key={g.title} className="border-b last:border-0"><td className="py-2 pr-3">{g.title}</td>{g.values.map((v, i) => <td key={i} className="px-2 py-2 text-right">{v.toLocaleString()}</td>)}</tr>)}</tbody>
          </table>
        </div>
      ) : (
        <div ref={box} className="overflow-x-auto" tabIndex={0} aria-label={`${title}, scrolls sideways`}>
          <div className="relative" style={{ width, height: H }} onMouseLeave={() => setActive(null)}>
            <svg width={width} height={H} role="img" aria-label={`${title}. ${groups.map((g) => `${g.title}: ${g.values.map((v, i) => `${v} ${series[i].label}`).join(', ')}`).join('; ')}`}>
              {ticks.map((t) => (
                <g key={t}>
                  <line x1={LEFT} x2={width} y1={y(t)} y2={y(t)} stroke="hsl(var(--border))" strokeWidth={1} />
                  <text x={LEFT - 6} y={y(t) + 4} textAnchor="end" fontSize={11} fill="hsl(var(--muted-foreground))">{Math.round(t)}</text>
                </g>
              ))}
              {groups.map((g, gi) => {
                const x0 = LEFT + gi * STEP + 6
                return (
                  <g key={g.title}>
                    {g.values.map((v, si) => v > 0 && <path key={si} d={barPath(x0 + si * (barW + GAP), y(v), barW, y(0) - y(v))} fill={series[si].color} opacity={active === null || active === gi ? 1 : 0.55} />)}
                    <text x={x0 + slot / 2} y={H - 10} textAnchor="middle" fontSize={11} fill="hsl(var(--muted-foreground))">{g.label}</text>
                    <rect x={LEFT + gi * STEP} y={TOP} width={STEP} height={H - TOP} fill="transparent" tabIndex={0} role="img"
                      aria-label={`${g.title}: ${g.values.map((v, i) => `${v} ${series[i].label}`).join(', ')}`}
                      onMouseEnter={() => setActive(gi)} onFocus={() => setActive(gi)} onBlur={() => setActive(null)} />
                  </g>
                )
              })}
            </svg>
            {act && active !== null && (
              <div role="status" className={cn('pointer-events-none absolute z-10 w-40 rounded-md border bg-surface p-2 text-xs shadow-md')} style={{ top: 0, left: Math.min(Math.max(LEFT + active * STEP - 40, LEFT), width - 164) }}>
                <div className="mb-1 font-semibold">Week of {act.title}</div>
                {act.values.map((v, i) => <div key={i} className="flex items-center justify-between gap-2"><span className="flex items-center gap-1.5"><span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: series[i].color }} />{series[i].label}</span><span className="font-semibold">{v.toLocaleString()}</span></div>)}
              </div>
            )}
          </div>
        </div>
      )}
      <p className="mt-1 text-xs text-muted-foreground">{unit}</p>
    </section>
  )
}
