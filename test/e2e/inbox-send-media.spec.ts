import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { deflateSync } from 'node:zlib'
import { expect, test, type Page } from '@playwright/test'
import { encryptJson } from '../../src/crypto'
import { envelope, sign } from '../helpers'

const SETUP_KEY = 'e2e-local-session-secret-0123456789'
const WH_SECRET = 'whsec_TEST_e2e_local_0000'
const PHONE_NUMBER_ID = '1000000000000001'
const MOCK_PORT = Number(process.env.PW_PORT ?? 8799) + 1 // matches WHABUZZ_BASE_URL in playwright.config.ts (PW_PORT + 1)

// A 240x160 coral-and-cream PNG, built here so no binary fixture is committed.
function png(): Buffer {
  const w = 240, h = 160
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    const o = y * (w * 3 + 1)
    for (let x = 0; x < w; x++) {
      const band = Math.floor(x / 40) % 2 === 0
      raw.set(band ? [0xe8, 0x6a, 0x5a] : [0xf6, 0xef, 0xe4], o + 1 + x * 3)
    }
  }
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (t: string, d: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(d.length)
    const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

// Local stand-in for the WhaBuzz API: serves the inbound image and records outbound sends.
const sent: any[] = []
let mock: Server
test.beforeAll(async () => {
  const img = png()
  mock = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const url = req.url ?? ''
      if (req.method === 'GET' && url.startsWith('/v1/media/')) { res.writeHead(200, { 'content-type': 'image/png' }); res.end(img); return }
      if (req.method === 'POST' && url.startsWith('/v1/media')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'mock-up-1' })); return }
      if (req.method === 'POST' && url.startsWith('/v1/messages')) {
        sent.push(JSON.parse(Buffer.concat(chunks).toString() || '{}'))
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ messages: [{ id: `wamid.MOCK_${sent.length}` }] })); return
      }
      res.writeHead(404); res.end('{}')
    })
  })
  await new Promise<void>((r) => mock.listen(MOCK_PORT, '127.0.0.1', r))
})
test.afterAll(() => { mock?.close() })

async function connectWhaBuzz() {
  const blob = await encryptJson(SETUP_KEY, { api_key: 'wbk_TEST_e2e_local_0000', phone_number_id: PHONE_NUMBER_ID, waba_id: '1000000000002', webhook_secret: WH_SECRET })
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', '--persist-to', '.e2e-state', '--command',
    `INSERT INTO adaptor_config (id,kind,config_enc,updated_at) VALUES (1,'whabuzz','${blob}',unixepoch()) ON CONFLICT(id) DO UPDATE SET kind='whabuzz', config_enc=excluded.config_enc`], { stdio: 'pipe' })
}
function imageBody(wamid: string, from: string, name: string) {
  const f = JSON.parse(readFileSync(new URL('../fixtures/image.json', import.meta.url), 'utf8'))
  const v = f.entry[0].changes[0].value
  v.contacts = [{ profile: { name }, wa_id: from }]
  v.messages = [{ ...v.messages[0], from, id: wamid, timestamp: String(Math.floor(Date.now() / 1000)) }]
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
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

test('inbound image renders from /api/media; text and image can be sent; quick reply fills {name}', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 })
  await signIn(page)
  await connectWhaBuzz()

  // quick reply, created through the settings page
  await page.goto('/settings/quick-replies')
  await expect(page.getByText('No quick replies yet')).toBeVisible()
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await page.getByLabel('Shortcut').fill('hello')
  await page.getByLabel('Message').fill('Hi {name}, thanks for the photo.')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('/hello')).toBeVisible()
  expect(await noOverflow(page)).toBe(true)

  await postHook(page, imageBody('wamid.E2E_S4B_1', '15550007777', 'Asha Example'))
  await page.goto('/inbox')
  await page.getByRole('link', { name: /Asha Example/ }).click()
  const img = page.getByRole('img', { name: 'My form check' })
  await expect(img).toBeVisible()
  await expect.poll(() => img.evaluate((e: HTMLImageElement) => e.complete && e.naturalWidth)).toBe(240)
  const media = await page.request.get((await img.getAttribute('src'))!)
  expect(media.status()).toBe(200)
  expect(media.headers()['content-type']).toBe('image/png')
  expect(media.headers()['x-content-type-options']).toBe('nosniff')
  expect(media.headers()['content-security-policy']).toBe('sandbox')
  expect(await noOverflow(page)).toBe(true)
  await page.screenshot({ path: 'docs/screenshots/thread-media-360.png' })

  // quick reply via the picker, then send
  const box = page.getByLabel('Message', { exact: true })
  await box.fill('/he')
  await page.getByRole('button', { name: /\/hello/ }).click()
  await expect(box).toHaveValue('Hi Asha, thanks for the photo.')
  await page.screenshot({ path: 'docs/screenshots/thread-composer-360.png' })
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByText('Hi Asha, thanks for the photo.')).toBeVisible()
  await expect(box).toHaveValue('')
  // the bubble is optimistic, so the request may not have reached the mock yet
  await expect.poll(() => sent.at(-1)).toMatchObject({ to: '15550007777', type: 'text', text: { body: 'Hi Asha, thanks for the photo.' } })

  // attach and send an image with a caption
  await page.locator('input[type=file]').setInputFiles({ name: 'sample.png', mimeType: 'image/png', buffer: png() })
  await box.fill('Here you go')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(box).toHaveValue('')
  await expect(page.getByRole('img', { name: 'Here you go' })).toBeVisible()
  await expect.poll(() => sent.at(-1)).toMatchObject({ type: 'image', image: { id: 'mock-up-1', caption: 'Here you go' } })
  expect(await noOverflow(page)).toBe(true)
})

test('closed window disables free text and shows the banner', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 })
  await signIn(page)
  await postHook(page, imageBody('wamid.E2E_S4B_2', '15550008888', 'Old Contact'))
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', '--persist-to', '.e2e-state', '--command',
    `UPDATE conversations SET last_inbound_at = unixepoch() - 100000 WHERE contact_id = (SELECT id FROM contacts WHERE wa_id='15550008888')`], { stdio: 'pipe' })
  await page.goto('/inbox')
  await page.getByRole('link', { name: /Old Contact/ }).click()
  await expect(page.getByRole('status')).toContainText('Reply window closed')
  await expect(page.getByLabel('Message', { exact: true })).toBeDisabled()
  expect(await noOverflow(page)).toBe(true)
})
