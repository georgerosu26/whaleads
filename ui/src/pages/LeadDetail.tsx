import { ArrowLeft, MessageSquare, Phone, StickyNote } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ErrorState } from '@/components/ErrorState'
import { CallDialog } from '@/components/leads/CallDialog'
import { EventTimeline } from '@/components/leads/EventTimeline'
import { LostDialog } from '@/components/leads/LostDialog'
import { NextActionPicker } from '@/components/leads/NextActionPicker'
import { OwnerSelect } from '@/components/leads/OwnerSelect'
import { StageStepper } from '@/components/leads/StageStepper'
import { TagPicker } from '@/components/leads/TagPicker'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { leadName, safeUrl, stageTone, useMeta, whenLabel, type ActivityT, type LeadDetailT, type Stage } from '@/lib/crm'
import { showPhone } from '@/lib/inbox'
import { OptOutControl } from '@/components/broadcasts/parts'
import { useLiveEvents } from '@/lib/live'
import { useLoad } from '@/lib/useLoad'

function DetailSkeleton() {
  return <div aria-busy="true" aria-label="Loading lead" className="max-w-2xl space-y-4"><Skeleton className="h-8 w-56" /><Skeleton className="h-10" /><Skeleton className="h-24" /><Skeleton className="h-40" /></div>
}

