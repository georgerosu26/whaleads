import { expect, test } from '@playwright/test'

const SETUP_KEY = 'e2e-local-session-secret-0123456789'
const PASSWORD = 'correct horse battery'

test('setup -> Today shell -> logout -> login', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveURL(/\/setup$/)

  await page.getByLabel('Setup key').fill(SETUP_KEY)
  await page.getByLabel('Business name').fill('Example Co')
  await page.getByLabel('Your name').fill('Test Admin')
  await page.getByLabel('Email').fill('admin@example.com')
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Create workspace' }).click()

  // a fresh workspace has no number: setup sends the admin straight to connecting one, with no banner on that page
  await expect(page).toHaveURL(/\/settings\/whatsapp$/)
  await expect(page.getByRole('heading', { name: 'WhatsApp' })).toBeVisible()
  await expect(page.getByText('No WhatsApp number is connected yet')).toBeVisible()
  await expect(page.getByTestId('connect-banner')).toHaveCount(0)

  // everywhere else the banner is there, with a button back to the settings page
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible()
  await expect(page.getByTestId('connect-banner')).toContainText("No WhatsApp number is connected. Messages can't arrive or be sent yet.")
  await expect(page.getByText('Connect a WhatsApp number to get started')).toBeVisible()
  await page.goto('/inbox')
  await expect(page.getByTestId('connect-banner')).toBeVisible()
  await expect(page.getByText('Connect a WhatsApp number', { exact: true })).toBeVisible()
  await page.getByTestId('connect-banner').getByRole('link', { name: 'Connect WhatsApp' }).click()
  await expect(page).toHaveURL(/\/settings\/whatsapp$/)
  await expect(page.getByTestId('connect-banner')).toHaveCount(0)
  await page.goto('/')

  await page.getByRole('button', { name: 'Log out' }).first().click()
  await expect(page).toHaveURL(/\/login$/)

  await page.getByLabel('Email').fill('admin@example.com')
  await page.getByLabel('Password').fill('wrong password here')
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(page.getByRole('alert')).toContainText('incorrect')

  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible()

  // reload keeps the session; /setup is locked
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible()
  expect((await page.request.get('/api/setup/status')).ok()).toBe(true)
  expect(await (await page.request.get('/api/setup/status')).json()).toMatchObject({ needs_setup: false })
})
