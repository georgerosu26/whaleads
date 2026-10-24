// build a flow in the browser (create, trigger, message, connect), save, test, publish, then watch a real signed
// webhook run it and show up live in the Runs tab and on the lead's timeline. Local D1 only.
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { encryptJson } from '../../src/crypto'
import { envelope, sign } from '../helpers'

const SETUP_KEY = 'e2e-local-session-secret-0123456789'
const WH_SECRET = 'whsec_TEST_e2e_local_0000'
const PHONE_NUMBER_ID = '1000000000000001'
const SHOTS = 'docs/screenshots'

async function connectWhaBuzz() {
  const blob = await encryptJson(SETUP_KEY, { api_key: 'wbk_TEST_e2e_local_0000', phone_number_id: PHONE_NUMBER_ID, waba_id: '1000000000002', webhook_secret: WH_SECRET })
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', '--persist-to', '.e2e-state', '--command',
    `INSERT INTO adaptor_config (id,kind,config_enc,updated_at) VALUES (1,'whabuzz','${blob}',unixepoch()) ON CONFLICT(id) DO UPDATE SET kind='whabuzz', config_enc=excluded.config_enc`], { stdio: 'pipe' })
}
function inboundBody(wamid: string, from: string, name: string, text: string) {
  const f = JSON.parse(readFileSync(new URL('../fixtures/text.json', import.meta.url), 'utf8'))
  const v = f.entry[0].changes[0].value
  v.contacts = [{ profile: { name }, wa_id: from }]
  v.messages = [{ from, id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }]
  return JSON.stringify(envelope('message.inbound', f))
}
async function postHook(page: Page, body: string) {
  const res = await page.request.post('/webhooks/whabuzz', { data: body, headers: { 'content-type': 'application/json', 'X-WhaBuzz-Signature': sign([WH_SECRET], body, Math.floor(Date.now() / 1000)) } })
  expect(res.status()).toBe(200)
}

const MOCK_PORT = Number(process.env.PW_PORT ?? 8799) + 1
let mock: Server
const sent: any[] = []
test.beforeAll(async () => {
  mock = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      if (req.method === 'POST' && (req.url ?? '').startsWith('/v1/messages')) { sent.push(JSON.parse(Buffer.concat(chunks).toString() || '{}')); res.end(JSON.stringify({ messages: [{ id: `wamid.FLOWUI_${sent.length}` }] })); return }
      res.end('{}')
    })
  })
  await new Promise<void>((r) => mock.listen(MOCK_PORT, '127.0.0.1', r))
})
test.afterAll(() => { mock?.close() })
// WebKit refuses a Secure cookie on http://localhost (Chromium allows it), so the saved session is re-added as non-Secure there.
test.beforeEach(async ({ context, browserName }) => {
  if (browserName !== 'webkit') return
  const saved = JSON.parse(readFileSync('test/e2e/.auth/admin.json', 'utf8')) as { cookies: { name: string; value: string }[] }
  await context.addCookies(saved.cookies.map((c) => ({ name: c.name, value: c.value, url: `http://localhost:${process.env.PW_PORT ?? 8799}`, httpOnly: true })))
})

