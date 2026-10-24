import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cancel, requeueUnknown, resume } from '../src/broadcasts/store'
import { addHotLeads, bcRig, bcRow, errResp, makeRunning, nowS, phoneOf, recips, seedTemplate, tick, type Bc } from './broadcast.helpers'

let b: Bc
beforeEach(async () => { b = await bcRig(); seedTemplate(b.r) })
afterEach(() => { vi.unstubAllGlobals() })

const sentTo = () => b.gw.calls.map((c) => c.body?.to)

describe('the step sends, paces and settles', () => {
  it('sends one template to each recipient, writes the inbox rows and finishes the broadcast', async () => {
    addHotLeads(b.r, 3)
    const id = await makeRunning(b)
    const res = await tick(b)
    expect(res).toMatchObject({ broadcast: id, sent: 4 })
    expect(b.gw.calls).toHaveLength(4)
    expect(JSON.stringify(b.gw.calls[1]!.body)).toContain('promo')
    expect(recips(b, id).map((x) => x.status)).toEqual(['sent', 'sent', 'sent', 'sent'])
    expect(bcRow(b, id)).toMatchObject({ status: 'finished', sent: 4, total: 4 })
    const msgs = b.r.raw.prepare(`SELECT contact_id,type,origin,wamid FROM messages WHERE direction='out' ORDER BY id`).all() as any[]
    expect(msgs).toHaveLength(4)
    expect(msgs[0]).toMatchObject({ type: 'template' })
    expect(String(msgs[0].origin)).toContain(id)
    expect(b.r.raw.prepare(`SELECT COUNT(*) AS n FROM conversations`).get()).toMatchObject({ n: 4 })
  })

  it('respects broadcast_per_minute', async () => {
    addHotLeads(b.r, 9)
    b.r.raw.prepare(`INSERT INTO settings (key,value) VALUES ('broadcast_per_minute','3')`).run()
    const id = await makeRunning(b)
    expect(await tick(b)).toMatchObject({ sent: 3 })
    expect(bcRow(b, id)).toMatchObject({ status: 'running', sent: 3 })
    expect(await tick(b)).toMatchObject({ sent: 3 })
  })

  it('stays inside the subrequest budget handed to it, and stops cleanly when it runs out', async () => {
    addHotLeads(b.r, 30)
    const id = await makeRunning(b)
    const res = await tick(b, { dbBudget: 40, subrequestBudget: 20 })
    expect(res.sent).toBeGreaterThan(0)
    expect(res.dbCalls + res.subrequests).toBeLessThanOrEqual(20)
    expect(bcRow(b, id).status).toBe('running')
    const none = await tick(b, { dbBudget: 40, subrequestBudget: 5 })
    expect(none.sent).toBe(0)
    expect(recips(b, id).filter((x) => x.status === 'sending')).toHaveLength(0)
  })

  it('stays inside the D1 call budget handed to it', async () => {
    addHotLeads(b.r, 30)
    await makeRunning(b)
    const res = await tick(b, { dbBudget: 10, subrequestBudget: 48 })
    expect(res.dbCalls).toBeLessThanOrEqual(10)
  })

  it('with a full idle budget the default pace of 20 fits inside 48 subrequests', async () => {
    addHotLeads(b.r, 40)
    await makeRunning(b)
    const res = await tick(b, { dbBudget: 40, subrequestBudget: 48 })
    expect(res.sent).toBeLessThanOrEqual(20)
    expect(res.sent).toBeGreaterThanOrEqual(18)
    expect(res.dbCalls + res.subrequests).toBeLessThanOrEqual(48)
  })

  it('runs one broadcast at a time; the next waits in queued', async () => {
    addHotLeads(b.r, 2)
    const a = await makeRunning(b)
    const c = await makeRunning(b)
    b.r.raw.prepare(`UPDATE broadcasts SET created_at=created_at-10 WHERE id=?`).run(a)
    await tick(b)
    expect(bcRow(b, a).status).toBe('finished')
    expect(bcRow(b, c).status).toBe('queued')
    await tick(b)
    expect(bcRow(b, c).status).toBe('finished')
  })
})

