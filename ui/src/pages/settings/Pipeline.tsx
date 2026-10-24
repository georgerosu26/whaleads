import { ArrowDown, ArrowUp, Plus, Tags, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { EmptyState } from '@/components/EmptyState'
import { Card, FormMsg, LoadGate, SettingsPage } from '@/components/SettingsPage'
import { Badge, TAG_STYLES } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { api } from '@/lib/api'
import { useLoad } from '@/lib/useLoad'

interface Stage { key: string; label: string; position: number; kind: 'open' | 'won' | 'lost'; archived: number; lead_count: number }
interface Source { key: string; label: string; system: number; archived: number }
interface Tag { id: number; label: string; color: string }

const ERR: Record<string, string> = {
  stage_has_leads: 'Leads are still in this stage. Choose where to move them.',
  protected_stage: 'The New stage is where every lead starts, so it can only be renamed.',
  last_of_kind: 'Keep at least one active stage of each kind (open, won, lost).',
  system_locked: 'Built-in sources cannot be changed.',
  label_taken: 'A tag with that name already exists.',
}
const msg = (e: unknown) => ERR[(e as Error).message] ?? (e as Error).message

function AddRow({ placeholder, label, onAdd, extra }: { placeholder: string; label: string; onAdd: (text: string) => Promise<void>; extra?: React.ReactNode }) {
  const [v, setV] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState('')
  async function submit(e: FormEvent) {
    e.preventDefault(); if (!v.trim()) return
    setBusy(true); setErr('')
    try { await onAdd(v.trim()); setV('') } catch (x) { setErr(msg(x)) } finally { setBusy(false) }
  }
  return (
    <form onSubmit={submit} className="mt-3">
      <div className="flex flex-wrap gap-2">
        <Input aria-label={label} className="min-w-0 flex-1 basis-40" maxLength={60} placeholder={placeholder} value={v} onChange={(e) => setV(e.target.value)} />
        {extra}
        <Button type="submit" variant="secondary" loading={busy}><Plus aria-hidden className="h-4 w-4" />Add</Button>
      </div>
      {err && <div className="mt-2"><FormMsg error={err} /></div>}
    </form>
  )
}

function StageRow({ s, i, all, onSave, onMove, onRemove }: { s: Stage; i: number; all: Stage[]; onSave: (b: object) => Promise<void>; onMove: (d: -1 | 1) => Promise<void>; onRemove: (mode: 'archive' | 'delete', moveTo?: string) => Promise<void> }) {
  const [label, setLabel] = useState(s.label); const [err, setErr] = useState(''); const [panel, setPanel] = useState<'' | 'archive' | 'delete'>(''); const [moveTo, setMoveTo] = useState(''); const [busy, setBusy] = useState(false)
  const act = async (fn: () => Promise<void>) => { setBusy(true); setErr(''); try { await fn(); setPanel('') } catch (x) { setErr(msg(x)) } finally { setBusy(false) } }
  const targets = all.filter((o) => o.key !== s.key && !o.archived)
  const archived = !!s.archived
  return (
    <li className="px-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex">
          <Button type="button" variant="ghost" className="px-2" aria-label={`Move ${s.label} up`} disabled={i === 0 || busy} onClick={() => void act(() => onMove(-1))}><ArrowUp aria-hidden className="h-4 w-4" /></Button>
          <Button type="button" variant="ghost" className="px-2" aria-label={`Move ${s.label} down`} disabled={i === all.length - 1 || busy} onClick={() => void act(() => onMove(1))}><ArrowDown aria-hidden className="h-4 w-4" /></Button>
        </div>
        <Input aria-label={`Name of stage ${s.label}`} className="min-w-0 flex-1 basis-32" maxLength={60} value={label} onChange={(e) => setLabel(e.target.value)} onBlur={() => { if (label.trim() && label.trim() !== s.label) void act(() => onSave({ label: label.trim() })); else setLabel(s.label) }} />
        <Select aria-label={`Kind of ${s.label}`} className="w-24" value={s.kind} disabled={s.key === 'new' || busy} onChange={(e) => void act(() => onSave({ kind: e.target.value }))}><option value="open">Open</option><option value="won">Won</option><option value="lost">Lost</option></Select>
        <span className="text-xs text-muted-foreground">{s.lead_count} {s.lead_count === 1 ? 'lead' : 'leads'}</span>
        {archived && <Badge tone="amber">Archived</Badge>}
        {archived ? <Button type="button" variant="secondary" disabled={busy} onClick={() => void act(() => onSave({ archived: false }))}>Restore</Button>
          : s.key !== 'new' && <Button type="button" variant="ghost" className="px-2" aria-label={`Archive or delete ${s.label}`} onClick={() => { setPanel(panel ? '' : 'archive'); setMoveTo(targets[0]?.key ?? '') }}><Trash2 aria-hidden className="h-4 w-4" /></Button>}
      </div>
      {panel && (
        <div className="mt-3 space-y-2 rounded-md bg-muted p-3 text-sm">
          <p>{s.lead_count > 0 ? `${s.lead_count} ${s.lead_count === 1 ? 'lead is' : 'leads are'} in ${s.label}. Move them to:` : `Nobody is in ${s.label}.`}</p>
          {s.lead_count > 0 && <Select aria-label="Move leads to" value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>{targets.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}</Select>}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" loading={busy} onClick={() => void act(() => onRemove('archive', s.lead_count ? moveTo : undefined))}>Archive (hide, keep history)</Button>
            <Button type="button" loading={busy} onClick={() => void act(() => onRemove('delete', s.lead_count ? moveTo : undefined))}>Delete</Button>
            <Button type="button" variant="ghost" onClick={() => setPanel('')}>Cancel</Button>
          </div>
        </div>
      )}
      {err && <div className="mt-2"><FormMsg error={err} /></div>}
    </li>
  )
}

function Stages() {
  const l = useLoad<{ stages: Stage[] }>('/api/stages?all=1')
  const apply = (r: { stages: Stage[] }) => l.set(r)
  return (
    <Card title="Stages">
      <LoadGate load={l.state} retry={() => void l.reload()} rows={4}>
        {(d) => (
          <>
            <ul className="divide-y rounded-lg border">
              {d.stages.map((s, i) => (
                <StageRow key={s.key} s={s} i={i} all={d.stages}
                  onSave={async (b) => apply(await api(`/api/stages/${s.key}`, { method: 'PATCH', body: b }))}
                  onMove={async (dir) => { const keys = d.stages.map((x) => x.key); [keys[i], keys[i + dir]] = [keys[i + dir], keys[i]]; apply(await api('/api/stages/reorder', { method: 'POST', body: { keys } })) }}
                  onRemove={async (mode, moveTo) => apply(mode === 'archive'
                    ? await api(`/api/stages/${s.key}`, { method: 'PATCH', body: { archived: true, ...(moveTo ? { move_to: moveTo } : {}) } })
                    : await api(`/api/stages/${s.key}${moveTo ? `?move_to=${encodeURIComponent(moveTo)}` : ''}`, { method: 'DELETE' }))} />
              ))}
            </ul>
            <AddRow label="New stage name" placeholder="New stage, e.g. Site visit" onAdd={async (label) => apply(await api('/api/stages', { method: 'POST', body: { label, kind: 'open' } }))} />
          </>
        )}
      </LoadGate>
    </Card>
  )
}

function Sources() {
  const l = useLoad<{ sources: Source[] }>('/api/sources?all=1')
  const [err, setErr] = useState('')
  const toggle = async (s: Source) => { setErr(''); try { l.set(await api(`/api/sources/${s.key}`, { method: 'PATCH', body: { archived: !s.archived } })) } catch (x) { setErr(msg(x)) } }
  return (
    <Card title="Sources">
      <LoadGate load={l.state} retry={() => void l.reload()} rows={3}>
        {(d) => (
          <>
            <ul className="divide-y rounded-lg border">
              {d.sources.map((s) => (
                <li key={s.key} className="flex min-h-[48px] items-center gap-2 px-3">
                  <span className={`min-w-0 flex-1 truncate ${s.archived ? 'text-muted-foreground line-through' : ''}`}>{s.label}</span>
                  {s.system ? <Badge>Built in</Badge> : <Button type="button" variant="ghost" onClick={() => void toggle(s)}>{s.archived ? 'Restore' : 'Archive'}</Button>}
                </li>
              ))}
            </ul>
            <FormMsg error={err} />
            <AddRow label="New source name" placeholder="New source, e.g. Walk-in" onAdd={async (label) => l.set(await api('/api/sources', { method: 'POST', body: { label } }))} />
          </>
        )}
      </LoadGate>
    </Card>
  )
}

function TagRow({ t, colors, onChange }: { t: Tag; colors: string[]; onChange: (r: { tags: Tag[] }) => void }) {
  const [err, setErr] = useState(''); const [label, setLabel] = useState(t.label)
  const run = async (fn: () => Promise<{ tags: Tag[] }>) => { setErr(''); try { onChange(await fn()) } catch (x) { setErr(msg(x)); setLabel(t.label) } }
  return (
    <li className="px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={t.color}>{t.label}</Badge>
        <Input aria-label={`Name of tag ${t.label}`} className="min-w-0 flex-1 basis-28" maxLength={40} value={label} onChange={(e) => setLabel(e.target.value)} onBlur={() => { if (label.trim() && label.trim() !== t.label) void run(() => api(`/api/tags/${t.id}`, { method: 'PATCH', body: { label: label.trim() } })); else setLabel(t.label) }} />
        <Select aria-label={`Colour of ${t.label}`} className="w-28" value={t.color} onChange={(e) => void run(() => api(`/api/tags/${t.id}`, { method: 'PATCH', body: { color: e.target.value } }))}>{colors.map((c) => <option key={c} value={c}>{c[0].toUpperCase() + c.slice(1)}</option>)}</Select>
        <Button type="button" variant="ghost" className="px-2" aria-label={`Delete tag ${t.label}`} onClick={() => void run(() => api(`/api/tags/${t.id}`, { method: 'DELETE' }))}><Trash2 aria-hidden className="h-4 w-4" /></Button>
      </div>
      {err && <div className="mt-1"><FormMsg error={err} /></div>}
    </li>
  )
}

function TagList() {
  const l = useLoad<{ tags: Tag[]; colors: string[] }>('/api/tags')
  const [color, setColor] = useState('neutral')
  return (
    <Card title="Tags">
      <LoadGate load={l.state} retry={() => void l.reload()} rows={2}>
        {(d) => (
          <>
            {d.tags.length === 0 ? <EmptyState icon={Tags} title="No tags yet" body="Tags label leads, like VIP or Callback." /> : (
              <ul className="divide-y rounded-lg border">{d.tags.map((t) => <TagRow key={t.id} t={t} colors={d.colors} onChange={(r) => l.set({ ...d, tags: r.tags })} />)}</ul>
            )}
            <AddRow label="New tag name" placeholder="New tag" onAdd={async (label) => { const r = await api<{ tags: Tag[] }>('/api/tags', { method: 'POST', body: { label, color } }); l.set({ ...d, tags: r.tags }) }}
              extra={<Select aria-label="New tag colour" className="w-28" value={color} onChange={(e) => setColor(e.target.value)}>{Object.keys(TAG_STYLES).map((c) => <option key={c} value={c}>{c[0].toUpperCase() + c.slice(1)}</option>)}</Select>} />
          </>
        )}
      </LoadGate>
    </Card>
  )
}

export default function Pipeline() {
  return (
    <SettingsPage title="Pipeline" subtitle="The stages, sources and tags your team uses on leads">
      <Stages /><Sources /><TagList />
    </SettingsPage>
  )
}
