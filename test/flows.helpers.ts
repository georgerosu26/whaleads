// Shared fixtures for the flow engine tests: a migrated in-memory D1, a seeded lead, and a tiny graph builder.
import type { DatabaseSync } from 'node:sqlite'
import { ensureSchema, type Env } from '../src/db'
import type { FlowRow } from '../src/flows/engine'
import type { FlowConnection, FlowData, FlowNode, NodeType } from '../src/flows/types'
import { fakeD1 } from './d1'

export interface Rig { env: Env; raw: DatabaseSync; leadId: number; contactId: number }

export async function rig(): Promise<Rig> {
  const f = fakeD1()
  const env = { DB: f.d1, ADMIN_KEY: 'k', SESSION_SECRET: 'test-session-secret-0123456789', INSTANCE_NAME: 'inst' } as unknown as Env
  await ensureSchema(f.d1)
  f.raw.exec(`INSERT INTO contacts (id,wa_id,phone,name) VALUES (1,'15550000001','15550000001','Asha Rao')`)
  f.raw.exec(`INSERT INTO leads (id,contact_id,source,status) VALUES (1,1,'whatsapp','new')`)
  f.raw.exec(`INSERT INTO tags (label,color) VALUES ('hot','#f00'),('vip','#00f')`)
  return { env, raw: f.raw, leadId: 1, contactId: 1 }
}

export const node = (id: string, type: NodeType, data: Record<string, unknown> = {}): FlowNode => ({ id, type, label: id, x: 0, y: 0, width: 100, height: 40, data, ports: [] })
let cid = 0
export const edge = (from: string, port: string, to: string): FlowConnection => ({ id: `c${++cid}`, fromNodeId: from, fromPortId: port, toNodeId: to, toPortId: 'in' })
export const graph = (nodes: FlowNode[], connections: FlowConnection[]): FlowData => ({ nodes, connections })
export const trigger = (kind = 'lead_created') => node('t', 'trigger', { kind })

/** Inserts an active flow whose published graph is `g`; returns the row shape the engine takes. */
export function addFlow(raw: DatabaseSync, g: FlowData, o: { id?: number; name?: string; shadow?: 0 | 1; reentry?: 'once' | 'each_event'; status?: string } = {}): FlowRow {
  const id = o.id ?? 1
  const json = JSON.stringify(g)
  raw.prepare(`INSERT INTO flows (id,name,status,shadow,reentry,trigger_kind,graph,published_graph,version) VALUES (?,?,?,?,?,?,?,?,1)`)
    .run(id, o.name ?? `flow-${id}`, o.status ?? 'active', o.shadow ?? 0, o.reentry ?? 'once', String(g.nodes.find((n) => n.type === 'trigger')?.data?.kind ?? 'lead_created'), json, json)
  return { id, name: o.name ?? `flow-${id}`, status: o.status ?? 'active', shadow: o.shadow ?? 0, reentry: o.reentry ?? 'once', version: 1, graph: json, published_graph: json }
}

export const lead = { id: 1, contact_id: 1 }
export const runRow = (raw: DatabaseSync, id: number) => raw.prepare(`SELECT * FROM flow_runs WHERE id=?`).get(id) as any
export const acts = (raw: DatabaseSync, leadId = 1) => raw.prepare(`SELECT kind,actor,data FROM activity WHERE lead_id=? ORDER BY id`).all(leadId) as { kind: string; actor: string; data: string | null }[]
export const traceOf = (raw: DatabaseSync, id: number) => JSON.parse(runRow(raw, id).trace) as { node: string; port: string | null; status: string; note?: string }[]
