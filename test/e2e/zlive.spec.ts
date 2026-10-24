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

// Local WhaBuzz stand-in with a slow, sometimes failing /v1/messages (the real path takes about 3 s).
const MOCK_PORT = Number(process.env.PW_PORT ?? 8799) + 1 // matches WHABUZZ_BASE_URL in playwright.config.ts (PW_PORT + 1)
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
let mock: Server
let sends = 0
let failNext = false
test.beforeAll(async () => {
  mock = createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      const url = req.url ?? ''
      if (req.method === 'POST' && url.startsWith('/v1/media')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'mock-live-up' })); return }
      if (req.method === 'POST' && url.startsWith('/v1/messages')) {
        const fail = failNext; failNext = false
        setTimeout(() => {
          if (fail) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'upstream down' } })); return }
          res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ messages: [{ id: `wamid.LIVE_${++sends}` }] }))
        }, 2_000)
        return
      }
      res.writeHead(404); res.end('{}')
    })
  })
  await new Promise<void>((r) => mock.listen(MOCK_PORT, '127.0.0.1', r))
})
test.afterAll(() => { mock?.close() })
// A delivery receipt the way the gateway sends it: a signed WhaBuzz status webhook for the message's wamid
// (so the worker publishes the live event; writing the row behind its back would only ever be seen by the safety poll).
async function setStatus(page: Page, body: string, status: string) {
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', '--persist-to', '.e2e-state', '--json', '--command', `SELECT wamid FROM messages WHERE body='${body}' AND direction='out' ORDER BY id DESC LIMIT 1`], { stdio: 'pipe' }).toString()
  const wamid = JSON.parse(out)[0].results[0].wamid as string
  const f = JSON.parse(readFileSync(new URL('../fixtures/status_delivered.json', import.meta.url), 'utf8'))
  const st = f.entry[0].changes[0].value.statuses[0]
  Object.assign(st, { id: wamid, status, timestamp: String(Math.floor(Date.now() / 1000)) })
  f.entry[0].changes[0].value.metadata.phone_number_id = PHONE_NUMBER_ID
  await postHook(page, JSON.stringify(envelope('message.status', f)))
}

// The 'app' project starts from the signed-in storageState saved by auth.setup.ts.
async function signIn(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible()
}


test('an open thread and the list pick up a new inbound message without a reload', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await signIn(page)
  await connectWhaBuzz()
  await postHook(page, inboundBody('wamid.E2E_LIVE_1', '15550009999', 'Live Person', 'first live message'))

  await page.goto('/inbox')
  await page.getByRole('link', { name: /Live Person/ }).click()
  const thread = page.getByRole('region', { name: 'Conversation', exact: true })
  await expect(thread.getByText('first live message')).toBeVisible()
  await page.evaluate(() => { (window as any).__noReload = true })

  await postHook(page, inboundBody('wamid.E2E_LIVE_2', '15550009999', 'Live Person', 'second message arrives live'))
  await expect(thread.getByText('second message arrives live')).toBeVisible({ timeout: 6_000 })
  // the list preview follows within the 10 s list cadence, and the open thread stays read
  await expect(page.getByRole('region', { name: 'Conversations' }).getByRole('link', { name: /Live Person/ })).toContainText('second message arrives live', { timeout: 12_000 })
  await expect(page.getByRole('region', { name: 'Conversations' }).getByRole('link', { name: /Live Person/ }).getByLabel(/unread/)).toHaveCount(0, { timeout: 12_000 })
  expect(await page.evaluate(() => (window as any).__noReload === true)).toBe(true) // same document: no reload happened
})

test('sending is optimistic: bubble at once, ticks follow, failure offers retry, media shows a preview', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await signIn(page)
  await connectWhaBuzz()
  await postHook(page, inboundBody('wamid.E2E_LIVE_SEND_1', '15550006666', 'Send Person', 'please reply'))
  await page.goto('/inbox')
  await page.getByRole('link', { name: /Send Person/ }).click()
  const thread = page.getByRole('region', { name: 'Conversation', exact: true })
  const box = page.getByLabel('Message', { exact: true })
  await expect(thread.getByText('please reply')).toBeVisible()

  // text: bubble within 300 ms in the sending state, input cleared and still usable while the 2 s send runs
  await box.fill('optimistic hello')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  const bubble = thread.getByText('optimistic hello')
  await expect(bubble).toBeVisible({ timeout: 300 })
  await expect(thread.getByLabel('Sending')).toBeVisible({ timeout: 300 })
  await expect(box).toHaveValue('')
  await expect(box).toBeEnabled()
  await box.fill('typed while sending')
  await expect(box).toHaveValue('typed while sending')
  await expect(thread.getByLabel('Sent')).toBeVisible({ timeout: 6_000 })
  await expect(thread.getByLabel('Sending')).toHaveCount(0)
  await expect(thread.getByText('optimistic hello')).toHaveCount(1)
  await box.fill('')

  // ticks follow status changes made server-side (what the gateway status webhooks do), without a reload
  await setStatus(page, 'optimistic hello', 'delivered')
  await expect(thread.getByLabel('Delivered')).toBeVisible({ timeout: 6_000 })
  await setStatus(page, 'optimistic hello', 'read')
  await expect(thread.getByLabel('Read')).toBeVisible({ timeout: 6_000 })

  // failure: bubble marked failed with the reason, tap to retry resends the same text
  failNext = true
  await box.fill('will fail once')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(thread.getByText('will fail once')).toBeVisible({ timeout: 300 })
  const retry = thread.getByTestId('retry-send')
  await expect(retry).toBeVisible({ timeout: 6_000 })
  await expect(retry).toContainText('Tap to retry')
  await retry.click()
  await expect(thread.getByTestId('retry-send')).toHaveCount(0, { timeout: 6_000 })
  await expect(thread.getByText('will fail once')).toHaveCount(1)
  await expect(thread.getByLabel('Sent').last()).toBeVisible({ timeout: 6_000 })

  // media: local preview and an upload hint at once, swapped for the stored copy on completion
  await page.locator('input[type=file]').setInputFiles({ name: 'live.png', mimeType: 'image/png', buffer: PNG })
  await box.fill('with a picture')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(thread.getByRole('img', { name: 'with a picture' })).toBeVisible({ timeout: 300 })
  await expect(thread.getByTestId('uploading')).toBeVisible({ timeout: 300 })
  await expect(thread.getByTestId('uploading')).toHaveCount(0, { timeout: 8_000 })
  await expect(thread.getByRole('img', { name: 'with a picture' })).toHaveCount(1)
})
