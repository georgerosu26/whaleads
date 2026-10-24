// one-click Connect to WhaBuzz against the local stub (test/e2e/whabuzz-connect-stub.ts, live-contract shapes).
import { expect, test } from '@playwright/test'
import { STUB_DISPLAY_NUMBER, startConnectStub, type ConnectStub } from './whabuzz-connect-stub'

let stub: ConnectStub
test.beforeAll(async () => { stub = await startConnectStub() })
test.afterAll(async () => { await stub.close() })

test.use({ viewport: { width: 360, height: 740 } })

test('Connect with WhaBuzz: hosted page, ping, Approve, back connected', async ({ page }) => {
  await page.goto('/settings/whatsapp')
  const connect = page.getByRole('button', { name: 'Connect with WhaBuzz' })
  await expect(connect).toBeVisible()
  await expect(page.getByRole('button', { name: 'Enter keys manually' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: 'docs/screenshots/connect-360.png' })

  await connect.click()
  await page.waitForURL(/\/connect\?/)
  const q = new URL(page.url()).searchParams
  expect([...q.keys()].sort()).toEqual(['app', 'callback', 'code_challenge', 'state'])
  expect(q.get('app')).toBe('whaleads')
  expect(q.get('callback')).toMatch(/\/api\/whabuzz\/callback$/)
  expect(q.get('state')).toMatch(/^[\x21-\x7e]{1,200}$/)
  expect(page.url().length).toBeLessThan(500)
  await page.getByRole('button', { name: 'Approve' }).click()

  await page.waitForURL(/\/settings\/whatsapp\?connected=1$/)
  await expect(page.getByTestId('connect-ok')).toBeVisible()
  await expect(page.getByText('Connected', { exact: true })).toBeVisible()
  // the global banner is gone once connected, and stays gone when moving to another page in the app (no hard reload)
  await expect(page.getByTestId('connect-banner')).toHaveCount(0)
  await page.getByRole('link', { name: 'Today' }).first().click()
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible()
  await expect(page.getByTestId('connect-banner')).toHaveCount(0)
  await page.goBack()
  await expect(page.getByText('Connected', { exact: true })).toBeVisible()
  await expect(page.getByText(STUB_DISPLAY_NUMBER)).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: 'docs/screenshots/connect-done-360.png' })

  // the verify ping was answered (unsigned-accepted while the connect was pending), then the code was exchanged once
  expect(stub.pings.at(-1)).toMatchObject({ status: 200, echoed: true })
  expect(stub.pings.at(-1)!.url).toMatch(/\/api\/whabuzz\/webhook$/)
  expect(stub.exchanges).toHaveLength(1)
  expect(stub.exchanges[0]!.ok).toBe(true)
  expect(stub.exchanges[0]!.body).toMatchObject({ app: 'whaleads', state: q.get('state') })
  expect(typeof stub.exchanges[0]!.body.code_verifier).toBe('string')
  // only the exchange and GET /v1/numbers/{id} (status); never /v1/webhooks, /v1/api-keys or a numbers write
  expect(stub.apiCalls.filter((c) => c === '/connect/token')).toHaveLength(1)
  expect(stub.apiCalls.every((c) => c === '/connect/token' || c === '/v1/numbers/1000000000000002')).toBe(true)
})

test('Cancel on the WhaBuzz page shows "Connection cancelled"', async ({ page }) => {
  await page.goto('/settings/whatsapp')
  await page.getByRole('button', { name: 'Connect with WhaBuzz' }).click()
  await page.waitForURL(/\/connect\?/)
  await page.getByRole('button', { name: 'Cancel' }).click()
  await page.waitForURL(/connect_error=access_denied/)
  await expect(page.getByTestId('connect-error')).toContainText('Connection cancelled')
})

test('a replayed callback URL does nothing and shows the expiry message', async ({ page }) => {
  await page.goto('/settings/whatsapp')
  await page.getByRole('button', { name: 'Connect with WhaBuzz' }).click()
  await page.waitForURL(/\/connect\?/)
  const cb = page.waitForRequest((r) => r.url().includes('/api/whabuzz/callback?'))
  await page.getByRole('button', { name: 'Approve' }).click()
  const callbackUrl = (await cb).url()
  await page.waitForURL(/connected=1/)
  await page.goto(callbackUrl) // the very same code + state, requested again
  await expect(page).toHaveURL(/connect_error=state_mismatch/)
  await expect(page.getByTestId('connect-error')).toContainText('expired or was already used')
})

test('code_used from WhaBuzz explains the revoke', async ({ page }) => {
  stub.failExchange = 'code_used'
  await page.goto('/settings/whatsapp')
  await page.getByRole('button', { name: 'Connect with WhaBuzz' }).click()
  await page.waitForURL(/\/connect\?/)
  await page.getByRole('button', { name: 'Approve' }).click()
  await page.waitForURL(/connect_error=code_used/)
  await expect(page.getByTestId('connect-error')).toContainText('revoked the connection for safety')
})
