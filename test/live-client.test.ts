// D20 browser side: reconnect/heartbeat logic of the socket client and the pure event reducers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LiveClient, reconnectDelay, HEARTBEAT_MS, PONG_WAIT_MS, type LiveSignal } from '../ui/src/lib/live'
import { applyConversation, applyMessageStatus, convOrder } from '../ui/src/lib/liveReduce'
import type { ConvRow, Msg } from '../ui/src/lib/inbox'

class FakeWs {
  static all: FakeWs[] = []
  sent: string[] = []; closedWith: number | null | undefined
  onopen: (() => void) | null = null; onmessage: ((m: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null; onerror: (() => void) | null = null
  constructor(public url: string) { FakeWs.all.push(this) }
  send(s: string) { this.sent.push(s) }
  close(code?: number) { this.closedWith = code ?? 1000; queueMicrotask(() => this.onclose?.()) }
  open() { this.onopen?.() }
  push(o: unknown) { this.onmessage?.({ data: typeof o === 'string' ? o : JSON.stringify(o) }) }
  drop(code?: number) { (this.onclose as any)?.({ code }) }
}
const mk = () => new LiveClient(() => 'wss://x/api/live', (u) => new FakeWs(u) as unknown as WebSocket)

beforeEach(() => { FakeWs.all = []; vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(1) })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('reconnectDelay', () => {
  it('1 s doubling to a 30 s ceiling, jittered to 50-100% of the step', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map((a) => reconnectDelay(a, () => 1))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000])
    expect([0, 3, 9].map((a) => reconnectDelay(a, () => 0))).toEqual([500, 4000, 15000])
  })
})

describe('LiveClient', () => {
  it('connects, reports open, emits resync on every open and relays events (ignoring hello / pong / junk)', () => {
    const c = mk(); const got: LiveSignal[] = []; c.subscribe((s) => got.push(s))
    c.start(); expect(c.state).toBe('connecting')
    const w = FakeWs.all[0]!; w.open(); expect(c.state).toBe('open')
    w.push({ type: 'hello', ts: 1, data: {} }); w.push('pong'); w.push('not json'); w.push({ type: 'unread.total', ts: 2, data: { unread: 3 } })
    expect(got.map((g) => g.type)).toEqual(['resync', 'unread.total'])
  })

  it('reconnects with backoff after a drop and does a full resync on the new socket', () => {
    const c = mk(); const got: string[] = []; c.subscribe((s) => got.push(s.type))
    c.start(); FakeWs.all[0]!.open()
    FakeWs.all[0]!.drop(); expect(c.state).toBe('closed')
    vi.advanceTimersByTime(1000); expect(FakeWs.all).toHaveLength(2)
    FakeWs.all[1]!.drop(); vi.advanceTimersByTime(1999); expect(FakeWs.all).toHaveLength(2) // second failure waits longer
    vi.advanceTimersByTime(2001 + 1); expect(FakeWs.all.length).toBeGreaterThanOrEqual(3)
    FakeWs.all[2]!.open(); expect(c.state).toBe('open')
    expect(got.filter((t) => t === 'resync')).toHaveLength(2)
  })

  it('a successful open resets the backoff', () => {
    const c = mk(); c.start()
    for (let i = 0; i < 4; i++) { FakeWs.all.at(-1)!.drop(); vi.advanceTimersByTime(30_000) }
    FakeWs.all.at(-1)!.open(); FakeWs.all.at(-1)!.drop()
    const n = FakeWs.all.length
    vi.advanceTimersByTime(1000); expect(FakeWs.all.length).toBe(n + 1)
  })

  it('pings every 25 s and drops a link that stops answering', async () => {
    const c = mk(); c.start(); const w = FakeWs.all[0]!; w.open()
    vi.advanceTimersByTime(HEARTBEAT_MS); expect(w.sent).toEqual(['ping'])
    w.push('pong'); vi.advanceTimersByTime(PONG_WAIT_MS + 1); expect(w.closedWith).toBeUndefined() // answered in time
    vi.advanceTimersByTime(HEARTBEAT_MS); expect(w.sent).toEqual(['ping', 'ping'])
    vi.advanceTimersByTime(PONG_WAIT_MS + 1); expect(w.closedWith).toBe(1000) // silent: closed, which then reconnects
    await vi.advanceTimersByTimeAsync(2000); expect(FakeWs.all.length).toBeGreaterThan(1)
  })

  it('a 4001 close (session revoked) is final: no reconnect, state closed', () => {
    const c = mk(); c.start(); FakeWs.all[0]!.open(); FakeWs.all[0]!.drop(4001)
    expect(c.state).toBe('closed'); vi.advanceTimersByTime(120_000); expect(FakeWs.all).toHaveLength(1)
  })

  it('a "revoked" frame is final too, before the close even surfaces', () => {
    const c = mk(); c.start(); FakeWs.all[0]!.open(); (FakeWs.all[0] as any).onmessage({ data: JSON.stringify({ type: 'revoked', ts: 1, data: {} }) })
    expect(c.state).toBe('closed'); vi.advanceTimersByTime(120_000); expect(FakeWs.all).toHaveLength(1)
  })

  it('stop() closes for good: state off, no reconnect', () => {
    const c = mk(); c.start(); FakeWs.all[0]!.open(); c.stop()
    expect(c.state).toBe('off'); vi.advanceTimersByTime(60_000); expect(FakeWs.all).toHaveLength(1)
  })
})

