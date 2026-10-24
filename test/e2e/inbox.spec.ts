import { execFileSync } from 'node:child_process'
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

// The 'app' project starts from the signed-in storageState saved by auth.setup.ts.
async function signIn(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible()
}

test('empty inbox, then a webhook shows an unread conversation; opening it marks it read', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 })
  await signIn(page)
  await connectWhaBuzz()

  await page.goto('/inbox')
  await expect(page.getByText('No conversations yet')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  await postHook(page, inboundBody('wamid.E2E_S4A_1', '15550001234', 'Test Person', 'Hello, is anyone there? '.repeat(6).trim()))
  // a duplicate delivery must not double the count
  await postHook(page, inboundBody('wamid.E2E_S4A_1', '15550001234', 'Test Person', 'Hello, is anyone there? '.repeat(6).trim()))

  await page.goto('/inbox')
  const row = page.getByRole('link', { name: /Test Person/ })
  await expect(row).toBeVisible()
  await expect(row.getByLabel('1 unread')).toBeVisible()
  await expect(page.getByTestId('unread-badge')).toHaveText('1')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: 'docs/screenshots/inbox-list-360.png' })

  await row.click()
  await expect(page).toHaveURL(/\/inbox\/\d+$/)
  await expect(page.getByRole('heading', { name: 'Test Person' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Conversation' }).getByText('Hello, is anyone there?')).toBeVisible()
  await expect(page.getByRole('status')).toContainText('Reply window open')
  await expect(page.getByTestId('unread-badge')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: 'docs/screenshots/inbox-thread-360.png' })

  // server-side state: no longer unread
  await page.goto('/inbox')
  await expect(page.getByRole('link', { name: /Test Person/ }).getByLabel(/unread/)).toHaveCount(0)
  await expect(page.getByTestId('unread-badge')).toHaveCount(0)

  // assign and close from the thread
  await page.getByRole('link', { name: /Test Person/ }).click()
  await page.getByRole('button', { name: 'Assign to me' }).click()
  await expect(page.getByRole('button', { name: 'Unassign' })).toBeVisible()
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Reopen' })).toBeVisible()
})

test('split view at 1280 with the thread beside the list', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await signIn(page)
  await postHook(page, inboundBody('wamid.E2E_S4A_2', '15550004321', 'Second Person', 'Second message'))
  await page.goto('/inbox')
  await page.getByRole('link', { name: /Second Person/ }).click()
  await expect(page.getByRole('heading', { name: 'Second Person' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Conversations' })).toBeVisible()
  await expect(page.getByTestId('unread-badge-side')).toHaveCount(0)
  await page.screenshot({ path: 'docs/screenshots/inbox-1280.png' })
})
