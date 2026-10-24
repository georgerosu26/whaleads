import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { encryptJson } from '../../src/crypto'
import { envelope, sign } from '../helpers'

const SETUP_KEY = 'e2e-local-session-secret-0123456789'
const WH_SECRET = 'whsec_TEST_e2e_local_0000'
const PHONE_NUMBER_ID = '1000000000000001' // matches test/fixtures/text.json metadata

// The e2e server has no outbound network, so the WhaBuzz connection (which the UI would validate against
// api.whabuzz.com) is written straight into the local D1 with the same encryption the Worker uses.
async function connectWhaBuzz() {
  const blob = await encryptJson(SETUP_KEY, { api_key: 'wbk_TEST_e2e_local_0000', phone_number_id: PHONE_NUMBER_ID, waba_id: '1000000000002', webhook_secret: WH_SECRET })
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', '--persist-to', '.e2e-state', '--command',
    `INSERT INTO adaptor_config (id,kind,config_enc,updated_at) VALUES (1,'whabuzz','${blob}',unixepoch()) ON CONFLICT(id) DO UPDATE SET kind='whabuzz', config_enc=excluded.config_enc`], { stdio: 'pipe' })
}

// Signed WhaBuzz envelope (SPEC-v1 6.2 / 7.3) around a Meta text message. Numbers are the reserved +1 555 range.
function inboundBody(wamid: string, from: string, name: string, text: string) {
  const f = JSON.parse(readFileSync(new URL('../fixtures/text.json', import.meta.url), 'utf8'))
  const v = f.entry[0].changes[0].value
  v.contacts = [{ profile: { name }, wa_id: from }]
  v.messages = [{ from, id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }]
  return JSON.stringify(envelope('message.inbound', f))
}
async function postHook(page: Page, body: string) {
  const res = await page.request.post('/webhooks/whabuzz', {
    data: body, headers: { 'content-type': 'application/json', 'X-WhaBuzz-Signature': sign([WH_SECRET], body, Math.floor(Date.now() / 1000)) },
  })
  expect(res.status()).toBe(200)
}

// Local WhaBuzz stand-in: records what the flow's message node sends.
const MOCK_PORT = Number(process.env.PW_PORT ?? 8799) + 1
let mock: Server
const sent: any[] = []
test.beforeAll(async () => {
  mock = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      if (req.method === 'POST' && (req.url ?? '').startsWith('/v1/messages')) { sent.push(JSON.parse(Buffer.concat(chunks).toString() || '{}')); res.end(JSON.stringify({ messages: [{ id: `wamid.FLOW_${sent.length}` }] })); return }
      res.end('{}')
    })
  })
  await new Promise<void>((r) => mock.listen(MOCK_PORT, '127.0.0.1', r))
})
test.afterAll(() => { mock?.close() })

const d1 = (sql: string) => JSON.parse(execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', '--persist-to', '.e2e-state', '--json', '--command', sql], { stdio: 'pipe' }).toString())[0].results as any[]

test('a published keyword flow runs on a signed inbound webhook and its reply reaches the gateway', async ({ page }) => {
  await connectWhaBuzz()
  const nd = (id: string, type: string, data: Record<string, unknown>) => ({ id, type, label: id, x: 0, y: 0, width: 100, height: 40, data, ports: [] })
  const g = {
    nodes: [
      nd('t', 'trigger', { kind: 'message_received', match: 'keyword', keywords: ['price'] }),
      nd('m', 'message', { text: 'Hi {{sender_name}}, thanks for asking about pricing.' }),
    ],
    connections: [{ id: 'c1', fromNodeId: 't', fromPortId: 'out', toNodeId: 'm', toPortId: 'in' }],
  }
  // created and published through the API (admin bearer), not seeded into D1
  const api = { Authorization: 'Bearer e2e-local-admin-key', Origin: `http://localhost:${process.env.PW_PORT ?? 8799}` }
  const created = await page.request.post('/api/flows', { headers: api, data: { name: 'e2e price reply', reentry: 'each_event', shadow: false, graph: g } })
  expect(created.status()).toBe(201)
  const flowId = (await created.json()).flow.id as number
  const published = await page.request.post(`/api/flows/${flowId}/publish`, { headers: api })
  expect(published.status()).toBe(200)
  expect((await published.json()).flow).toMatchObject({ status: 'active', trigger_kind: 'message_received', version: 1 })

  await postHook(page, inboundBody('wamid.E2E_S6_1', '15550001111', 'Asha', 'What is the price?'))
  await expect.poll(async () => d1(`SELECT status FROM flow_runs WHERE flow_id=${flowId}`)[0]?.status, { timeout: 15_000 }).toBe('completed')
  await expect.poll(() => sent.length).toBe(1)
  expect(sent[0]).toMatchObject({ to: expect.stringContaining('15550001111'), type: 'text', text: { body: expect.stringContaining('pricing') } })
  expect(d1(`SELECT count(*) AS n FROM activity WHERE kind='flow_run'`)[0].n).toBe(2)
  const lead = d1(`SELECT lead_id FROM flow_runs WHERE flow_id=${flowId}`)[0].lead_id
  const seen = await page.request.get(`/api/leads/${lead}/flow-runs`, { headers: api })
  expect(seen.status()).toBe(200)
  expect((await seen.json()).runs).toMatchObject([{ flow_id: flowId, flow_name: 'e2e price reply', status: 'completed' }])

  // a redelivery of the same wamid and a non-matching message start nothing
  await postHook(page, inboundBody('wamid.E2E_S6_1', '15550001111', 'Asha', 'What is the price?'))
  await postHook(page, inboundBody('wamid.E2E_S6_2', '15550001111', 'Asha', 'hello'))
  await new Promise((r) => setTimeout(r, 1000))
  expect(d1(`SELECT count(*) AS n FROM flow_runs`)[0].n).toBe(1)
  expect(sent).toHaveLength(1)
})
