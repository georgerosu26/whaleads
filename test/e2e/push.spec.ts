import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { webcrypto } from 'node:crypto'
import { expect, test } from '@playwright/test'

const b64url = (b: Uint8Array) => Buffer.from(b).toString('base64url')

test('notifications: service worker registered, card subscribes, /api/push/test reaches a stub push endpoint', async ({ page, context }) => {
  // A tiny push service: accepts the POST and records what the Worker sent.
  const got: { url: string; headers: IncomingHttpHeaders; bytes: number }[] = []
  const stub = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => { got.push({ url: req.url ?? '', headers: req.headers, bytes: Buffer.concat(chunks).length }); res.statusCode = 201; res.end() })
  })
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r))
  const endpoint = `http://127.0.0.1:${(stub.address() as AddressInfo).port}/push/e2e-device`

  try {
    await context.grantPermissions(['notifications'])
    await page.setViewportSize({ width: 360, height: 740 })
    await page.goto('/settings/profile') // signed in via the shared storageState
    await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible()

    // The service worker is registered and active.
    const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope)
    expect(scope).toMatch(/\/$/)
    expect(await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration('/'))?.active)).toBe(true)

    // The card offers to turn notifications on (permission is granted, nothing subscribed yet).
    const card = page.getByTestId('notifications-card')
    await expect(card.getByRole('button', { name: 'Turn on notifications' })).toBeVisible()

    // Real subscribe through the card. Headless Chromium has no push service on some hosts, so a failure shows an inline
    // error rather than hanging; either way the server path below is exercised with a stub device.
    await card.getByRole('button', { name: 'Turn on notifications' }).click()
    await expect(card.getByText('On for this device').or(card.getByRole('alert'))).toBeVisible({ timeout: 20_000 })
    console.log('real browser subscribe ->', (await card.innerText()).replace(/\n+/g, ' | '))

    // Register a stub device (browser-shaped keys) the same way the SPA does, then send a test to it.
    const pair = (await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair
    const keys = { p256dh: b64url(new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey))), auth: b64url(webcrypto.getRandomValues(new Uint8Array(16))) }
    const csrf = (await (await page.request.get('/api/auth/me')).json()).csrf as string
    const h = { 'X-CSRF-Token': csrf, Origin: new URL(page.url()).origin }
    const sub = await page.request.post('/api/push/subscribe', { headers: h, data: { endpoint, keys } })
    expect(sub.status()).toBe(200)

    const noCsrf = await page.request.post('/api/push/test', { data: {} })
    expect(noCsrf.status()).toBe(403)

    const r = await page.request.post('/api/push/test', { headers: h, data: {} })
    expect(r.status()).toBe(200)
    const out = await r.json()
    expect(out.sent).toBeGreaterThanOrEqual(1)
    expect(got).toHaveLength(1)
    expect(got[0].headers['content-encoding']).toBe('aes128gcm')
    expect(got[0].headers.ttl).toBe('86400')
    expect(got[0].headers.authorization).toMatch(/^vapid t=/)
    expect(got[0].bytes).toBeGreaterThan(86) // header (86) + at least the tag-padded ciphertext

    await page.request.delete('/api/push/subscribe', { headers: h, data: { endpoint } })
    expect((await page.request.post('/api/push/test', { headers: h, data: {} })).status()).toBe(200)
    expect(got).toHaveLength(1) // removed: nothing more reaches the stub

    await page.reload()
    await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: 'docs/screenshots/notifications-360.png' })
  } finally {
    await new Promise<void>((r) => stub.close(() => r()))
  }
})

test('logout releases this device; signing in claims it for the signed-in person', async ({ page, browser, baseURL }) => {
  const endpoint = 'http://127.0.0.1:9/push/logout-device' // never contacted: only the subscription row matters here
  const pair = (await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair
  const keys = { p256dh: b64url(new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey))), auth: b64url(webcrypto.getRandomValues(new Uint8Array(16))) }

  // A fresh browser (its own session) whose push manager reports a subscription, as a phone that already enabled push would.
  const ctx = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] }, viewport: { width: 1280, height: 800 } })
  await ctx.grantPermissions(['notifications'])
  await ctx.addInitScript(({ endpoint, keys }) => {
    const sub = { endpoint, toJSON: () => ({ endpoint, keys }), unsubscribe: async () => true }
    PushManager.prototype.getSubscription = async () => sub as unknown as PushSubscription
  }, { endpoint, keys })
  const mine = async () => {
    const csrf = (await (await page.request.get('/api/auth/me')).json()).csrf as string
    const r = await page.request.post('/api/push/test', { headers: { 'X-CSRF-Token': csrf, Origin: new URL(baseURL!).origin }, data: {} })
    return (await r.json()).devices as number
  }
  try {
    const p2 = await ctx.newPage()
    await p2.goto('/login')
    await p2.getByLabel('Email').fill('admin@example.com')
    await p2.getByLabel('Password').fill('correct horse battery')
    await p2.getByRole('button', { name: 'Log in' }).click()
    await expect(p2.getByRole('heading', { name: 'Today', exact: true })).toBeVisible()
    await expect.poll(mine, { timeout: 10_000 }).toBe(1) // claimed on sign-in (upsert by endpoint)

    await p2.getByRole('button', { name: 'Log out' }).first().click()
    await p2.waitForURL(/\/login$/)
    expect(await mine()).toBe(0) // the subscription row is gone with the session
  } finally {
    await ctx.close()
  }
})