describe('opt-out', () => {
  it('an opted-out contact never receives a broadcast, even if they opt out after the start', async () => {
    const ids = addHotLeads(b.r, 3)
    const id = await makeRunning(b)
    b.r.raw.prepare(`UPDATE contacts SET opted_out_at=?, opt_out_source='keyword' WHERE id=?`).run(nowS(), ids[0])
    await tick(b)
    expect(b.gw.calls).toHaveLength(3)
    expect(sentTo()).not.toContain(phoneOf(ids[0]!))
    expect(recips(b, id).find((x) => x.contact_id === String(ids[0]))!.status).toBe('skipped')
  })

  it('a contact who opts out in the middle of a tick is skipped before their message', async () => {
    const ids = addHotLeads(b.r, 4)
    const id = await makeRunning(b)
    b.gw.route = (n) => { if (n === 1) b.r.raw.prepare(`UPDATE contacts SET opted_out_at=?, opt_out_source='keyword' WHERE id=?`).run(nowS(), ids[3]); return undefined }
    await tick(b)
    expect(sentTo()).not.toContain(phoneOf(ids[3]!))
    expect(recips(b, id).find((x) => x.contact_id === String(ids[3]))!.status).toBe('skipped')
    expect(b.gw.calls).toHaveLength(4)
  })
})

describe('cancel and pause', () => {
  it('a cancel that lands during a send stops every later send', async () => {
    addHotLeads(b.r, 6)
    const id = await makeRunning(b)
    b.gw.route = (n) => { if (n === 2) b.r.raw.prepare(`UPDATE broadcasts SET status='cancelled' WHERE id=?`).run(id); return undefined }
    await tick(b)
    expect(b.gw.calls).toHaveLength(2)
    expect(recips(b, id).filter((x) => x.status === 'sending')).toHaveLength(0)
    expect(recips(b, id).filter((x) => x.status === 'sent')).toHaveLength(2)
    expect(bcRow(b, id).status).toBe('cancelled')
  })

  it('a pause during a send stops every later send, and resume continues without repeats', async () => {
    addHotLeads(b.r, 5)
    const id = await makeRunning(b)
    b.gw.route = (n) => { if (n === 2) b.r.raw.prepare(`UPDATE broadcasts SET status='paused' WHERE id=?`).run(id); return undefined }
    await tick(b)
    expect(b.gw.calls).toHaveLength(2)
    b.gw.route = () => undefined
    expect((await tick(b)).sent).toBe(0)
    await resume(b.r.env, id)
    await tick(b)
    expect(b.gw.calls).toHaveLength(6)
    expect(new Set(sentTo()).size).toBe(6)
  })

  it('cancel() skips every queued recipient and nothing is sent', async () => {
    addHotLeads(b.r, 3)
    const id = await makeRunning(b)
    await cancel(b.r.env, id)
    expect(recips(b, id).every((x) => x.status === 'skipped')).toBe(true)
    expect((await tick(b)).sent).toBe(0)
    expect(b.gw.calls).toHaveLength(0)
  })
})

describe('idempotency', () => {
  it('overlapping and repeated ticks never send twice to the same contact', async () => {
    addHotLeads(b.r, 5)
    const id = await makeRunning(b)
    await Promise.all([tick(b), tick(b)])
    await tick(b); await tick(b)
    expect(new Set(sentTo()).size).toBe(sentTo().length)
    expect(sentTo()).toHaveLength(6)
    expect(bcRow(b, id).status).toBe('finished')
  })

  it('a row left in sending by a dead tick is reaped to unknown after 10 minutes, never re-sent', async () => {
    addHotLeads(b.r, 1)
    const id = await makeRunning(b, { tagAsha: false })
    b.r.raw.prepare(`UPDATE broadcast_recipients SET status='sending', attempts=1, updated_at=? WHERE broadcast_id=?`).run(nowS() - 700, id)
    await tick(b)
    expect(b.gw.calls).toHaveLength(0)
    expect(recips(b, id)[0]).toMatchObject({ status: 'unknown' })
    expect(bcRow(b, id)).toMatchObject({ status: 'finished', failed: 1 })
  })

  it('an adaptor timeout leaves the row unknown and halts the step; it is not retried', async () => {
    addHotLeads(b.r, 3)
    const id = await makeRunning(b)
    b.gw.route = (n) => { if (n === 2) throw new Error('network timeout'); return undefined }
    const res = await tick(b)
    expect(res.unknown).toBe(1)
    expect(recips(b, id).filter((x) => x.status === 'unknown')).toHaveLength(1)
    b.gw.route = () => undefined
    await tick(b)
    expect(new Set(sentTo()).size).toBe(sentTo().length)
    expect(recips(b, id).filter((x) => x.status === 'unknown')).toHaveLength(1)
  })

  it('requeue-unknown is the only way an unknown recipient is sent again', async () => {
    addHotLeads(b.r, 1)
    const id = await makeRunning(b, { tagAsha: false })
    b.gw.route = () => { throw new Error('timeout') }
    await tick(b)
    expect(recips(b, id)[0]!.status).toBe('unknown')
    b.gw.route = () => undefined
    await requeueUnknown(b.r.env, id)
    await tick(b)
    expect(recips(b, id)[0]!.status).toBe('sent')
  })
})