const d1 = (sql: string) => JSON.parse(execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', '--persist-to', '.e2e-state', '--json', '--command', sql], { stdio: 'pipe' }).toString())[0].results as any[]

async function center(page: Page, sel: string) {
  const b = await page.locator(sel).first().boundingBox()
  if (!b) throw new Error(`no box for ${sel}`)
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}

test('build, test and publish a flow in the browser; a real webhook run shows up live', async ({ page, context }) => {
  test.setTimeout(150_000)
  await page.setViewportSize({ width: 1280, height: 800 })
  await connectWhaBuzz()
  // The lead exists first (no flow is live yet, so this starts nothing).
  await postHook(page, inboundBody('wamid.E2E_S6D_0', '15550002222', 'Meera', 'hello'))
  const leadId = await expect.poll(() => d1(`SELECT id FROM leads ORDER BY id DESC LIMIT 1`)[0]?.id).toBeTruthy().then(() => d1(`SELECT id FROM leads ORDER BY id DESC LIMIT 1`)[0].id as number)

  // Create.
  await page.goto('/automations')
  await expect(page.getByRole('heading', { name: 'Automations' })).toBeVisible()
  await page.getByTestId('new-flow').click()
  await page.getByLabel('Name').fill('e2e hi reply')
  await page.getByTestId('create-flow').click()
  await expect(page).toHaveURL(/\/automations\/\d+$/)
  const flowId = Number(page.url().split('/').pop())
  await expect(page.getByTestId('flow-canvas')).toBeVisible()

  // Trigger: a message containing "hi".
  await page.locator('[data-node-id="trigger"]').click()
  await page.locator('#t-kind').selectOption('message_received')
  await page.locator('#t-match').selectOption('keyword')
  await page.locator('#t-kw').fill('hi')

  // Message node, from the palette.
  await page.getByTestId('palette-message').click()
  await page.locator('#m-text').fill('Hi {{lead.name}}, thanks for writing in.')
  await expect(page.locator('[data-node-id][data-node-type="message"]')).toHaveCount(1)

  // Connect trigger.out -> message.
  await page.keyboard.press('Escape')
  const from = await center(page, '[data-port-out="trigger:out"]')
  const to = await center(page, '[data-node-id][data-node-type="message"] [data-drag]')
  await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 }); await page.mouse.move(to.x, to.y, { steps: 6 }); await page.mouse.up()
  await expect(page.locator('[data-testid="flow-canvas"] path[data-conn]')).toHaveCount(1)

  // Shadow is on for a new flow: turn it off so the reply is really sent.
  await expect(page.getByTestId('shadow-toggle')).toBeChecked()
  await page.getByTestId('shadow-toggle').uncheck()
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 })
  const row = d1(`SELECT shadow, graph FROM flows WHERE id=${flowId}`)[0]
  expect(row.shadow).toBe(0)
  expect(JSON.parse(row.graph).connections).toHaveLength(1)
  await page.screenshot({ path: `${SHOTS}/flow-editor-1280.png` })

  // Dry run from the Test panel.
  await page.getByTestId('open-test').click()
  await page.locator('#test-lead-q').fill('Meera')
  await page.getByTestId('test-lead-results').getByRole('button').first().click()
  await page.locator('#test-event').fill('hi there')
  await page.getByTestId('run-dry').click()
  await expect(page.getByTestId('dry-banner')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('trace').locator('li')).toHaveCount(2)
  await expect(page.getByTestId('would-send')).toContainText('thanks for writing in')
  await page.screenshot({ path: `${SHOTS}/flow-test-panel-1280.png` })
  expect(sent).toHaveLength(0) // a dry run sends nothing
  await page.getByTestId('open-test').click()

  // Publish and see the result.
  await page.getByTestId('publish-flow').click()
  await expect(page.getByTestId('publish-result')).toHaveAttribute('data-phase', 'done', { timeout: 15_000 })
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(page.getByText('Active', { exact: true }).first()).toBeVisible()

  // Live: the Runs tab here, and the lead's timeline in a second page, both open before the webhook arrives.
  await page.getByTestId('tab-runs').click()
  await expect(page.getByText('No runs yet')).toBeVisible()
  const lead = await context.newPage()
  await lead.goto(`/leads/${leadId}`)
  await expect(lead.getByRole('heading', { name: /Meera/ }).first()).toBeVisible()

  await postHook(page, inboundBody('wamid.E2E_S6D_1', '15550002222', 'Meera', 'hi'))
  await expect(page.getByTestId('run-row')).toHaveCount(1, { timeout: 15_000 })
  await expect(page.getByTestId('run-row')).toHaveAttribute('data-run-status', 'completed', { timeout: 15_000 })
  await expect(lead.getByText(/Automation: e2e hi reply/).first()).toBeVisible({ timeout: 15_000 })
  await expect.poll(() => sent.length).toBe(1)
  expect(sent[0]).toMatchObject({ type: 'text', text: { body: expect.stringContaining('thanks for writing in') } })
  await page.getByTestId('run-row').getByRole('button').first().click()
  await expect(page.getByTestId('trace')).toBeVisible()
  await page.keyboard.press('Escape')

  // List and the 360 layout.
  await page.goto('/automations')
  const mine = page.locator('[data-testid="flow-row"][data-flow-name="e2e hi reply"]')
  await expect(mine).toContainText('1 run in 7 days')
  await page.screenshot({ path: `${SHOTS}/flows-list-1280.png` })
  await page.setViewportSize({ width: 360, height: 760 })
  await page.goto(`/automations/${flowId}`)
  await expect(page.getByText(/needs a wider screen/)).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/flows-360.png` })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  // Archive through the API (local only).
  const api = { Authorization: 'Bearer e2e-local-admin-key', Origin: `http://localhost:${process.env.PW_PORT ?? 8799}` }
  expect((await page.request.post(`/api/flows/${flowId}/archive`, { headers: api })).status()).toBe(200)
})

