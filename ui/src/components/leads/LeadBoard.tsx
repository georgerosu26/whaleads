import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { dueLabel, leadName, stageTone, type LeadT, type Stage } from '@/lib/crm'
import { showPhone } from '@/lib/inbox'
import { cn } from '@/lib/utils'

export interface BoardColumn { stage: Stage; count: number; leads: LeadT[]; next_before: string | null }

export function BoardSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading board" className="flex gap-3 overflow-hidden">
      {[0, 1, 2].map((i) => <div key={i} className="w-[78vw] shrink-0 space-y-2 md:w-72"><Skeleton className="h-6 w-24" /><Skeleton className="h-20" /><Skeleton className="h-20" /></div>)}
    </div>
  )
}

function Card({ lead, stages, tz, onMove }: { lead: LeadT; stages: Stage[]; tz: string; onMove: (lead: LeadT, to: Stage) => void }) {
  const due = lead.next_action_at ? dueLabel(lead.next_action_at, tz) : null
  return (
    <div className="rounded-lg border bg-surface p-3">
      <Link to={`/leads/${lead.id}`} className="block min-w-0">
        <span className="block truncate text-sm font-semibold">{leadName(lead)}</span>
        {lead.name && <span className="block truncate text-xs text-muted-foreground">{showPhone(lead.phone ?? lead.wa_id)}</span>}
        {lead.message && <span className="mt-1 line-clamp-2 break-words text-xs text-muted-foreground">{lead.message}</span>}
      </Link>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {lead.tags.slice(0, 2).map((t) => <Badge key={t.id} tone={t.color}>{t.label}</Badge>)}
        {due && <span className={cn('text-xs font-semibold', due.overdue ? 'text-danger' : 'text-muted-foreground')}>{due.text}</span>}
      </div>
      <Select aria-label={`Move ${leadName(lead)} to another stage`} className="mt-2 min-h-[36px] text-sm" value="" onChange={(e) => { const s = stages.find((x) => x.key === e.target.value); if (s) onMove(lead, s) }}>
        <option value="">Move to...</option>
        {stages.filter((s) => s.key !== lead.status).map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
      </Select>
    </div>
  )
}

export function LeadBoard({ columns, stages, tz, query, onMove, onChange }: {
  columns: BoardColumn[]; stages: Stage[]; tz: string; query: string; onMove: (lead: LeadT, to: Stage) => void; onChange: (c: BoardColumn[]) => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const scrollBy = (dir: number) => scroller.current?.scrollBy({ left: dir * 300, behavior: 'smooth' })
  const more = async (col: BoardColumn) => {
    setBusy(col.stage.key); setErr(null)
    try {
      const r = await api<{ leads: LeadT[]; next_before: string | null }>(`/api/leads?${query}&stage=${encodeURIComponent(col.stage.key)}&limit=30&before=${col.next_before}`)
      onChange(columns.map((c) => (c.stage.key === col.stage.key ? { ...c, leads: [...c.leads, ...r.leads], next_before: r.next_before } : c)))
    } catch (e) { setErr((e as Error).message) } finally { setBusy(null) }
  }
  return (
    <div>
      {err && <p role="alert" className="mb-2 text-sm text-danger">{err}</p>}
      <div className="mb-2 hidden items-center justify-end gap-2 md:flex">
        <span className="text-xs text-muted-foreground">{columns.length} stages, scroll sideways for the rest</span>
        <Button variant="secondary" aria-label="Scroll stages left" onClick={() => scrollBy(-1)}>&larr;</Button>
        <Button variant="secondary" aria-label="Scroll stages right" onClick={() => scrollBy(1)}>&rarr;</Button>
      </div>
      <div ref={scroller} data-testid="board" className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-scroll px-4 pb-4 md:mx-0 md:px-0 [scrollbar-color:hsl(var(--muted-foreground)/0.5)_transparent]">
        {columns.map((col) => (
          <section key={col.stage.key} aria-label={col.stage.label} className="w-[78vw] max-w-xs shrink-0 snap-start rounded-xl bg-muted/50 p-2 md:w-72">
            <h2 className="mb-2 flex items-center justify-between gap-2 px-1 text-sm font-bold">
              <span className="truncate">{col.stage.label}</span>
              <Badge tone={stageTone(col.stage.kind)}>{col.count}</Badge>
            </h2>
            <div className="space-y-2">
              {col.leads.length === 0 && <p className="rounded-lg border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">Nothing here</p>}
              {col.leads.map((l) => <Card key={l.id} lead={l} stages={stages} tz={tz} onMove={onMove} />)}
              {col.next_before && <Button variant="ghost" className="w-full" loading={busy === col.stage.key} onClick={() => void more(col)}>Show more</Button>}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
