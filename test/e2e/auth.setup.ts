import { expect, test } from '@playwright/test'

// Signs in once (the workspace already exists: the onboarding specs run first) and saves the session for the 'app' project.
test('sign in once and save the session', async ({ page }) => {
  await page.goto('/')
  await page.waitForURL(/\/(setup|login)$/)
  if (/\/setup$/.test(page.url())) {
    await page.getByLabel('Setup key').fill('e2e-local-session-secret-0123456789')
    await page.getByLabel('Business name').fill('Example Co')
    await page.getByLabel('Your name').fill('Test Admin')
    await page.getByLabel('Email').fill('admin@example.com')
    await page.getByLabel('Password').fill('correct horse battery')
    await page.getByRole('button', { name: 'Create workspace' }).click()
    await page.waitForURL(/\/settings\/whatsapp$/)
    await page.goto('/')
  } else {
    await page.getByLabel('Email').fill('admin@example.com')
    await page.getByLabel('Password').fill('correct horse battery')
    await page.getByRole('button', { name: 'Log in' }).click()
  }
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible()
  await page.context().storageState({ path: 'test/e2e/.auth/admin.json' })
})
