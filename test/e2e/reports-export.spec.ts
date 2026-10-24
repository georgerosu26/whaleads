import { expect, test, type Page } from '@playwright/test'

const PORT = Number(process.env.PW_PORT ?? 8799)
const ADMIN = { Authorization: 'Bearer e2e-local-admin-key', Origin: `http://localhost:${PORT}` }
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
const overview = async (page: Page) => (await (await page.request.get('/api/reports/overview', { headers: ADMIN })).json()) as { totals: { leads: number; won: number } }

test('reports show the seeded numbers, export downloads, a CSV import skips the duplicate', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 })

  // seed through the API: one lead that the import will collide with, two more
  const before = (await overview(page)).totals.leads
  for (const [phone, name] of [['+15550177001', 'Reports Seed One'], ['+15550177002', 'Reports Seed Two'], ['+15550177003', 'Reports Seed Three']]) {
    const r = await page.request.post('/api/leads/manual', { headers: ADMIN, data: { phone, name, source: 'manual' } })
    expect(r.status(), await r.text()).toBe(201)
  }
  const after = (await overview(page)).totals.leads
  expect(after).toBe(before + 3)

  // Reports: tiles and both charts
  await page.goto('/reports')
  await expect(page.getByRole('heading', { name: 'Reports', exact: true })).toBeVisible()
  await expect(page.getByText('New leads', { exact: true })).toBeVisible()
  await expect(page.getByText('New leads', { exact: true }).locator('xpath=..').getByText(String(after), { exact: true })).toBeVisible()
  await expect(page.getByText('Unanswered now')).toBeVisible()
  await expect(page.getByRole('img', { name: /^New leads per week/ })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Messages per week' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'By source' })).toBeVisible()
  await page.getByRole('button', { name: 'Show table' }).first().click()
  await expect(page.getByRole('columnheader', { name: 'New leads' })).toBeVisible()
  await page.getByRole('button', { name: 'Show chart' }).first().click()
  await page.getByRole('button', { name: '7 days' }).click()
  await expect(page.getByRole('button', { name: '7 days' })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: '30 days' }).click()
  expect(await noOverflow(page)).toBe(true)
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: 'docs/screenshots/reports-360.png' })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.screenshot({ path: 'docs/screenshots/reports-1280.png', fullPage: true })

  // Export: leads.csv has the documented header row
  await page.setViewportSize({ width: 360, height: 740 })
  await page.goto('/settings/data')
  await expect(page.getByRole('heading', { name: 'Import leads' })).toBeVisible()
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Leads CSV' }).click()])
  expect(dl.suggestedFilename()).toMatch(/^whaleads-leads-\d{4}-\d{2}-\d{2}\.csv$/)
  const fs = await import('node:fs/promises')
  const text = (await fs.readFile(await dl.path(), 'utf8')).replace(/^﻿/, '')
  expect(text.split('\r\n')[0]).toBe('id,created_at,name,phone,email,source,stage,owner,owner_email,tags,next_action_at,won_at,closed_at,lost_reason,first_response_at,message,utm_source,utm_medium,utm_campaign,gclid,ctwa_clid,referral_source_id,referral_source_type,referral_source_url,referral_headline')
  expect(text).toContain('+15550177001')

  // Import: 3 rows, the first repeats a seeded phone
  const csv = 'Name,Phone,Email\nDuplicate Row,+15550177001,\nImported Alpha,+15550177011,alpha@example.com\nImported Beta,+15550177012,\n'
  await page.getByLabel('CSV file').setInputFiles({ name: 'people.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
  await expect(page.getByRole('button', { name: 'Preview import' })).toBeVisible()
  expect(await noOverflow(page)).toBe(true)
  await page.getByRole('button', { name: 'Preview import' }).click()
  await expect(page.getByText('Nothing is saved yet.')).toBeVisible()
  await expect(page.getByText('Duplicates', { exact: true }).locator('xpath=..').getByText('1', { exact: true })).toBeVisible()
  await expect(page.getByText('Skipped: has an open lead')).toBeVisible()
  expect(await noOverflow(page)).toBe(true)
  await page.screenshot({ path: 'docs/screenshots/import-360.png' })
  await page.getByRole('button', { name: 'Import 2 leads' }).click()
  await expect(page.getByText('Imported 2 leads', { exact: true })).toBeVisible()
  await page.getByRole('link', { name: 'See leads' }).click()
  await expect(page.getByRole('link', { name: /Imported Alpha/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /Imported Beta/ })).toBeVisible()
  expect((await overview(page)).totals.leads).toBe(after + 2)
})
