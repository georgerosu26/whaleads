import { CheckCircle2, ChevronDown, ChevronRight, CircleDashed, Hourglass, XCircle } from 'lucide-react'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import type { RunContext, TraceEntry } from '@/lib/flows'
import { NODE_META, PORT_LABEL } from './flow-types'

const STATUS: Record<TraceEntry['status'], { label: string; tone: string; icon: typeof CheckCircle2 }> = {
  ok: { label: 'Done', tone: 'green', icon: CheckCircle2 },
  skipped: { label: 'Skipped', tone: 'neutral', icon: CircleDashed },
  awaiting: { label: 'Waiting', tone: 'amber', icon: Hourglass },
  failed: { label: 'Failed', tone: 'coral', icon: XCircle },
}

const pretty = (v: unknown) => { try { return JSON.stringify(v, null, 2) } catch { return String(v) } }

/** The ordered steps of a run or a dry run: outcome, the port it left by, what it would have sent, and the variables at the end. */
export function TraceList({ trace, context, labelOf }: { trace: TraceEntry[]; context: RunContext | null; labelOf: (id: string) => string }) {
  const [open, setOpen] = useState<number | null>(null)
  const vars = Object.entries(context?.vars ?? {})
  if (!trace.length) return <p className="py-4 text-center text-sm text-muted-foreground">No steps ran.</p>
  return (
    <div className="space-y-3">
      <ol className="space-y-1.5" aria-label="Trace" data-testid="trace">
        {trace.map((t, i) => {
          const s = STATUS[t.status] ?? STATUS.ok
          const Icon = s.icon
          const out = context?.nodes?.[t.node]?.output
          const would = out && typeof out === 'object' && 'would' in out ? (out as { would: unknown }).would : undefined
          const expandable = out !== undefined && Object.keys(out).length > 0
          return (
            <li key={i} data-trace-node={t.node} data-trace-status={t.status} className="rounded-md border bg-surface">
              <button type="button" disabled={!expandable} aria-expanded={expandable ? open === i : undefined} onClick={() => setOpen(open === i ? null : i)} className="flex min-h-[44px] w-full items-center gap-2 px-3 py-2 text-left disabled:cursor-default">
                <span className="w-5 shrink-0 text-xs text-muted-foreground">{i + 1}</span>
                <Icon aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{t.type === 'engine' ? 'Engine' : labelOf(t.node)}</span>
                  <span className="block truncate text-xs text-muted-foreground">{t.type === 'engine' ? t.node : NODE_META[t.type]?.label}{t.port ? ` · left by ${PORT_LABEL[t.port] ?? t.port}` : ''}</span>
                </span>
                <Badge tone={s.tone}>{s.label}</Badge>
                {expandable && (open === i ? <ChevronDown aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />)}
              </button>
              {t.note && <p className="break-words px-3 pb-2 text-xs text-muted-foreground">{t.note}</p>}
              {would !== undefined && (
                <div className="mx-3 mb-2 rounded-md bg-muted p-2" data-testid="would-send">
                  <p className="text-xs font-semibold">Would send</p>
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{pretty(would)}</pre>
                </div>
              )}
              {open === i && expandable && <pre className="mx-3 mb-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 font-mono text-xs">{pretty(out)}</pre>}
            </li>
          )
        })}
      </ol>
      <div>
        <h3 className="mb-1 text-xs font-semibold text-muted-foreground">Variables at the end</h3>
        {vars.length ? (
          <dl className="divide-y rounded-md border bg-surface text-xs" data-testid="trace-vars">
            {vars.map(([k, v]) => <div key={k} className="flex gap-3 px-3 py-1.5"><dt className="w-28 shrink-0 truncate font-mono font-semibold">{k}</dt><dd className="min-w-0 flex-1 break-words font-mono">{typeof v === 'string' ? v : pretty(v)}</dd></div>)}
          </dl>
        ) : <p className="text-xs text-muted-foreground">None were set.</p>}
      </div>
    </div>
  )
}
