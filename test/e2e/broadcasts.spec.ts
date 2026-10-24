import { expect, test } from '@playwright/test'

// Smoke: the broadcasts list renders (empty state or rows), and the admin can open the wizard. Read-only: nothing is sent.
test('broadcasts list renders and the admin can open the new-broadcast wizard', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 })
  await page.goto('/broadcasts') // signed in via the shared storageState (auth.setup.ts)
  await expect(page.getByRole('heading', { name: 'Broadcasts', exact: true })).toBeVisible()
  // loaded: either the empty state or the list, never the skeleton or an error
  await expect(page.getByText('No broadcasts yet').or(page.getByTestId('broadcast-list'))).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  await page.getByTestId('new-broadcast').click()
  await expect(page).toHaveURL(/\/broadcasts\/new$/)
  await expect(page.getByRole('heading', { name: 'New broadcast', exact: true })).toBeVisible()
})
