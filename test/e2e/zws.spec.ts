// D20 live channel e2e: events over the WebSocket land inside 1 s; with the socket blocked, polling still delivers.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { encryptJson } from '../../src/crypto'
import { envelope, sign } from '../helpers'

const SETUP_KEY = 'e2e-local-session-secret-0123456789'
const WH_SECRET = 'whsec_TEST_e2e_local_0000'
const PHONE_NUMBER_ID = '1000000000000001'

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
  const res = await page.request.post('/webhooks/whabuzz', {
    data: body, headers: { 'content-type': 'application/json', 'X-WhaBuzz-Signature': sign([WH_SECRET], body, Math.floor(Date.now() / 1000)) },
  })
  expect(res.status()).toBe(200)
}
async function signIn(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible()
}

test('live socket: bubble, list preview and unread badge update inside 1 s; blocked socket falls back to polling', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await signIn(page)
  await connectWhaBuzz()
  await postHook(page, inboundBody('wamid.E2E_WS_A1', '15550007001', 'Socket Person', 'ws first'))
  await postHook(page, inboundBody('wamid.E2E_WS_B1', '15550007002', 'Socket Other', 'other first'))

  await page.goto('/inbox')
  await page.getByRole('link', { name: /Socket Person/ }).click()
  const thread = page.getByRole('region', { name: 'Conversation', exact: true })
  const list = page.getByRole('region', { name: 'Conversations' })
  await expect(thread.getByText('ws first')).toBeVisible()
  await expect(page.locator('[data-live]').first()).toHaveAttribute('data-live', 'open', { timeout: 5_000 })
  await page.evaluate(() => { (window as any).__noReload = true })

  // open thread: bubble and list preview, well inside the slow safety poll (30 s / 60 s)
  await postHook(page, inboundBody('wamid.E2E_WS_A2', '15550007001', 'Socket Person', 'ws second'))
  await expect(thread.getByText('ws second')).toBeVisible({ timeout: 1_000 })
  await expect(list.getByRole('link', { name: /Socket Person/ })).toContainText('ws second', { timeout: 1_000 })

  // another conversation: preview and unread badge
  await postHook(page, inboundBody('wamid.E2E_WS_B2', '15550007002', 'Socket Other', 'other second'))
  const other = list.getByRole('link', { name: /Socket Other/ })
  await expect(other).toContainText('other second', { timeout: 1_000 })
  await expect(other.getByLabel(/unread/)).toBeVisible({ timeout: 1_000 })
  expect(await page.evaluate(() => (window as any).__noReload === true)).toBe(true)

  // block the socket (new connections abort), reload: the fast poll takes over
  await page.route(/\/api\/live/, (r) => r.abort()) // plain HTTP view of the same URL
  await page.routeWebSocket(/\/api\/live/, (ws) => ws.close({ code: 1011, reason: 'blocked by test' })) // page.route does not see WebSockets
  await page.reload()
  await page.getByRole('link', { name: /Socket Person/ }).click()
  await expect(thread.getByText('ws second')).toBeVisible()
  await expect(page.locator('[data-live]').first()).not.toHaveAttribute('data-live', 'open', { timeout: 5_000 })
  await postHook(page, inboundBody('wamid.E2E_WS_A3', '15550007001', 'Socket Person', 'ws third via polling'))
  await expect(thread.getByText('ws third via polling')).toBeVisible({ timeout: 6_000 })
})

test('a deactivated person loses the open socket within 2 s (close 4001), and no further events arrive', async ({ browser, baseURL, page }) => {
  const origin = new URL(baseURL!).origin
  const bearer = { Authorization: 'Bearer e2e-local-admin-key', Origin: origin }
  const add = await page.request.post('/api/staff', { headers: bearer, data: { name: 'Revoke Me', email: 'revoke.me@example.com' } })
  expect(add.status()).toBe(201)
  const { staff, temp_password } = await add.json()
  await connectWhaBuzz()

  const ctx = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] }, viewport: { width: 1280, height: 800 } })
  try {
    const b = await ctx.newPage()
    const login = await b.request.post('/api/auth/login', { headers: { Origin: origin }, data: { email: 'revoke.me@example.com', password: temp_password } })
    expect(login.status()).toBe(200)
    const csrf = (await login.json()).csrf as string
    const ch = await b.request.post('/api/auth/password', { headers: { Origin: origin, 'X-CSRF-Token': csrf }, data: { current_password: temp_password, new_password: 'a fresh e2e passphrase 77' } })
    expect(ch.status()).toBe(200) // the changing session itself must survive (exceptSid)
    await b.goto('/inbox')
    await expect(b.locator('[data-live]').first()).toHaveAttribute('data-live', 'open', { timeout: 5_000 })
    await b.evaluate(() => {
      const W = window.WebSocket
      ;(window as any).__wsCount = 0
      window.WebSocket = class extends W { constructor(u: string | URL, p?: string | string[]) { super(u, p); (window as any).__wsCount++ } } as typeof WebSocket
    })

    const off = await page.request.patch(`/api/staff/${staff.id}`, { headers: bearer, data: { active: false } })
    expect(off.status()).toBe(200)
    await expect(b.locator('[data-live]').first()).not.toHaveAttribute('data-live', 'open', { timeout: 2_000 })

    // terminal: no reconnect storm, even after a signed event
    await postHook(page, inboundBody('wamid.E2E_WS_REV1', '15550007009', 'After Revoke', 'nobody should see this live'))
    await b.waitForTimeout(2_500)
    const sockets = await b.evaluate(() => (window as any).__wsCount as number)
    expect(sockets).toBe(0)
  } finally { await ctx.close() }
})