describe('error classes', () => {
  it('a recipient-final error fails only that recipient and the rest are sent', async () => {
    addHotLeads(b.r, 3)
    const id = await makeRunning(b)
    b.gw.route = (n) => (n === 2 ? errResp(131026, 400, 'Message undeliverable') : undefined)
    await tick(b)
    const st = recips(b, id).map((x) => x.status)
    expect(st.filter((s) => s === 'failed')).toHaveLength(1)
    expect(st.filter((s) => s === 'sent')).toHaveLength(3)
    expect(recips(b, id).find((x) => x.status === 'failed')).toMatchObject({ error_code: 131026 })
    expect(bcRow(b, id)).toMatchObject({ status: 'finished', failed: 1, sent: 3 })
  })

  it.each([[131048], [132000], [132001], [131042], [131031], [133010]])('account-level error %i pauses the broadcast with a reason and requeues the recipient', async (code) => {
    addHotLeads(b.r, 3)
    const id = await makeRunning(b)
    b.gw.route = (n) => (n === 2 ? errResp(code, 400, 'account problem') : undefined)
    const res = await tick(b)
    expect(res.paused).toBeTruthy()
    const row = bcRow(b, id)
    expect(row.status).toBe('paused')
    expect(row.pause_reason).toContain(String(code))
    expect(recips(b, id).filter((x) => x.status === 'queued')).toHaveLength(3)
    expect(recips(b, id).filter((x) => x.status === 'sent')).toHaveLength(1)
    expect(b.gw.calls).toHaveLength(2)
  })

  it('an expired token (HTTP 401) pauses the broadcast', async () => {
    addHotLeads(b.r, 2)
    const id = await makeRunning(b)
    b.gw.route = () => errResp(190, 401, 'token expired')
    await tick(b)
    expect(bcRow(b, id).status).toBe('paused')
  })

  it('a retryable error backs the recipient off and retries later; three attempts fail it', async () => {
    addHotLeads(b.r, 1)
    const id = await makeRunning(b, { tagAsha: false })
    b.gw.route = () => errResp(131000, 500, 'something went wrong')
    const t0 = nowS()
    await tick(b, { now: t0 })
    expect(recips(b, id)[0]).toMatchObject({ status: 'queued', attempts: 1 })
    const due = b.r.raw.prepare(`SELECT next_attempt_at FROM broadcast_recipients WHERE broadcast_id=?`).get(id) as any
    expect(due.next_attempt_at).toBeGreaterThan(t0)
    const calls = b.gw.calls.length
    await tick(b, { now: t0 + 5 })
    expect(b.gw.calls.length).toBe(calls)
    await tick(b, { now: t0 + 100 })
    await tick(b, { now: t0 + 1000 })
    expect(recips(b, id)[0]).toMatchObject({ status: 'failed', attempts: 3 })
    expect(bcRow(b, id).status).toBe('finished')
  })

  it('a throttle (HTTP 429) backs off and stops the rest of the step', async () => {
    addHotLeads(b.r, 4)
    const id = await makeRunning(b)
    b.gw.route = (n) => (n === 2 ? errResp(130429, 429, 'rate') : undefined)
    await tick(b)
    expect(b.gw.calls).toHaveLength(2)
    expect(bcRow(b, id).status).toBe('running')
    expect(recips(b, id).filter((x) => x.status === 'sent')).toHaveLength(1)
  })

  it('Meta 131050 on a send marks the contact opted out with source meta_131050', async () => {
    addHotLeads(b.r, 2)
    const id = await makeRunning(b)
    b.gw.route = (n) => (n === 2 ? errResp(131050, 400, 'user stopped marketing messages') : undefined)
    await tick(b)
    const out = b.r.raw.prepare(`SELECT id,opted_out_at,opt_out_source FROM contacts WHERE opt_out_source='meta_131050'`).all() as any[]
    expect(out).toHaveLength(1)
    expect(out[0].opted_out_at).toBeTruthy()
    expect(recips(b, id).filter((x) => x.error_code === 131050)).toHaveLength(1)
  })

  it('a template that stops being approved pauses the broadcast without sending', async () => {
    addHotLeads(b.r, 2)
    const id = await makeRunning(b)
    b.r.raw.prepare(`UPDATE templates SET status='PAUSED'`).run()
    await tick(b)
    expect(b.gw.calls).toHaveLength(0)
    expect(bcRow(b, id).status).toBe('paused')
    expect(bcRow(b, id).pause_reason).toMatch(/template/i)
  })
})

