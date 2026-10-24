import { expect, test } from '@playwright/test'


const noOverflow = (page: import('@playwright/test').Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

test('create a manual lead, move its stage, add a note, see it in Today', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 })
  await page.goto('/') // signed in via the shared storageState (auth.setup.ts)
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible()

  // the form
  await page.goto('/leads')
  await page.getByRole('link', { name: 'New lead' }).first().click() // earlier specs may have left leads, so no empty-state assert here
  await page.getByLabel('Phone').fill('abc')
  await page.getByRole('button', { name: 'Create lead' }).click()
  await expect(page.getByRole('alert').first()).toBeVisible()

  await page.getByLabel('Phone').fill('+1 555 000 0199')
  await page.getByLabel('Name').fill('Sample Lead')
  await page.getByLabel('What they want').fill('Asked about pricing for two seats')
  const today = new Date().toISOString().slice(0, 10) // the instance timezone is UTC in the e2e server
  await page.getByLabel('Next action date').fill(today)
  await page.getByLabel('Next action time').fill('23:59')
  await page.getByRole('button', { name: 'Create lead' }).click()

  await expect(page.getByRole('heading', { name: 'Sample Lead' })).toBeVisible()
  await expect(page.getByText('Lead created (manual)')).toBeVisible()

  // move the stage
  await page.getByRole('button', { name: 'Contacted' }).click()
  await expect(page.getByRole('button', { name: 'Contacted' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText(/New to Contacted/)).toBeVisible()

  // add a note
  await page.getByLabel('Add a note').fill('Called back, wants a demo on Friday')
  await page.getByRole('button', { name: 'Save note' }).click()
  await expect(page.getByText('Called back, wants a demo on Friday')).toBeVisible()
  expect(await noOverflow(page)).toBe(true)
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: 'docs/screenshots/lead-detail-360.png' })

  // it shows up in Today (next action is today)
  await page.goto('/')
  await expect(page.getByRole('region', { name: 'Due today' }).getByText('Sample Lead')).toBeVisible()
  expect(await noOverflow(page)).toBe(true)
  await page.screenshot({ path: 'docs/screenshots/today-360.png' })

  // list + search + contacts
  await page.goto('/leads')
  await expect(page.getByRole('link', { name: /Sample Lead/ })).toBeVisible()
  expect(await noOverflow(page)).toBe(true)
  await page.screenshot({ path: 'docs/screenshots/leads-360.png' })
  await page.getByLabel('Search leads').fill('zzzz')
  await expect(page.getByText('No leads match these filters')).toBeVisible()
  await page.getByLabel('Search leads').fill('Sample')
  await expect(page.getByRole('link', { name: /Sample Lead/ })).toBeVisible()

  await page.goto('/contacts')
  await page.getByRole('button', { name: /Sample Lead/ }).click()
  await expect(page.getByRole('dialog').getByText('Open the conversation')).toBeVisible()

  // board at desktop width
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/leads?view=board')
  await expect(page.getByRole('region', { name: 'Contacted' }).getByText('Sample Lead')).toBeVisible()
  await page.screenshot({ path: 'docs/screenshots/leads-board-1280.png' })
})
