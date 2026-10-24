import { ArrowLeft, Clock, Lock, RotateCcw, UserCheck, UserMinus, XCircle } from 'lucide-react'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ErrorState } from '@/components/ErrorState'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useLiveEvents, useLiveOpen } from '@/lib/live'
import { applyMessageStatus } from '@/lib/liveReduce'
import { dayLabel, displayName, mergePoll, settleSend, showPhone, untilClose, type Msg, type Thread } from '@/lib/inbox'
import { usePoller } from '@/lib/poll'
import type { TemplateJob } from '@/lib/templates'
import { useUnread } from '@/lib/unread'
import { OptOutControl } from '@/components/broadcasts/parts'
import { Composer } from './Composer'
import { MessageBubble } from './MessageBubble'

export function ThreadSkeleton() {
  return (
    <div className="flex-1 space-y-3 p-4" aria-busy="true" aria-label="Loading conversation">
      <Skeleton className="h-10 w-2/3" /><Skeleton className="ml-auto h-12 w-1/2" /><Skeleton className="h-10 w-3/5" /><Skeleton className="ml-auto h-10 w-2/5" />
    </div>
  )
}

export function ThreadView({ contactId, onChanged }: { contactId: number; onChanged: () => void }) {
  const { state } = useAuth()
  const me = state.status === 'in' ? state.me.staff : null
  const { refresh: refreshUnread } = useUnread()
  const [t, setT] = useState<Thread | null>(null)
  const [older, setOlder] = useState<Msg[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionErr, setActionErr] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const scroller = useRef<HTMLDivElement>(null)

  const tRef = useRef<Thread | null>(null)
  tRef.current = t
  const stick = useRef(true) // follow new messages only while the reader is at the bottom
  const readTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const polling = useRef(false)
  const cursor = useRef(0) // newest id the SERVER has given us; an optimistic send never advances it, so nothing before it is skipped

  // Debounced: a burst of arrivals costs one read call. Clears the unread count server-side and in the list/nav badge.
  const markRead = useCallback(() => {
    clearTimeout(readTimer.current)
    readTimer.current = setTimeout(() => {
      if (document.visibilityState !== 'visible') return
      api(`/api/conversations/${contactId}/read`, { method: 'POST' })
        .then(() => {
          setT((p) => (p?.conversation ? { ...p, conversation: { ...p.conversation, unread_count: 0 } } : p))
          refreshUnread(); onChanged()
        }).catch(() => {})
    }, 400)
  }, [contactId, onChanged, refreshUnread])
  useEffect(() => () => clearTimeout(readTimer.current), [])

  const load = useCallback(async () => {
    setErr(null)
    try {
      const r = await api<Thread>(`/api/contacts/${contactId}/messages?limit=50`)
      cursor.current = r.messages.length ? r.messages[r.messages.length - 1]!.id : 0
      setT(r); setOlder([])
      if ((r.conversation?.unread_count ?? 0) > 0) markRead()
    } catch (e) { setErr((e as Error).message) }
  }, [contactId, markRead])

  // Live refresh: one tiny request for messages newer than the newest shown (plus window/unread state).
  // Throws on failure so the poller backs off; skips (resolves) while the first load is pending or a call is in flight.
  const pollOnce = useCallback(async () => {
    if (!tRef.current || polling.current) return
    polling.current = true
    try {
      const r = await api<Thread>(`/api/contacts/${contactId}/messages?after=${cursor.current}`)
      for (const m of r.messages) cursor.current = Math.max(cursor.current, m.id)
      const box = scroller.current
      if (box) stick.current = box.scrollHeight - box.scrollTop - box.clientHeight < 80
      setT((p) => {
        if (!p) return p
        const st = new Map((r.statuses ?? []).map((x) => [x.id, x.status]))
        const base = st.size ? p.messages.map((m) => (m.direction === 'out' && !m.local && st.has(m.id) && st.get(m.id) !== m.status ? { ...m, status: st.get(m.id) ?? null } : m)) : p.messages
        return { ...p, messages: mergePoll(base, r.messages), conversation: r.conversation, window_open: r.window_open, window_closes_at: r.window_closes_at }
      })
      if ((r.conversation?.unread_count ?? 0) > 0) markRead()
    } finally { polling.current = false }
  }, [contactId, markRead])
  // D20: with the socket open, events carry the changes and this is only a slow safety net; otherwise the 4 s poll is the channel.
  const live = useLiveOpen()
  usePoller(pollOnce, live ? 30_000 : 4_000, !err)

  // Events go through the SAME reducers as the poll (mergePoll reconciles by wamid / queued-body, settleSend handles the
  // send response), so an event and a poll carrying one message can never both add it. `cursor` is deliberately not moved by
  // events: ids can arrive out of order, and a skipped id would never be polled for; a re-fetched row is dropped by mergePoll.
  const missed = useRef(false) // an event arrived before the first load finished: poll once when it has
  useLiveEvents((sig) => {
    if (sig.type === 'resync') { if (tRef.current) void pollOnce().catch(() => {}); return }
    const d = sig.data as Record<string, any> | null
    if (!d || d.contact_id !== contactId) return
    if (!tRef.current) { missed.current = true; return }
    if (sig.type === 'message.new' && d.message) {
      const box = scroller.current
      if (box) stick.current = box.scrollHeight - box.scrollTop - box.clientHeight < 80
      setT((p) => (p ? { ...p, messages: mergePoll(p.messages, [d.message as Msg]) } : p))
    } else if (sig.type === 'message.status') {
      setT((p) => (p ? { ...p, messages: applyMessageStatus(p.messages, { id: d.id, wamid: d.wamid, status: d.status }) } : p))
    } else if (sig.type === 'conversation.update') {
      setT((p) => (p ? {
        ...p,
        conversation: { unread_count: d.unread_count, status: d.status, assigned_to: d.assigned_to, assigned_name: d.assigned_name },
        window_open: !!d.window_open, window_closes_at: d.window_closes_at ?? null,
      } : p))
      if ((d.unread_count ?? 0) > 0) markRead()
    }
  })
  useEffect(() => { if (t && missed.current) { missed.current = false; void pollOnce().catch(() => {}) } }, [t === null]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setT(null); stick.current = true; void load() }, [load])
  useEffect(() => { const i = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(i) }, [])
  useEffect(() => { if (stick.current) scroller.current?.scrollTo({ top: scroller.current.scrollHeight }) }, [t?.messages.length, contactId])

  // Optimistic send. A pending bubble (negative temp id) appears at once; the response swaps in the real message in place.
  const tempSeq = useRef(0)
  const jobs = useRef(new Map<number, { text: string; file: File | null; tpl?: TemplateJob }>())
  const blobs = useRef(new Set<string>())
  useEffect(() => () => { blobs.current.forEach((u) => URL.revokeObjectURL(u)) }, [])
  const mutate = (tempId: number, f: (m: Msg) => Msg | null) =>
    setT((p) => (p ? { ...p, messages: p.messages.flatMap((m) => (m.id === tempId ? (f(m) ?? []) : [m])) } : p))

  const runSend = async (tempId: number) => {
    const job = jobs.current.get(tempId)
    if (!job) return
    mutate(tempId, (m) => ({ ...m, local: { ...m.local, state: 'sending', error: undefined } }))
    try {
      let r: { message: Msg }
      if (job.tpl) {
        const t = job.tpl
        const hdr = t.header
        if (hdr?.kind === 'upload') {
          const fd = new FormData(); fd.set('template_id', t.tpl.id); fd.set('body_params', JSON.stringify(t.bodyParams)); fd.set('header_params', JSON.stringify(t.headerParams)); fd.set('file', hdr.file)
          r = await api<{ message: Msg }>(`/api/inbox/${contactId}/send-template`, { method: 'POST', body: fd })
        } else {
          r = await api<{ message: Msg }>(`/api/inbox/${contactId}/send-template`, { method: 'POST', body: {
            template_id: t.tpl.id, body_params: t.bodyParams, header_params: t.headerParams,
            ...(hdr?.kind === 'stored' ? { header_message_id: hdr.messageId } : hdr ? { header_message_id: 'default' } : {}),
          } })
        }
      } else if (job.file) {
        const fd = new FormData(); fd.set('file', job.file); if (job.text) fd.set('caption', job.text)
        r = await api<{ message: Msg }>(`/api/inbox/${contactId}/send-media`, { method: 'POST', body: fd })
      } else {
        r = await api<{ message: Msg }>(`/api/inbox/${contactId}/send`, { method: 'POST', body: { text: job.text } })
      }
      jobs.current.delete(tempId)
      const real = r.message
      const url = tRef.current?.messages.find((m) => m.id === tempId)?.local?.previewUrl
      // A bubble kept until its row exists still shows the blob; it is revoked on unmount.
      if (url && typeof real.id === 'number') { blobs.current.delete(url); setTimeout(() => URL.revokeObjectURL(url), 1_000) }
      // A queued send has no row id yet, and a poll may already have fetched the real row: settleSend drops the pending bubble then.
      setT((p) => (p ? { ...p, messages: settleSend(p.messages, tempId, real) } : p)) // against the newest list, not last render's
      onChanged(); void pollOnce().catch(() => {})
      if (typeof real.id !== 'number') setTimeout(() => void pollOnce().catch(() => {}), 1_200) // the row is stored just after the reply
    } catch (e) {
      const a = e as { status?: number; message?: string }
      const error = a.status === 409 ? 'The reply window just closed. Refresh to see the latest' : a.message ?? 'Could not send'
      mutate(tempId, (m) => ({ ...m, local: { ...m.local, state: 'failed', error } }))
    }
  }
  const submit = ({ text, file }: { text: string; file: File | null }): boolean => {
    // Only a duplicate of a text that is still on its way is refused; everything else may queue up.
    if (!file && tRef.current?.messages.some((m) => m.local?.state === 'sending' && !m.media && m.body === text)) return false
    const tempId = -(++tempSeq.current)
    jobs.current.set(tempId, { text, file })
    let previewUrl: string | undefined
    if (file) { previewUrl = URL.createObjectURL(file); blobs.current.add(previewUrl) }
    const type = !file ? 'text' : file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : 'document'
    const msg: Msg = {
      id: tempId, direction: 'out', wamid: null, type, body: text || null, media_id: null, status: null, timestamp: Math.floor(Date.now() / 1000),
      media: file ? { status: 'ready', mime: file.type || null, filename: file.name, size: file.size } : null,
      local: { state: 'sending', previewUrl },
    }
    stick.current = true
    setT((p) => (p ? { ...p, messages: [...p.messages, msg] } : p))
    void runSend(tempId)
    return true
  }

  const submitTemplate = (tj: TemplateJob): boolean => {
    const tempId = -(++tempSeq.current)
    jobs.current.set(tempId, { text: tj.rendered, file: null, tpl: tj })
    const up = tj.header?.kind === 'upload' ? tj.header.file : null
    let previewUrl: string | undefined
    if (up) { previewUrl = URL.createObjectURL(up); blobs.current.add(previewUrl) }
    const msg: Msg = {
      id: tempId, direction: 'out', wamid: null, type: 'template', body: tj.rendered || null, media_id: null, status: null, timestamp: Math.floor(Date.now() / 1000),
      media: up ? { status: 'ready', mime: up.type || null, filename: up.name, size: up.size } : null,
      local: { state: 'sending', previewUrl },
    }
    stick.current = true
    setT((p) => (p ? { ...p, messages: [...p.messages, msg] } : p))
    void runSend(tempId)
    return true
  }

  const all = useMemo(() => [...older, ...(t?.messages ?? [])], [older, t])
  const olderCursor = useRef<number | null>(null)
  const loadOlder = async () => {
    if (!t) return
    setBusy(true)
    try {
      const r = await api<Thread>(`/api/contacts/${contactId}/messages?limit=50&before=${olderCursor.current}`)
      olderCursor.current = r.next_before
      setOlder((o) => [...r.messages, ...o])
      setT((p) => (p ? { ...p, has_more: r.has_more } : p))
    } catch (e) { setActionErr((e as Error).message) } finally { setBusy(false) }
  }
  useEffect(() => { olderCursor.current = t?.next_before ?? null }, [t?.next_before])

  const patch = async (body: Record<string, unknown>) => {
    setBusy(true); setActionErr(null)
    try {
      const r = await api<{ conversation: Thread['conversation'] }>(`/api/conversations/${contactId}`, { method: 'PATCH', body })
      setT((p) => (p ? { ...p, conversation: { ...p.conversation!, ...r.conversation } } : p))
      onChanged()
    } catch (e) { setActionErr((e as Error).message) } finally { setBusy(false) }
  }

  if (err) return <div className="p-4"><ErrorState message={err} onRetry={() => void load()} /></div>
  if (!t) return <div className="flex min-h-0 flex-1 flex-col"><div className="flex h-14 items-center gap-3 border-b px-4"><Skeleton className="h-8 w-8 rounded-full" /><Skeleton className="h-4 w-40" /></div><ThreadSkeleton /></div>

  const conv = t.conversation
  const closesAt = t.window_closes_at
  const windowOpen = t.window_open && closesAt !== null && closesAt * 1000 > now
  const mine = !!me && conv?.assigned_to === me.id
  let lastDay = ''

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex min-h-14 items-center gap-2 border-b bg-surface px-2 py-2 lg:px-4">
        <Link to="/inbox" aria-label="Back to conversations" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md hover:bg-muted lg:hidden"><ArrowLeft aria-hidden className="h-5 w-5" /></Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-bold">{displayName(t.contact)}</h1>
          <p className="truncate text-xs text-muted-foreground">{showPhone(t.contact.phone ?? t.contact.wa_id)}{conv?.assigned_name ? ` · ${conv.assigned_name}` : ''}</p>
          <OptOutControl contactId={contactId} payload={t.contact} />
        </div>
        {conv?.status === 'closed' && <Badge>Closed</Badge>}
      </header>

      <div className="flex flex-wrap gap-2 border-b bg-surface px-3 py-2">
        {me && (mine
          ? <Button variant="secondary" disabled={busy} onClick={() => void patch({ assigned_to: null })}><UserMinus aria-hidden className="h-4 w-4" />Unassign</Button>
          : <Button variant="secondary" disabled={busy} onClick={() => void patch({ assigned_to: me.id })}><UserCheck aria-hidden className="h-4 w-4" />Assign to me</Button>)}
        {conv?.status === 'closed'
          ? <Button variant="secondary" disabled={busy} onClick={() => void patch({ status: 'open' })}><RotateCcw aria-hidden className="h-4 w-4" />Reopen</Button>
          : <Button variant="secondary" disabled={busy} onClick={() => void patch({ status: 'closed' })}><XCircle aria-hidden className="h-4 w-4" />Close</Button>}
      </div>
      {actionErr && <p role="alert" className="border-b bg-surface px-4 py-2 text-sm text-danger">{actionErr}</p>}

      <div ref={scroller} onScroll={(e) => { const b = e.currentTarget; stick.current = b.scrollHeight - b.scrollTop - b.clientHeight < 80 }} className="min-h-0 flex-1 space-y-2 overflow-y-auto bg-background px-3 py-4">
        {t.has_more && <div className="text-center"><Button variant="secondary" loading={busy} onClick={() => void loadOlder()}>Load earlier messages</Button></div>}
        {all.length === 0 && <p className="py-10 text-center text-sm text-muted-foreground">No messages yet.</p>}
        {all.map((m) => {
          const d = dayLabel(m.timestamp)
          const head = d !== lastDay
          lastDay = d
          return (
            <Fragment key={m.id}>
              {head && <div className="py-1 text-center text-xs font-semibold text-muted-foreground">{d}</div>}
              <MessageBubble m={m} onRetry={m.local ? () => void runSend(m.id) : undefined} />
            </Fragment>
          )
        })}
      </div>

      {windowOpen && <div role="status" className={`flex items-start gap-2 border-t px-4 py-3 text-sm ${windowOpen ? 'bg-surface text-muted-foreground' : 'bg-amber-500/10 text-foreground'}`}>
        {windowOpen ? <Clock aria-hidden className="mt-0.5 h-4 w-4 shrink-0" /> : <Lock aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />}
        {windowOpen
          ? <span>Reply window open for {untilClose(closesAt!, now)}.</span>
          : <span><strong>Reply window closed.</strong> {t.contact.name ?? 'This contact'} has not messaged in the last 24 hours, so only an approved template can start a conversation.</span>}
      </div>}
      <Composer contactId={contactId} contactName={t.contact.name} windowOpen={windowOpen} onSubmit={submit} onSendTemplate={submitTemplate} />
    </div>
  )
}