test('an edit made just before navigating inside the app is saved, and reopening shows it', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/automations')
  await page.getByTestId('new-flow').click()
  await page.getByLabel('Name').fill('e2e leave early')
  await page.getByTestId('create-flow').click()
  await expect(page).toHaveURL(/\/automations\/\d+$/)
  const flowId = Number(page.url().split('/').pop())
  await page.locator('[data-node-id="trigger"]').click()
  await page.locator('#node-label').fill('Edited label XYZ')
  await page.waitForTimeout(150) // inside the 800 ms autosave wait
  await page.getByRole('link', { name: 'Leads' }).first().click()
  await expect.poll(async () => {
    const f = (await (await page.request.get(`/api/flows/${flowId}`)).json()).flow
    const g = typeof f.graph === 'string' ? JSON.parse(f.graph) : f.graph
    return g.nodes.find((n: { type: string }) => n.type === 'trigger').label
  }, { timeout: 10_000 }).toBe('Edited label XYZ')
  await page.goto(`/automations/${flowId}`)
  await expect(page.locator('[data-node-id="trigger"]')).toContainText('Edited label XYZ')
  const api = { Authorization: 'Bearer e2e-local-admin-key', Origin: `http://localhost:${process.env.PW_PORT ?? 8799}` }
  expect((await page.request.post(`/api/flows/${flowId}/archive`, { headers: api })).status()).toBe(200)
})

