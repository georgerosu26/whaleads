import { BarChart3 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { localDate } from '../../../src/daytime'
import { EmptyState } from '@/components/EmptyState'
import { ErrorState } from '@/components/ErrorState'
import { PageHeader } from '@/components/PageHeader'
import { BarChart } from '@/components/reports/BarChart'
import { Kpi, KpiSkeleton } from '@/components/reports/Kpi'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuth } from '@/lib/auth'
import { useLoad } from '@/lib/useLoad'
import { cn } from '@/lib/utils'

interface SourceRow { key: string; label: string; leads: number; won: number; lost: number; conversion: number; campaigns?: { source_id: string; headline: string | null; leads: number; won: number; lost: number }[] }
interface Overview {
  range: { from: string; to: string; timezone: string; days: number }
  totals: { leads: number; won: number; lost: number; open: number; conversion: number; win_rate: number; responded: number; median_first_response_s: number | null; p90_first_response_s: number | null; unanswered_now: number }
  by_source: SourceRow[]
  by_stage: { key: string; label: string; kind: string; leads: number }[]
  weekly: { week_start: string; label: string; leads: number; messages_in: number; messages_out: number }[]
  by_staff: { id: number | null; name: string; leads: number; won: number; responded: number; median_first_response_s: number | null }[]
  truncated: boolean
}

export const fmtDuration = (s: number | null) => {
  if (s === null) return 'None yet'
  if (s < 90) return `${Math.round(s)} s`
  if (s < 5400) return `${Math.round(s / 60)} min`
  if (s < 172800) return `${Math.round(s / 360) / 10} h`
  return `${Math.round(s / 8640) / 10} d`
}
const pct = (n: number) => `${Math.round(n * 1000) / 10}%`
const addDays = (ymd: string, n: number) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10) }
const PRESETS = [7, 30, 90] as const