export default function LeadDetail() {
  const { id } = useParams()
  const { state: auth } = useAuth()
  const tz = auth.status === 'in' ? auth.me.timezone : 'UTC'
  const { state, reload } = useLoad<LeadDetailT>(`/api/leads/${id}`)
  const { state: meta } = useMeta()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [lost, setLost] = useState<Stage | null>(null)
  const [call, setCall] = useState(false)
  const [note, setNote] = useState('')
  const [older, setOlder] = useState<{ items: ActivityT[]; next: number | null } | null>(null)

  // a flow run on this lead (or a stage/owner change it made) lands in the timeline without a reload. Bursts coalesce.
  const refetch = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (refetch.current) clearTimeout(refetch.current) }, [])
  useLiveEvents((s) => {
    const mine = s.type === 'resync' || ((s.type === 'flow.run' || s.type === 'lead.update') && String(s.data?.lead_id) === String(id))
    if (!mine || refetch.current) return
    refetch.current = setTimeout(() => { refetch.current = null; void reload() }, 250)
  })

  if (state.status === 'loading' || meta.status === 'loading') return <DetailSkeleton />
  if (state.status === 'error') return <ErrorState message={state.message} onRetry={() => void reload()} />
  if (meta.status === 'error') return <ErrorState message={meta.message} onRetry={() => location.reload()} />
  const { lead, conversation } = state.data
  const m = meta.data
  const activity = [...state.data.activity, ...(older?.items ?? [])]
  const nextBefore = older ? older.next : state.data.activity_next_before
  const phone = showPhone(lead.phone ?? lead.wa_id)

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr(null)
    try { await fn(); setOlder(null); await reload() } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  const patch = (body: Record<string, unknown>) => act(() => api(`/api/leads/${id}`, { method: 'PATCH', body }))
  const pick = (s: Stage) => { if (s.key === lead.status) return; if (s.kind === 'lost') setLost(s); else void patch({ status: s.key }) }
  const addNote = () => { const text = note.trim(); if (text) void act(async () => { await api(`/api/leads/${id}/notes`, { method: 'POST', body: { text } }); setNote('') }) }
  const more = () => act(async () => {
    const r = await api<{ activity: ActivityT[]; activity_next_before: number | null }>(`/api/leads/${id}?activity_before=${nextBefore}`)
    setOlder({ items: [...(older?.items ?? []), ...r.activity], next: r.activity_next_before })
  })
  const attribution = lead.attribution
  const adLink = safeUrl(attribution?.source_url)

  return (
    <div className="max-w-2xl pb-8">
      <Link to="/leads" className="mb-3 inline-flex min-h-[40px] items-center gap-1 text-sm font-semibold text-muted-foreground hover:text-foreground"><ArrowLeft aria-hidden className="h-4 w-4" />Leads</Link>
      <header className="mb-4">
        <h1 className="break-words text-xl font-bold">{leadName(lead)}</h1>
        <p className="mt-0.5 break-words text-sm text-muted-foreground">{lead.name ? `${phone} · ` : ''}{lead.email ?? ''}</p>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Badge tone={stageTone(lead.stage_kind)}>{lead.stage_label ?? lead.status}</Badge>
          <Badge>{m.sources.find((s) => s.key === lead.source)?.label ?? lead.source}</Badge>
          {lead.tags.map((t) => <Badge key={t.id} tone={t.color}>{t.label}</Badge>)}
        </div>
        <div className="mt-2"><OptOutControl contactId={lead.contact_id} payload={lead} /></div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link to={`/inbox/${lead.contact_id}`}><Button variant="secondary"><MessageSquare className="h-4 w-4" aria-hidden />Messages{conversation?.unread_count ? ` (${conversation.unread_count})` : ''}</Button></Link>
          <Button variant="secondary" onClick={() => setCall(true)}><Phone className="h-4 w-4" aria-hidden />Log call</Button>
        </div>
      </header>

      {err && <p role="alert" className="mb-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm">{err}</p>}

      <section aria-label="Stage" className="mb-5"><Label>Stage</Label><StageStepper stages={m.stages} current={lead.status} onPick={pick} disabled={busy} /></section>
      {lead.stage_kind === 'lost' && lead.lost_reason && <p className="mb-5 text-sm"><span className="font-semibold">Lost because:</span> {lead.lost_reason}</p>}

      {lead.message && <section className="mb-5"><Label>First message</Label><p className="whitespace-pre-wrap break-words rounded-md border bg-surface p-3 text-sm">{lead.message}</p></section>}

      {attribution && Object.values(attribution).some(Boolean) && (
        <section className="mb-5 rounded-md border bg-surface p-3 text-sm" aria-label="Ad attribution">
          <Label>Where they came from</Label>
          {attribution.headline && <p className="break-words font-semibold">{attribution.headline}</p>}
          {attribution.body && <p className="break-words text-muted-foreground">{attribution.body}</p>}
          {attribution.ref_code && <p>Ref code: <span className="font-mono">{attribution.ref_code}</span></p>}
          {adLink && <a href={adLink} target="_blank" rel="noopener noreferrer" className="block truncate text-accent underline">{adLink}</a>}
        </section>
      )}

      <div className="mb-5 grid gap-4 sm:grid-cols-2">
        <div><Label htmlFor="ld-owner">Owner</Label><OwnerSelect id="ld-owner" owners={m.owners} value={lead.assigned_to} disabled={busy} onChange={(v) => void patch({ assigned_to: v })} /></div>
        <div><Label>Next action</Label><NextActionPicker value={lead.next_action_at} tz={tz} disabled={busy} onChange={(v) => void patch({ next_action_at: v })} /></div>
      </div>
      {m.tags.length > 0 && <section className="mb-5"><Label>Tags</Label>
        <TagPicker all={m.tags} selected={lead.tags.map((t) => t.id)} disabled={busy} onChange={(ids) => void act(() => api(`/api/leads/${id}/tags`, { method: 'PUT', body: { tag_ids: ids } }))} /></section>}

      <section className="mb-5">
        <Label htmlFor="ld-note">Add a note</Label>
        <textarea id="ld-note" rows={3} maxLength={4000} value={note} onChange={(e) => setNote(e.target.value)} className="w-full rounded-md border bg-surface px-3 py-2 text-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" />
        <Button className="mt-2" variant="secondary" disabled={!note.trim()} loading={busy} onClick={addNote}><StickyNote className="h-4 w-4" aria-hidden />Save note</Button>
      </section>

      <section aria-label="Timeline"><h2 className="mb-3 text-base font-bold">Activity</h2>
        <EventTimeline items={activity} tz={tz} owners={m.owners} stages={m.stages} />
        {nextBefore && <div className="mt-3 flex justify-center"><Button variant="ghost" loading={busy} onClick={() => void more()}>Older activity</Button></div>}
        <p className="mt-4 text-xs text-muted-foreground">Created {whenLabel(lead.created_at, tz)}</p>
      </section>

      {lost && <LostDialog stageLabel={lost.label} onClose={() => setLost(null)} onConfirm={async (reason) => { await api(`/api/leads/${id}`, { method: 'PATCH', body: { status: lost.key, ...(reason ? { lost_reason: reason } : {}) } }); setLost(null); setOlder(null); await reload() }} />}
      {call && <CallDialog onClose={() => setCall(false)} onSave={async (b) => { await api(`/api/leads/${id}/calls`, { method: 'POST', body: b }); setCall(false); setOlder(null); await reload() }} />}
    </div>
  )
}