// Safari report: "drag and drop is not working in automations" and a palette step landing on the Trigger. Runs in chromium and webkit.
test('canvas: palette steps land clear of existing nodes, nodes drag, ports connect, a palette drag drops where released', async ({ page }) => {
  test.setTimeout(90_000)
  const problems: string[] = []
  page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warning') && !/Service Worker registration blocked/.test(m.text())) problems.push(`${m.type()}: ${m.text()}`) })
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
  await page.setViewportSize({ width: 2000, height: 1000 })
  await page.goto('/automations')
  await page.getByTestId('new-flow').click()
  await page.getByLabel('Name').fill('e2e canvas drag')
  await page.getByTestId('create-flow').click()
  await expect(page).toHaveURL(/\/automations\/\d+$/)
  const flowId = Number(page.url().split('/').pop())
  const graphOf = async () => {
    const f = (await (await page.request.get(`/api/flows/${flowId}`)).json()).flow
    return (typeof f.graph === 'string' ? JSON.parse(f.graph) : f.graph) as { nodes: { id: string; type: string; x: number; y: number; width: number; height: number }[]; connections: unknown[] }
  }
  const saved = () => expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 })
  await expect(page.locator('[data-node-id="trigger"]')).toBeVisible()

  // 1. A step added from the palette must not overlap any node.
  await page.getByTestId('palette-message').click()
  await expect(page.locator('[data-node-id][data-node-type="message"]')).toHaveCount(1)
  const overlaps = async () => {
    const bs = await page.locator('[data-node-id]').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { id: (e as HTMLElement).dataset.nodeId!, l: r.left, t: r.top, r: r.right, b: r.bottom } }))
    const hits: string[] = []
    for (const a of bs) for (const b of bs) if (a.id < b.id && a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b) hits.push(`${a.id}/${b.id}`)
    return hits
  }
  expect(await overlaps()).toEqual([])
  await page.keyboard.press('Escape')

  // 2. Drag the message node by 200 px (screen) and check the saved graph moved by 200 / zoom.
  const zoom = Number((await page.getByTestId('zoom-level').textContent())!.replace('%', '')) / 100
  await saved()
  const b0 = (await graphOf()).nodes.find((n) => n.type === 'message')!
  const screen0 = await page.locator('[data-node-id][data-node-type="message"]').boundingBox()
  const grab = await center(page, '[data-node-id][data-node-type="message"] [data-drag]')
  await page.mouse.move(grab.x, grab.y); await page.mouse.down()
  await page.mouse.move(grab.x + 100, grab.y + 60, { steps: 8 }); await page.mouse.move(grab.x + 200, grab.y + 120, { steps: 8 }); await page.mouse.up()
  const screen1 = await page.locator('[data-node-id][data-node-type="message"]').boundingBox()
  expect(screen1!.x - screen0!.x).toBeGreaterThan(150) // it moved on screen, not just in the saved graph
  await expect.poll(async () => (await graphOf()).nodes.find((n) => n.type === 'message')!.x - b0.x, { timeout: 10_000 }).toBeGreaterThan(150 / zoom - 20)
  const b1 = (await graphOf()).nodes.find((n) => n.type === 'message')!
  expect(b1.y - b0.y).toBeGreaterThan(90 / zoom - 20)

  // 3. Connect Trigger Next -> the node's input port.
  const from = await center(page, '[data-port-out="trigger:out"]')
  const to = await center(page, '[data-port-in]')
  await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x - 20, to.y, { steps: 10 }); await page.mouse.move(to.x, to.y, { steps: 6 }); await page.mouse.up()
  await expect(page.locator('[data-testid="flow-canvas"] path[data-conn]')).toHaveCount(1)
  await saved()
  expect((await graphOf()).connections).toHaveLength(1)

  // 4. Pan by dragging the background; the nodes move on screen.
  const pre = await page.locator('[data-node-id][data-node-type="message"]').boundingBox()
  await page.mouse.move(900, 900); await page.mouse.down(); await page.mouse.move(950, 880, { steps: 5 }); await page.mouse.up()
  const post = await page.locator('[data-node-id][data-node-type="message"]').boundingBox()
  expect(Math.round(post!.x - pre!.x)).toBe(50); expect(Math.round(post!.y - pre!.y)).toBe(-20)

  // 5. Dragging a palette step onto the canvas drops it where released.
  const cv = (await page.getByTestId('flow-canvas').boundingBox())!
  await page.getByTestId('palette-delay').dragTo(page.getByTestId('flow-canvas'), { targetPosition: { x: cv.width - 300, y: 150 } })
  await expect(page.locator('[data-node-id][data-node-type="delay"]')).toHaveCount(1)
  // The canvas re-fits after a step is added, so check the saved world coordinates: released at the far right, so right of the others.
  await expect.poll(async () => { const g = await graphOf(); const d = g.nodes.find((n) => n.type === 'delay'); return d ? d.x > Math.max(...g.nodes.filter((n) => n !== d).map((n) => n.x)) : false }, { timeout: 10_000 }).toBe(true)
  expect(await overlaps()).toEqual([])

  expect(problems).toEqual([])
  const api = { Authorization: 'Bearer e2e-local-admin-key', Origin: `http://localhost:${process.env.PW_PORT ?? 8799}` }
  expect((await page.request.post(`/api/flows/${flowId}/archive`, { headers: api })).status()).toBe(200)
})
