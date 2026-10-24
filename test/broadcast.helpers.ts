// Fixtures for the broadcast tests: a migrated D1, a WhaBuzz adaptor with a scripted gateway, N tagged leads, an APPROVED template.
import { vi } from 'vitest'
import { saveConfig } from '../src/adaptors'
import { createDraft, start } from '../src/broadcasts/store'
import { broadcastStep, type StepResult } from '../src/broadcasts/step'
import { rig, type Rig } from './flows.helpers'

export const WB = { kind: 'whabuzz' as const, config: { api_key: 'k', phone_number_id: '1000000000000001', waba_id: '2', webhook_secret: 'whsec_TEST_x' } }
export const nowS = () => Math.floor(Date.now() / 1000)

export interface Gateway { calls: { url: string; body: any }[]; seq: number; route: (n: number, body: any) => Response | Promise<Response> | undefined }
export interface Bc { r: Rig; gw: Gateway }

/** Rig + adaptor + a fetch stub. `gw.route(n, body)` may return a custom Response for the n-th gateway call (1-based). */
export async function bcRig(): Promise<Bc> {
  const r = await rig()
  await saveConfig(r.env, WB)
  const gw: Gateway = { calls: [], seq: 0, route: () => undefined }
  vi.stubGlobal('fetch', async (url: string, init: any) => {
    let body: any = null
    try { body = init?.body ? JSON.parse(init.body) : null } catch { body = init?.body }
    gw.calls.push({ url: String(url), body })
    const n = gw.calls.length
    return (await gw.route(n, body)) ?? new Response(JSON.stringify({ messages: [{ id: `wamid.B${++gw.seq}` }] }), { status: 200 })
  })
  return { r, gw }
}

export function seedTemplate(r: Rig, o: { id?: string; status?: string; category?: string; bp?: number } = {}) {
  const bp = o.bp ?? 1
  r.raw.prepare(`INSERT INTO templates (id,name,language,category,status,components,header_format,body_params_count,header_params_count,synced_at) VALUES (?,?,?,?,?,?,?,?,0,?)`)
    .run(o.id ?? 't1', 'promo', 'en', o.category ?? 'MARKETING', o.status ?? 'APPROVED', JSON.stringify([{ type: 'BODY', text: bp ? 'Hi {{1}}, our offer.' : 'Our offer.' }]), 'NONE', bp, nowS())
}

/** Adds `n` contacts (ids from 2) each with one lead tagged 'hot' (tag 1). Returns their contact ids. */
export function addHotLeads(r: Rig, n: number, from = 2): number[] {
  const ids: number[] = []
  for (let i = 0; i < n; i++) {
    const id = from + i
    const phone = `1555000${String(id).padStart(4, '0')}`
    r.raw.prepare(`INSERT INTO contacts (id,wa_id,phone,name) VALUES (?,?,?,?)`).run(id, phone, phone, `Person ${id}`)
    r.raw.prepare(`INSERT INTO leads (id,contact_id,source,status) VALUES (?,?,?,?)`).run(id, id, 'whatsapp', 'new')
    r.raw.prepare(`INSERT INTO lead_tags (lead_id,tag_id) VALUES (?,1)`).run(id)
    ids.push(id)
  }
  return ids
}

export const phoneOf = (id: number) => `1555000${String(id).padStart(4, '0')}`
export const PARAMS = { body: [{ kind: 'field', field: 'contact.name', fallback: 'there' }] }
export const HOT = { tags: [1] }

/** Draft + start through the real store functions; returns the broadcast id. Lead 1 (Asha) is tagged 'hot' unless told not to. */
export async function makeRunning(b: Bc, o: { filter?: unknown; params?: unknown; tagAsha?: boolean } = {}): Promise<string> {
  if (o.tagAsha !== false) b.r.raw.prepare(`INSERT OR IGNORE INTO lead_tags (lead_id,tag_id) VALUES (1,1)`).run()
  const d = await createDraft(b.r.env, { name: 'Promo', template_id: 't1', params: o.params ?? PARAMS, filter: o.filter ?? HOT }, null)
  const total = (b.r.raw.prepare(`SELECT COUNT(DISTINCT l.contact_id) AS n FROM leads l JOIN lead_tags t ON t.lead_id=l.id JOIN contacts c ON c.id=l.contact_id WHERE t.tag_id=1 AND c.opted_out_at IS NULL`).get() as any).n
  await start(b.r.env, d.id, total)
  return d.id
}

export const tick = (b: Bc, o: Partial<{ dbBudget: number; subrequestBudget: number; now: number }> = {}): Promise<StepResult> =>
  broadcastStep(b.r.env, { dbBudget: 40, subrequestBudget: 48, ...o })

export const recips = (b: Bc, id: string) => b.r.raw.prepare(`SELECT contact_id,status,wamid,error_code,attempts FROM broadcast_recipients WHERE broadcast_id=? ORDER BY CAST(contact_id AS INTEGER)`).all(id) as any[]
export const bcRow = (b: Bc, id: string) => b.r.raw.prepare(`SELECT * FROM broadcasts WHERE id=?`).get(id) as any
export const errResp = (code: number, status = 400, message = 'err') => new Response(JSON.stringify({ error: { code, message } }), { status })
