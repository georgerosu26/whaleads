import { Search, UserRound } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { EmptyState } from '@/components/EmptyState'
import { ErrorState } from '@/components/ErrorState'
import { PageHeader } from '@/components/PageHeader'
import { Modal } from '@/components/leads/Modal'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { initial, whenLabel, type LeadT } from '@/lib/crm'
import { displayName, showPhone, shortTime } from '@/lib/inbox'

interface ContactRow { id: number; name: string | null; phone: string | null; wa_id: string | null; email: string | null; source: string | null; last_seen_at: number; lead_count: number; open_lead_id: number | null; last_preview: string | null; unread_count: number | null }
interface ContactDetail { contact: ContactRow & { first_seen_at: number }; leads: LeadT[] }

function Sheet({ id, tz, onClose }: { id: number; tz: string; onClose: () => void }) {
  const [d, setD] = useState<ContactDetail | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => { api<ContactDetail>(`/api/contacts/${id}`).then(setD).catch((e) => setErr(e.message)) }, [id])
  return (
    <Modal title={d ? displayName(d.contact) : 'Contact'} onClose={onClose}>
      {err ? <p role="alert" className="text-sm text-danger">{err}</p> : !d ? <div aria-busy="true" aria-label="Loading contact" className="space-y-2"><Skeleton className="h-5 w-40" /><Skeleton className="h-16" /></div> : (
        <div className="space-y-3 text-sm">
          <p className="break-words">{showPhone(d.contact.phone ?? d.contact.wa_id)}{d.contact.email ? ` · ${d.contact.email}` : ''}</p>
          <p className="text-muted-foreground">First seen {whenLabel(d.contact.first_seen_at, tz)}</p>
          <Link to={`/inbox/${d.contact.id}`} className="inline-block font-semibold text-accent">Open the conversation</Link>
          <h3 className="pt-1 font-bold">Leads</h3>
          {d.leads.length === 0 ? <p className="text-muted-foreground">No leads for this contact.</p> : (
            <ul className="divide-y rounded-md border">
              {d.leads.map((l) => <li key={l.id}><Link to={`/leads/${l.id}`} className="flex min-h-[44px] items-center justify-between gap-2 px-3 py-2"><span className="truncate">{whenLabel(l.created_at, tz)}</span><Badge>{l.stage_label ?? l.status}</Badge></Link></li>)}
            </ul>
          )}
        </div>
      )}
    </Modal>
  )
}

export default function Contacts() {
  const { state } = useAuth()
  const tz = state.status === 'in' ? state.me.timezone : 'UTC'
  const [q, setQ] = useState('')
  const [dq, setDq] = useState('')
  const [rows, setRows] = useState<ContactRow[] | null>(null)
  const [next, setNext] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [more, setMore] = useState(false)
  const [open, setOpen] = useState<number | null>(null)
  const seq = useRef(0)
  useEffect(() => { const t = setTimeout(() => setDq(q.trim()), 250); return () => clearTimeout(t) }, [q])

  const load = useCallback(async () => {
    const my = ++seq.current
    setErr(null); setRows(null)
    try {
      const r = await api<{ contacts: ContactRow[]; next_before: string | null }>(`/api/contacts?limit=30${dq ? `&q=${encodeURIComponent(dq)}` : ''}`)
      if (my === seq.current) { setRows(r.contacts); setNext(r.next_before) }
    } catch (e) { if (my === seq.current) setErr((e as Error).message) }
  }, [dq])
  useEffect(() => { void load() }, [load])

  const loadMore = async () => {
    setMore(true)
    try {
      const r = await api<{ contacts: ContactRow[]; next_before: string | null }>(`/api/contacts?limit=30&before=${next}${dq ? `&q=${encodeURIComponent(dq)}` : ''}`)
      setRows((p) => [...(p ?? []), ...r.contacts]); setNext(r.next_before)
    } catch (e) { setErr((e as Error).message) } finally { setMore(false) }
  }

  return (
    <>
      <PageHeader title="Contacts" subtitle="Everyone you have talked to" />
      <div className="relative mb-4">
        <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input aria-label="Search contacts" placeholder="Search name, phone, email" className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {err ? <ErrorState message={err} onRetry={() => void load()} /> : rows === null ? (
        <div aria-busy="true" aria-label="Loading contacts" className="overflow-hidden rounded-lg border bg-surface">
          {[0, 1, 2, 3, 4].map((i) => <div key={i} className="flex items-center gap-3 border-b px-4 py-3"><Skeleton className="h-10 w-10 rounded-full" /><div className="flex-1 space-y-2"><Skeleton className="h-4 w-1/2" /><Skeleton className="h-3 w-3/4" /></div></div>)}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState icon={UserRound} title={dq ? 'No contacts match your search' : 'No contacts yet'} body={dq ? 'Try a different name or number.' : 'People appear here when they message you or fill in a form.'} />
      ) : (
        <>
          <ul className="overflow-hidden rounded-lg border bg-surface">
            {rows.map((c) => {
              const name = displayName(c)
              return (
                <li key={c.id} className="border-b last:border-b-0">
                  <button type="button" onClick={() => setOpen(c.id)} className="flex min-h-[64px] w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/60">
                    <span aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent/15 text-sm font-bold text-accent">{initial(name)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2"><span className="truncate text-sm font-semibold">{name}</span><time className="shrink-0 text-xs text-muted-foreground">{shortTime(c.last_seen_at)}</time></span>
                      <span className="block truncate text-sm text-muted-foreground">{c.name ? `${showPhone(c.phone ?? c.wa_id)} · ` : ''}{c.last_preview ?? c.email ?? ''}</span>
                    </span>
                    {c.open_lead_id && <Badge tone="blue">Open lead</Badge>}
                  </button>
                </li>
              )
            })}
          </ul>
          {next && <div className="mt-3 flex justify-center"><Button variant="secondary" loading={more} onClick={() => void loadMore()}>Load more</Button></div>}
        </>
      )}
      {open !== null && <Sheet id={open} tz={tz} onClose={() => setOpen(null)} />}
    </>
  )
}
