// Opt-out keywords on the inbound pipeline, Meta 131050 on a status webhook, and receipts updating broadcast recipients by wamid.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { processEvents } from '../src/inbound'
import { ctx } from './helpers'
import { addHotLeads, bcRig, bcRow, makeRunning, nowS, phoneOf, recips, seedTemplate, tick, type Bc } from './broadcast.helpers'

let b: Bc
beforeEach(async () => { b = await bcRig(); seedTemplate(b.r) })
afterEach(() => { vi.unstubAllGlobals() })

const msg = (from: string, body: string | null, type = 'text', n = Math.random()) =>
  ({ kind: 'message' as const, wamid: `wamid.IN${n}`, from, name: 'X', type, body, media_id: null, timestamp: nowS(), raw: {} })
const status = (wamid: string, st: string, errors: unknown[] | null = null) =>
  ({ kind: 'status' as const, wamid, status: st, timestamp: nowS(), recipient: null, errors, raw: {} })
const contact = (id: number) => b.r.raw.prepare(`SELECT opted_out_at,opt_out_source FROM contacts WHERE id=?`).get(id) as any

describe('keywords', () => {
  it('STOP opts the sender out (source keyword) and the message is still stored', async () => {
    await processEvents(b.r.env, ctx, [msg('15550000001', 'STOP')])
    expect(contact(1)).toMatchObject({ opt_out_source: 'keyword' })
    expect(contact(1).opted_out_at).toBeTruthy()
    expect(b.r.raw.prepare(`SELECT COUNT(*) AS n FROM messages WHERE direction='in'`).get()).toMatchObject({ n: 1 })
    expect(b.r.raw.prepare(`SELECT kind FROM activity WHERE contact_id=1 AND kind='opted_out'`).all()).toHaveLength(1)
  })
  it('a repeated STOP is idempotent and writes one activity row', async () => {
    await processEvents(b.r.env, ctx, [msg('15550000001', 'stop.')])
    await processEvents(b.r.env, ctx, [msg('15550000001', 'STOP')])
    expect(b.r.raw.prepare(`SELECT kind FROM activity WHERE contact_id=1 AND kind='opted_out'`).all()).toHaveLength(1)
  })
  it('START clears a keyword opt-out', async () => {
    await processEvents(b.r.env, ctx, [msg('15550000001', 'STOP')])
    await processEvents(b.r.env, ctx, [msg('15550000001', 'START')])
    expect(contact(1)).toEqual({ opted_out_at: null, opt_out_source: null })
  })
  it('START does not clear a manual or Meta opt-out', async () => {
    b.r.raw.prepare(`UPDATE contacts SET opted_out_at=?, opt_out_source='manual' WHERE id=1`).run(nowS())
    await processEvents(b.r.env, ctx, [msg('15550000001', 'START')])
    expect(contact(1)).toMatchObject({ opt_out_source: 'manual' })
    b.r.raw.prepare(`UPDATE contacts SET opt_out_source='meta_131050' WHERE id=1`).run()
    await processEvents(b.r.env, ctx, [msg('15550000001', 'start')])
    expect(contact(1)).toMatchObject({ opt_out_source: 'meta_131050' })
  })
  it('only whole-message keywords count, and media captions never do', async () => {
    await processEvents(b.r.env, ctx, [msg('15550000001', 'please stop the offers')])
    expect(contact(1).opted_out_at).toBeNull()
    await processEvents(b.r.env, ctx, [msg('15550000001', 'STOP', 'image')])
    expect(contact(1).opted_out_at).toBeNull()
  })
  it('a contact who said STOP is skipped by a broadcast that already started', async () => {
    addHotLeads(b.r, 2)
    const id = await makeRunning(b)
    await processEvents(b.r.env, ctx, [msg(phoneOf(2), 'STOP')])
    await tick(b)
    expect(b.gw.calls.map((c) => c.body?.to)).not.toContain(phoneOf(2))
    expect(recips(b, id).find((x) => x.contact_id === '2')!.status).toBe('skipped')
  })
})

describe('status webhooks update recipients by wamid', () => {
  it('sent -> delivered -> read moves the recipient and the counters forward once', async () => {
    addHotLeads(b.r, 1)
    const id = await makeRunning(b, { tagAsha: false })
    await tick(b)
    const wamid = recips(b, id)[0]!.wamid
    await processEvents(b.r.env, ctx, [status(wamid, 'delivered')])
    expect(recips(b, id)[0]!.status).toBe('delivered')
    expect(bcRow(b, id)).toMatchObject({ delivered: 1, read: 0 })
    await processEvents(b.r.env, ctx, [status(wamid, 'read')])
    expect(recips(b, id)[0]!.status).toBe('read')
    expect(bcRow(b, id)).toMatchObject({ delivered: 1, read: 1 })
    await processEvents(b.r.env, ctx, [status(wamid, 'delivered')])
    expect(recips(b, id)[0]!.status).toBe('read')
    expect(bcRow(b, id)).toMatchObject({ delivered: 1, read: 1 })
  })
  it('a replayed receipt never double counts', async () => {
    addHotLeads(b.r, 1)
    const id = await makeRunning(b, { tagAsha: false })
    await tick(b)
    const wamid = recips(b, id)[0]!.wamid
    await processEvents(b.r.env, ctx, [status(wamid, 'delivered')])
    await processEvents(b.r.env, ctx, [status(wamid, 'delivered')])
    expect(bcRow(b, id).delivered).toBe(1)
  })
  it('a failed status marks the recipient failed and moves the counters', async () => {
    addHotLeads(b.r, 1)
    const id = await makeRunning(b, { tagAsha: false })
    await tick(b)
    const wamid = recips(b, id)[0]!.wamid
    await processEvents(b.r.env, ctx, [status(wamid, 'failed', [{ code: 131026, title: 'Undeliverable' }])])
    expect(recips(b, id)[0]).toMatchObject({ status: 'failed', error_code: 131026 })
    expect(bcRow(b, id)).toMatchObject({ sent: 0, failed: 1 })
  })
  it('Meta 131050 arriving as a status opts the contact out', async () => {
    addHotLeads(b.r, 1)
    const id = await makeRunning(b, { tagAsha: false })
    await tick(b)
    const wamid = recips(b, id)[0]!.wamid
    await processEvents(b.r.env, ctx, [status(wamid, 'failed', [{ code: 131050, title: 'stopped' }])])
    expect(contact(2)).toMatchObject({ opt_out_source: 'meta_131050' })
    expect(contact(2).opted_out_at).toBeTruthy()
  })
  it('a status for an ordinary (non-broadcast) message leaves broadcasts alone', async () => {
    await processEvents(b.r.env, ctx, [status('wamid.NOPE', 'delivered')])
    expect(b.r.raw.prepare(`SELECT COUNT(*) AS n FROM broadcast_recipients`).get()).toMatchObject({ n: 0 })
  })
})