describe('review fixes', () => {
  const stored = (wamid: string, status: string, raw: unknown = {}) =>
    b.r.raw.prepare(`INSERT INTO message_statuses (wamid,status,timestamp,raw) VALUES (?,?,?,?)`).run(wamid, status, nowS(), JSON.stringify(raw))

  it('a read receipt that beats the sent-write advances the recipient to read and fixes the counters', async () => {
    const id = await makeRunning(b)
    b.gw.route = (n) => { if (n === 1) { stored('wamid.B1', 'delivered'); stored('wamid.B1', 'read') } return undefined }
    await tick(b)
    expect(recips(b, id)[0]).toMatchObject({ status: 'read', wamid: 'wamid.B1' })
    expect(bcRow(b, id)).toMatchObject({ sent: 1, delivered: 1, read: 1, failed: 0 })
  })

  it('a 131050 failure that beats the sent-write fails the recipient and opts the contact out', async () => {
    const id = await makeRunning(b)
    b.gw.route = (n) => { if (n === 1) stored('wamid.B1', 'failed', { errors: [{ code: 131050, title: 'user stopped marketing messages' }] }); return undefined }
    await tick(b)
    expect(recips(b, id)[0]).toMatchObject({ status: 'failed', error_code: 131050 })
    expect(bcRow(b, id)).toMatchObject({ sent: 0, failed: 1 })
    expect(b.r.raw.prepare(`SELECT opt_out_source FROM contacts WHERE id=1`).get()).toMatchObject({ opt_out_source: 'meta_131050' })
    expect((b.r.raw.prepare(`SELECT opted_out_at FROM contacts WHERE id=1`).get() as any).opted_out_at).toBeTruthy()
  })

  it('a contact who opts out between the candidate select and the claim is not sent and is counted as skipped', async () => {
    const ids = addHotLeads(b.r, 2)
    const id = await makeRunning(b)
    const real = b.r.env.DB
    b.r.env = { ...b.r.env, DB: new Proxy(real, { get(t, p) {
      if (p === 'prepare') return (sql: string) => {
        if (sql.startsWith(`UPDATE broadcast_recipients SET status='sending'`)) b.r.raw.prepare(`UPDATE contacts SET opted_out_at=?, opt_out_source='keyword' WHERE id=?`).run(nowS(), ids[1])
        return t.prepare(sql)
      }
      const v = Reflect.get(t, p, t) as unknown
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v
    } }) }
    const res = await tick(b)
    expect(sentTo()).not.toContain(phoneOf(ids[1]!))
    expect(res).toMatchObject({ sent: 2, skipped: 1 })
    expect(recips(b, id).find((x) => x.contact_id === String(ids[1]))!.status).toBe('skipped')
  })
})