const msg = (id: number, o: Partial<Msg> = {}): Msg => ({ id, direction: 'in', wamid: `w${id}`, type: 'text', body: 'x', media_id: null, status: null, timestamp: 100, media: null, ...o })
const row = (id: number, at: number, unread = 0): ConvRow => ({ contact_id: id, name: `P${id}`, phone: null, wa_id: null, last_preview: 'p', last_message_at: at, last_inbound_at: at, unread_count: unread, status: 'open', assigned_to: null, assigned_name: null, window_open: true, window_closes_at: null })

describe('reducers', () => {
  it('message.status: ticks only move forward, failed is terminal, pending bubbles are untouched', () => {
    const m = [msg(1, { direction: 'out', status: 'delivered' }), msg(-1, { direction: 'out', wamid: 'wp', local: { state: 'sending' } })]
    expect(applyMessageStatus(m, { wamid: 'w1', status: 'sent' })).toBe(m)
    expect(applyMessageStatus(m, { wamid: 'w1', status: 'read' })[0]!.status).toBe('read')
    expect(applyMessageStatus(m, { id: 1, status: 'failed' })[0]!.status).toBe('failed')
    expect(applyMessageStatus([msg(1, { status: 'failed' })], { id: 1, status: 'read' })[0]!.status).toBe('failed')
    expect(applyMessageStatus(m, { wamid: 'wp', status: 'sent' })).toBe(m)
  })
  it('conversation.update: replaces in place, re-sorts unread first then newest', () => {
    const rows = [row(1, 300), row(2, 200), row(3, 100)]
    const out = applyConversation(rows, row(3, 400, 1), false)
    expect(out.map((r) => r.contact_id)).toEqual([3, 1, 2])
    expect(out).not.toBe(rows)
  })
  it('conversation.update: never moves last_message_at backwards; inserts new rows; skips ones that belong on an unloaded page', () => {
    const rows = [row(1, 300), row(2, 200)]
    expect(applyConversation(rows, { ...row(1, 250), unread_count: 2 }, true)[0]).toMatchObject({ last_message_at: 300, unread_count: 2 })
    expect(applyConversation(rows, row(9, 500), true)[0]!.contact_id).toBe(9)
    expect(applyConversation(rows, row(9, 50), true)).toBe(rows)
    expect(applyConversation(rows, row(9, 50), false).map((r) => r.contact_id)).toEqual([1, 2, 9])
    expect(convOrder(row(1, 1, 1), row(2, 9))).toBeLessThan(0)
  })
})

describe('event and poll reconcile identically (ThreadView feeds message.new through mergePoll)', () => {
  it('a kept-until-confirmed bubble is replaced in place by wamid, and a second delivery (poll after event) adds nothing', async () => {
    const { mergePoll } = await import('../ui/src/lib/inbox')
    const pending = msg(-1, { direction: 'out', wamid: 'wO', local: { state: 'sent' } })
    const real = msg(7, { direction: 'out', wamid: 'wO' })
    const afterEvent = mergePoll([msg(1), pending], [real])
    expect(afterEvent.map((m) => m.id)).toEqual([1, 7])
    expect(mergePoll(afterEvent, [real])).toBe(afterEvent)
    expect(mergePoll(mergePoll([msg(1)], [real]), [real]).map((m) => m.id)).toEqual([1, 7])
  })
})

describe('settleSend: a queued send whose row an event or poll already added', () => {
  it('drops the pending bubble instead of showing the message twice', async () => {
    const { settleSend } = await import('../ui/src/lib/inbox')
    const stored = msg(7, { direction: 'out', wamid: null, body: 'hi', timestamp: 1000 })
    const pending = msg(-1, { direction: 'out', wamid: null, body: 'hi', timestamp: 998, local: { state: 'sending' } })
    const real = { ...msg(0, { direction: 'out', wamid: null, body: 'hi', timestamp: 1002 }), id: null as unknown as number }
    expect(settleSend([stored, pending], -1, real).map((m) => m.id)).toEqual([7])
    expect(settleSend([pending], -1, real).map((m) => [m.id, m.local?.state])).toEqual([[-1, 'sent']]) // not stored yet: kept
    expect(settleSend([stored, { ...pending, body: 'other' }], -1, { ...real, body: 'other', timestamp: 5000 }).map((m) => m.id)).toEqual([7, -1]) // outside +-10 s: not a match
  })
})