function Table({ caption, head, rows, empty }: { caption: string; head: string[]; rows: (string | number | JSX.Element)[][]; empty: string }) {
  return (
    <section className="mb-4 rounded-lg border bg-surface p-4">
      <h2 className="mb-2 text-base font-semibold">{caption}</h2>
      {rows.length === 0 ? <p className="py-4 text-sm text-muted-foreground">{empty}</p> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[320px] text-sm">
            <thead><tr className="border-b text-left text-muted-foreground">{head.map((h, i) => <th key={h} className={cn('py-2 font-semibold', i === 0 ? 'pr-3' : 'px-2 text-right')}>{h}</th>)}</tr></thead>
            <tbody>{rows.map((r, ri) => <tr key={ri} className="border-b last:border-0">{r.map((c, i) => <td key={i} className={cn('py-2', i === 0 ? 'max-w-[14rem] truncate pr-3' : 'px-2 text-right')}>{c}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )}
    </section>
  )
}

export default function Reports() {
  const { state } = useAuth()
  const tz = state.status === 'in' ? state.me.timezone : 'UTC'
  const today = useMemo(() => localDate(Math.floor(Date.now() / 1000), tz), [tz])
  const [preset, setPreset] = useState<number | 'custom'>(30)
  const [custom, setCustom] = useState({ from: addDays(today, -29), to: today })
  const [applied, setApplied] = useState({ from: addDays(today, -29), to: today })
  const range = preset === 'custom' ? applied : { from: addDays(today, 1 - preset), to: today }
  const { state: load, reload } = useLoad<Overview>(`/api/reports/overview?from=${range.from}&to=${range.to}`)
  const badCustom = custom.from > custom.to

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Reports" subtitle={load.status === 'ready' ? `${load.data.range.from} to ${load.data.range.to} (${load.data.range.timezone})` : undefined} />
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <div role="group" aria-label="Date range" className="flex gap-1">
          {PRESETS.map((d) => <Button key={d} variant={preset === d ? 'primary' : 'secondary'} aria-pressed={preset === d} onClick={() => setPreset(d)}>{d} days</Button>)}
          <Button variant={preset === 'custom' ? 'primary' : 'secondary'} aria-pressed={preset === 'custom'} onClick={() => setPreset('custom')}>Custom</Button>
        </div>
        {preset === 'custom' && (
          <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (!badCustom) setApplied(custom) }}>
            <label className="text-xs font-semibold">From<Input type="date" className="mt-1 w-40" value={custom.from} max={custom.to} onChange={(e) => setCustom({ ...custom, from: e.target.value })} /></label>
            <label className="text-xs font-semibold">To<Input type="date" className="mt-1 w-40" value={custom.to} max={today} onChange={(e) => setCustom({ ...custom, to: e.target.value })} /></label>
            <Button type="submit" disabled={badCustom || !custom.from || !custom.to}>Apply</Button>
          </form>
        )}
      </div>

      {load.status === 'loading' && (
        <div aria-busy="true" aria-label="Loading reports">
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">{Array.from({ length: 5 }, (_, i) => <KpiSkeleton key={i} />)}</div>
          <Skeleton className="mb-4 h-60" /><Skeleton className="mb-4 h-60" /><Skeleton className="h-40" />
        </div>
      )}
      {load.status === 'error' && <ErrorState message={load.message} onRetry={() => void reload()} />}
      {load.status === 'ready' && (() => {
        const d = load.data, t = d.totals
        const nothing = t.leads === 0 && d.weekly.every((w) => w.messages_in + w.messages_out === 0)
        if (nothing) return <EmptyState icon={BarChart3} title="No activity in this range" body="Leads and messages show up here as they arrive. Try a longer range." action={<Button variant="secondary" onClick={() => setPreset(90)}>Show 90 days</Button>} />
        return (
          <>
            {d.truncated && <p role="status" className="mb-3 rounded-md border bg-muted px-3 py-2 text-sm">This range has more leads than reports can read at once. Numbers cover the earliest part of it; pick a shorter range.</p>}
            <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
              <Kpi label="New leads" value={t.leads.toLocaleString()} hint={`${t.open} still open`} />
              <Kpi label="Won" value={t.won.toLocaleString()} hint={`${t.lost} lost`} />
              <Kpi label="Conversion" value={pct(t.conversion)} hint="won of new leads" />
              <Kpi label="First response" value={fmtDuration(t.median_first_response_s)} hint={t.p90_first_response_s !== null ? `median, 90% within ${fmtDuration(t.p90_first_response_s)}` : 'median'} />
              <Kpi label="Unanswered now" value={t.unanswered_now.toLocaleString()} hint="open chats waiting on us" />
            </div>
            <BarChart title="New leads per week" unit="Leads created, weeks start on Monday" series={[{ key: 'leads', label: 'New leads', color: 'var(--series-1)' }]} groups={d.weekly.map((w) => ({ label: w.label, title: w.week_start, values: [w.leads] }))} />
            <BarChart title="Messages per week" unit="WhatsApp messages received and sent" series={[{ key: 'in', label: 'Received', color: 'var(--series-1)' }, { key: 'out', label: 'Sent', color: 'var(--series-2)' }]} groups={d.weekly.map((w) => ({ label: w.label, title: w.week_start, values: [w.messages_in, w.messages_out] }))} />
            <Table caption="By source" head={['Source', 'Leads', 'Won', 'Lost', 'Conv.']} empty="No leads in this range." rows={d.by_source.map((s) => [s.label, s.leads, s.won, s.lost, pct(s.conversion)])} />
            {d.by_source.some((s) => s.campaigns?.length) && (
              <Table caption="Ads" head={['Ad', 'Leads', 'Won', 'Lost']} empty="" rows={d.by_source.flatMap((s) => s.campaigns ?? []).map((c) => [<Link key={c.source_id} className="font-semibold underline-offset-2 hover:underline" to={`/leads?campaign=${encodeURIComponent(c.source_id)}`} title={c.source_id}>{c.headline || c.source_id}</Link>, c.leads, c.won, c.lost])} />
            )}
            <Table caption="By stage" head={['Stage', 'Leads']} empty="No leads in this range." rows={d.by_stage.map((s) => [s.label, s.leads])} />
            <Table caption="By team member" head={['Owner', 'Leads', 'Won', 'Replied', 'Median reply']} empty="No leads in this range." rows={d.by_staff.map((s) => [s.name, s.leads, s.won, s.responded, fmtDuration(s.median_first_response_s)])} />
          </>
        )
      })()}
    </div>
  )
}
