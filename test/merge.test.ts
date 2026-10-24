import { describe, expect, it } from 'vitest'
import { mergeFirstPage, mergePoll, settleSend, type ConvRow, type Msg } from '../ui/src/lib/inbox'

const msg = (id: number, o: Partial<Msg> = {}): Msg => ({ id, direction: 'out', wamid: null, type: 'text', body: 'x', media_id: null, status: 'sent', timestamp: 100, media: null, ...o })
const row = (id: number): ConvRow => ({ contact_id: id, name: `P${id}`, phone: null, wa_id: null, last_preview: null, last_message_at: 0, last_inbound_at: null, unread_count: 0, status: 'open', assigned_to: null, assigned_name: null, window_open: true, window_closes_at: null })

describe('settleSend', () => {
  const temp = msg(-1, { body: 'hello', timestamp: 111, local: { state: 'sending' } })
  const real = msg(42, { wamid: 'wamid.A', body: 'hello', timestamp: 112 })

  it('replaces the pending bubble in place with the real message', () => {
    const out = settleSend([msg(1), temp, msg(2, { direction: 'in' })], -1, real)
    expect(out.map((m) => m.id)).toEqual([1, 42, 2])
    expect(out[1]).toMatchObject({ wamid: 'wamid.A', timestamp: 111 })
    expect(out[1]!.local).toBeUndefined()
  })
  it('a poll that returned the real row before the send resolved leaves exactly one copy (no duplicate key)', () => {
    const afterPoll = [msg(1), temp, real] // the poll appended id 42 while the temp bubble was still pending
    const out = settleSend(afterPoll, -1, real)
    expect(out.map((m) => m.id)).toEqual([1, 42])
    expect(new Set(out.map((m) => m.id)).size).toBe(out.length)
  })
  it('matches by wamid too', () => {
    expect(settleSend([temp, msg(50, { wamid: 'wamid.A' })], -1, msg(43, { wamid: 'wamid.A' })).map((m) => m.id)).toEqual([50])
  })
  it('respond-before-batch: no row id yet keeps the bubble (as sent, in place) and the poll later swaps in the row without a gap', () => {
    const kept = settleSend([msg(1), temp], -1, { ...real, id: null as unknown as number })
    expect(kept.map((m) => m.id)).toEqual([1, -1]) // no flicker: still there
    expect(kept[1]).toMatchObject({ wamid: 'wamid.A', body: 'hello', timestamp: 111, local: { state: 'sent' } })
    const polled = mergePoll(kept, [real])
    expect(polled.map((m) => m.id)).toEqual([1, 42]) // replaced in place, exactly one copy
    expect(polled[1]!.local).toBeUndefined()
    expect(mergePoll(polled, [real]).map((m) => m.id)).toEqual([1, 42]) // and idempotent
  })
  it('queued send (no wamid, no id): the bubble stays; the null-wamid row is matched by body and time, no flicker, no duplicate', () => {
    const queued = { ...real, wamid: null, id: null as unknown as number, timestamp: 112 }
    const kept = settleSend([msg(1), temp], -1, queued)
    expect(kept.map((m) => m.id)).toEqual([1, -1])
    expect(kept[1]).toMatchObject({ body: 'hello', timestamp: 112, local: { state: 'sent' } })
    const row = msg(77, { wamid: null, body: 'hello', timestamp: 113 })
    expect(mergePoll(kept, [row]).map((m) => m.id)).toEqual([1, 77])
    expect(mergePoll(kept, [msg(78, { wamid: null, body: 'other', timestamp: 113 })]).map((m) => m.id)).toEqual([1, -1, 78]) // different body: no match
    expect(mergePoll(kept, [msg(79, { wamid: null, body: 'hello', timestamp: 140 })]).map((m) => m.id)).toEqual([1, -1, 79]) // too far apart
  })
  it('a poll that already brought the row drops the id-less result instead of duplicating', () => {
    expect(settleSend([temp, real], -1, { ...real, id: null as unknown as number }).map((m) => m.id)).toEqual([42])
  })
  it('leaves other pending bubbles alone', () => {
    const other = msg(-2, { local: { state: 'failed' } })
    expect(settleSend([temp, other], -1, real).map((m) => m.id)).toEqual([42, -2])
  })
})

describe('mergeFirstPage', () => {
  const ids = (r: ConvRow[]) => r.map((c) => c.contact_id)
  it('keeps a row that slid below the first page instead of dropping it', () => {
    const old = [1, 2, 3, 4, 5, 6].map(row) // first page = 3 rows, two extra pages loaded
    const fresh = [9, 1, 2].map(row) // a new conversation pushed 3 out of the page
    expect(ids(mergeFirstPage(old, fresh))).toEqual([9, 1, 2, 3, 4, 5, 6])
  })
  it('takes the fresh copy of rows on the first page and keeps old order below', () => {
    const old = [1, 2, 3, 4].map(row)
    const fresh = [2, 1].map((i) => ({ ...row(i), unread_count: 5 }))
    const out = mergeFirstPage(old, fresh)
    expect(ids(out)).toEqual([2, 1, 3, 4])
    expect(out[0]!.unread_count).toBe(5)
  })
})
