import { expect, test } from '@playwright/test'

const SETUP_KEY = 'e2e-local-session-secret-0123456789'
const PASSWORD = 'correct horse battery'

// Runs last in 'onboarding' (files run in name order, hence the z), after setup has run. Recovers to the same password so the later specs still sign in.
test('login -> forgot password -> recover with the setup key -> Today', async ({ page }) => {
  await page.goto('/login')
  await expect(page.getByText('Team members: ask an administrator')).toBeVisible()
  await page.getByRole('link', { name: 'Forgot your password?' }).click()
  await expect(page).toHaveURL(/\/recover$/)

  await page.getByLabel('Setup key').fill('not-the-key')
  await page.getByLabel('Email').fill('admin@example.com')
  await page.getByLabel('New password', { exact: true }).fill(PASSWORD)
  await page.getByLabel('Confirm new password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Reset password and log in' }).click()
  await expect(page.getByRole('alert')).toHaveText('That key or email is not right.')

  await page.getByLabel('Setup key').fill(SETUP_KEY)
  await page.getByRole('button', { name: 'Reset password and log in' }).click()
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible()
  await expect(page).toHaveURL(/\/$/)
})
