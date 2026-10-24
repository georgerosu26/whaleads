import { Inbox as InboxIcon, MessageSquare, Search } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { ConnectButton } from '@/components/ConnectButton'
import { EmptyState } from '@/components/EmptyState'
import { ErrorState } from '@/components/ErrorState'
import { ConversationRow } from '@/components/inbox/ConversationRow'
import { ThreadView } from '@/components/inbox/ThreadView'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { useConnection } from '@/lib/connection'
import { useLiveEvents, useLiveOpen } from '@/lib/live'
import { applyConversation } from '@/lib/liveReduce'
import { mergeFirstPage, showPhone, type ConvRow, type InboxList } from '@/lib/inbox'
import { usePoller } from '@/lib/poll'
import { useUnread } from '@/lib/unread'
import { cn } from '@/lib/utils'

const FILTERS = [['all', 'All'], ['unread', 'Unread'], ['mine', 'Mine'], ['closed', 'Closed']] as const

function ListSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading conversations">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="flex items-center gap-3 border-b px-4 py-3"><Skeleton className="h-10 w-10 shrink-0 rounded-full" /><div className="flex-1 space-y-2"><Skeleton className="h-4 w-1/2" /><Skeleton className="h-3 w-4/5" /></div></div>
      ))}
    </div>
  )
}

