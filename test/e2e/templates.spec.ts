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

// Local stand-in for the WhaBuzz API: templates (create, list, sync flips PENDING to APPROVED), media-handle, uploads and sends.
const sent: any[] = []
const created: any[] = []
const handles: number[] = []
const tpls: any[] = []
let mock: Server
test.beforeAll(async () => {
  mock = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const url = (req.url ?? '').split('?')[0]!
      const raw = Buffer.concat(chunks)
      const ok = (o: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
      if (req.method === 'POST' && url === '/v1/templates/media-handle') { handles.push(raw.length); return ok({ h: '4::e2e-handle' }) }
      if (req.method === 'POST' && url === '/v1/templates/sync') { for (const t of tpls) if (t.status === 'PENDING') t.status = 'APPROVED'; return ok({ fetched: tpls.length }) }
      if (req.method === 'POST' && url === '/v1/templates') {
        const b = JSON.parse(raw.toString() || '{}'); created.push(b)
        const t = { id: `tpl_e2e_${tpls.length + 1}`, name: b.name, language: b.language, category: b.category, status: 'PENDING', status_reason: null, meta_object: { components: b.components } }
        tpls.push(t); return ok({ id: t.id, status: 'PENDING', category: b.category })
      }
      if (req.method === 'GET' && url === '/v1/templates') return ok({ data: tpls })
      if (req.method === 'POST' && url.startsWith('/v1/media')) return ok({ id: 'mock-up-1' })
      if (req.method === 'POST' && url.startsWith('/v1/messages')) {
        sent.push(JSON.parse(raw.toString() || '{}'))
        return ok({ messages: [{ id: `wamid.TPL_${sent.length}` }] })
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


test('create a text template: PENDING, then Sync flips it to Approved', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 })
  await signIn(page)
  await connectWhaBuzz()
  await page.goto('/settings/templates')
  await expect(page.getByText('No templates yet')).toBeVisible()

  await page.getByRole('link', { name: 'New' }).click()
  await page.getByLabel('Name').fill('order_update')
  await page.getByLabel('Body').fill('Hi {{1}}, your order {{2}} is on its way.')
  await page.getByLabel('Sample for {{1}}').fill('Asha')
  await page.getByLabel('Sample for {{2}}').fill('A100')
  await expect(page.getByTestId('wa-card')).toContainText('Hi Asha, your order A100 is on its way.')
  expect(await noOverflow(page)).toBe(true)
  await page.screenshot({ path: 'docs/screenshots/template-create-360.png', fullPage: true })

  // Meta rule enforced in the form before anything is sent
  await page.getByLabel('Name').fill('bad-name')
  await page.getByRole('button', { name: 'Submit for review' }).click()
  await expect(page.getByText('Lowercase letters, numbers and underscores only.')).toBeVisible()
  expect(created).toHaveLength(0)
  await page.getByLabel('Name').fill('order_update')
  await page.getByRole('button', { name: 'Submit for review' }).click()

  await expect(page.getByTestId('tpl-order_update')).toBeVisible()
  await expect(page.getByTestId('tpl-order_update').getByTestId('tpl-status')).toHaveText('Pending')
  expect(created[0]).toMatchObject({ name: 'order_update', category: 'UTILITY', components: [{ type: 'BODY', example: { body_text: [['Asha', 'A100']] } }] })

  await page.getByRole('button', { name: 'Sync' }).click()
  await expect(page.getByTestId('tpl-order_update').getByTestId('tpl-status')).toHaveText('Approved')
  expect(await noOverflow(page)).toBe(true)
  await page.screenshot({ path: 'docs/screenshots/templates-360.png' })
})

test('create an image-header template with a sample upload', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 })
  await signIn(page)
  await page.goto('/settings/templates/new')
  await page.getByLabel('Name').fill('promo_banner')
  await page.getByLabel('Type').selectOption('IMAGE')
  await page.getByRole('button', { name: 'Submit for review' }).click()
  await expect(page.getByText(/sample/i).first()).toBeVisible()
  expect(created.filter((c) => c.name === 'promo_banner')).toHaveLength(0)
  await page.getByLabel('Sample file').setInputFiles({ name: 'banner.png', mimeType: 'image/png', buffer: png() })
  await page.getByLabel('Body').fill('Sale on today, {{1}}.')
  await page.getByLabel('Sample for {{1}}').fill('Asha')
  await page.getByRole('button', { name: 'Submit for review' }).click()
  await expect(page.getByTestId('tpl-promo_banner')).toBeVisible()
  expect(handles.length).toBe(1)
  expect(created.at(-1).components[0]).toEqual({ type: 'HEADER', format: 'IMAGE', example: { header_handle: ['4::e2e-handle'] } })
  await page.getByRole('button', { name: 'Sync' }).click()
  await expect(page.getByTestId('tpl-promo_banner').getByTestId('tpl-status')).toHaveText('Approved')
})

test('window closed: composer offers templates, send with params and the default header, optimistic then real', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 })
  await signIn(page)
  await postHook(page, imageBody('wamid.E2E_S5_1', '15550008801', 'Closed Window'))
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', '--persist-to', '.e2e-state', '--command',
    `UPDATE conversations SET last_inbound_at = unixepoch() - 259200 WHERE contact_id = (SELECT id FROM contacts WHERE wa_id='15550008801')`], { stdio: 'pipe' })
  await page.goto('/inbox')
  await page.getByRole('link', { name: /Closed Window/ }).click()
  await expect(page.getByRole('status')).toContainText('Reply window closed')
  await expect(page.getByLabel('Message', { exact: true })).toBeDisabled()

  await page.getByRole('button', { name: 'Template', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Send a template' })).toBeVisible()
  await page.getByLabel('Search templates').fill('promo')
  await expect(page.getByRole('button', { name: /order_update/ })).toHaveCount(0)
  await page.getByRole('button', { name: /promo_banner/ }).click()
  await expect(page.getByLabel('Value {{1}}')).toHaveValue('Closed') // contact first name prefilled
  await page.getByLabel('Value {{1}}').fill('Asha')
  await expect(page.getByTestId('wa-card')).toContainText('Sale on today, Asha.')
  await page.screenshot({ path: 'docs/screenshots/composer-template-360.png' })

  const before = sent.length
  await page.getByRole('button', { name: 'Send template' }).click()
  await expect(page.getByText('Sale on today, Asha.').first()).toBeVisible() // optimistic bubble
  await expect.poll(() => sent.length).toBe(before + 1)
  expect(sent.at(-1)).toMatchObject({
    to: '15550008801', type: 'template',
    template: { name: 'promo_banner', language: { code: 'en' }, components: [
      { type: 'header', parameters: [{ type: 'image', image: { id: 'mock-up-1' } }] },
      { type: 'body', parameters: [{ type: 'text', text: 'Asha' }] },
    ] },
  })
  // the real row arrives (poll/live); exactly one bubble, with the header image
  await expect(page.locator('p').filter({ hasText: 'Sale on today, Asha.' })).toHaveCount(1)
  const hdr = page.locator('img[src^="/api/media/"]')
  await expect(hdr).toBeVisible()
  await expect.poll(() => hdr.evaluate((e: HTMLImageElement) => e.complete && e.naturalWidth)).toBe(240)
  await expect(page.getByTestId('retry-send')).toHaveCount(0)
  expect(await noOverflow(page)).toBe(true)
})