export default function Inbox() {
  const { contactId } = useParams()
  const { connected, isAdmin } = useConnection()
  const { set: setUnread, unread } = useUnread()
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>('all')
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  const [rows, setRows] = useState<ConvRow[] | null>(null)
  const [next, setNext] = useState<string | null>(null)
  const [number, setNumber] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [more, setMore] = useState(false)
  const seq = useRef(0)
  const lastUnread = useRef<number | null>(null)
  const rowsRef = useRef<ConvRow[] | null>(null)
  rowsRef.current = rows

  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 250); return () => clearTimeout(t) }, [q])

  const query = useCallback((before?: string | null) =>
    `/api/inbox?filter=${filter}&limit=30${debounced ? `&q=${encodeURIComponent(debounced)}` : ''}${before ? `&before=${before}` : ''}`, [filter, debounced])

  // quiet = background refresh: no skeleton, no error banner (it throws so the poller can back off), and any extra
  // pages already loaded are kept below the refreshed first page.
  const load = useCallback(async (quiet = false) => {
    const id = ++seq.current
    if (!quiet) { setRows(null); setErr(null) }
    try {
      const r = await api<InboxList & { connected_number?: string | null }>(query())
      if (id !== seq.current) return
      lastUnread.current = r.unread_total
      setUnread(r.unread_total); setNumber(r.connected_number ?? null); setErr(null)
      if (quiet) {
        const p = rowsRef.current
        if (!p || p.length <= r.inbox.length) { setRows(r.inbox); setNext(r.next_before) }
        else setRows(mergeFirstPage(p, r.inbox))
      } else { setRows(r.inbox); setNext(r.next_before) }
    } catch (e) {
      if (quiet) throw e
      if (id === seq.current) setErr((e as Error).message)
    }
  }, [query, setUnread])
  useEffect(() => { void load() }, [load])

  const loadMore = async () => {
    if (!next) return
    setMore(true)
    try {
      const r = await api<InboxList>(query(next))
      setRows((p) => [...(p ?? []), ...r.inbox]); setNext(r.next_before)
    } catch (e) { setErr((e as Error).message) } finally { setMore(false) }
  }

  const refreshQuiet = useCallback(() => { load(true).catch(() => {}) }, [load])
  // D20: with the socket open the list is driven by events and this is only a slow safety net.
  const live = useLiveOpen()
  usePoller(() => load(true), live ? 60_000 : 10_000, rows !== null)
  const filtered = filter !== 'all' || debounced !== ''
  const filteredRef = useRef(filtered); filteredRef.current = filtered
  const nextRef = useRef(next); nextRef.current = next
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(reloadTimer.current), [])
  useLiveEvents((s) => {
    if (s.type === 'resync') { refreshQuiet(); return }
    if (s.type === 'unread.total' && typeof s.data?.unread === 'number') { lastUnread.current = s.data.unread; return } // the nav badge takes it; the list already moves by its own events
    if (s.type !== 'conversation.update' || !rowsRef.current) return
    if (filteredRef.current) { // a filter or search decides membership server-side: one coalesced re-query
      clearTimeout(reloadTimer.current); reloadTimer.current = setTimeout(refreshQuiet, 300); return
    }
    setRows((p) => (p ? applyConversation(p, s.data as ConvRow, nextRef.current !== null) : p))
  })
  // The nav counter moved (its own 15 s poll, or a read elsewhere): refresh the list now instead of at the next tick.
  useEffect(() => { if (rows && lastUnread.current !== null && unread !== lastUnread.current) refreshQuiet() }, [unread, rows, refreshQuiet])

  return (
    <div className="flex h-full min-h-0 bg-background">
      <section aria-label="Conversations" className={cn('min-h-0 w-full flex-col border-r bg-surface lg:flex lg:w-[360px] lg:shrink-0', contactId ? 'hidden' : 'flex')}>
        <div className="space-y-2 border-b p-3">
          <h1 className="px-1 text-xl font-bold">Inbox</h1>
          <label className="relative block">
            <span className="sr-only">Search conversations</span>
            <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or number" maxLength={80}
              className="min-h-[44px] w-full rounded-md border bg-background pl-9 pr-3 text-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" />
          </label>
          <div className="flex gap-2 overflow-x-auto" role="tablist" aria-label="Filter">
            {FILTERS.map(([k, label]) => (
              <button key={k} role="tab" aria-selected={filter === k} onClick={() => setFilter(k)}
                className={cn('min-h-[40px] shrink-0 rounded-full border px-4 text-sm font-semibold', filter === k ? 'border-accent bg-accent/15 text-accent' : 'text-muted-foreground hover:bg-muted')}>{label}</button>
            ))}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {err && !rows ? <div className="p-4"><ErrorState message={err} onRetry={() => void load()} /></div>
            : !rows ? <ListSkeleton />
            : rows.length === 0 ? (
              <div className="p-4">
                {filtered
                  ? <EmptyState icon={InboxIcon} title="No matching conversations" body="Try a different filter or search." />
                  : !connected ? <EmptyState icon={InboxIcon} title="Connect a WhatsApp number" body={isAdmin ? 'Conversations appear here once your number is connected.' : 'Ask an administrator to connect a WhatsApp number. Conversations appear here after that.'} action={isAdmin ? <ConnectButton /> : undefined} />
                  : <EmptyState icon={InboxIcon} title="No conversations yet" body={number ? `Messages sent to ${showPhone(number.replace(/\D/g, ''))} will appear here.` : 'Messages sent to your connected WhatsApp number will appear here.'} />}
              </div>
            ) : (
              <>
                {rows.map((c) => <ConversationRow key={c.contact_id} c={c} />)}
                {err && <p role="alert" className="p-3 text-sm text-danger">{err}</p>}
                {next && <div className="p-3 text-center"><Button variant="secondary" loading={more} onClick={() => void loadMore()}>Load more</Button></div>}
              </>
            )}
        </div>
      </section>

      <section aria-label="Conversation" className={cn('min-h-0 min-w-0 flex-1 flex-col lg:flex', contactId ? 'flex' : 'hidden')}>
        {contactId && Number.isInteger(Number(contactId)) ? <ThreadView key={contactId} contactId={Number(contactId)} onChanged={refreshQuiet} />
          : <div className="flex flex-1 items-center justify-center p-6"><div className="text-center text-muted-foreground"><MessageSquare aria-hidden className="mx-auto mb-2 h-6 w-6" /><p className="text-sm">Select a conversation</p></div></div>}
      </section>
    </div>
  )
}
