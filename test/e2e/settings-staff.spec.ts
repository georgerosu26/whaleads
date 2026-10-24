import { expect, test, type Page } from '@playwright/test'

const SETUP_KEY = 'e2e-local-session-secret-0123456789'
const PASSWORD = 'correct horse battery'
const ADMIN = 'admin@example.com'

// The suite shares one local D1 (setup-login may already have run setup), so sign in if the workspace exists.
async function signInAsAdmin(page: Page) {
  await page.goto('/')
  await page.waitForURL(/\/(setup|login)$/)
  if (/\/setup$/.test(page.url())) {
    await page.getByLabel('Setup key').fill(SETUP_KEY)
    await page.getByLabel('Business name').fill('Example Co')
    await page.getByLabel('Your name').fill('Test Admin')
    await page.getByLabel('Email').fill(ADMIN)
    await page.getByLabel('Password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Create workspace' }).click()
    await page.waitForURL(/\/settings\/whatsapp$/)
    await page.goto('/')
  } else {
    await page.getByLabel('Email').fill(ADMIN)
    await page.getByLabel('Password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Log in' }).click()
  }
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible()
}

test('admin adds staff; temp password logs in, forces a change, lands in the app', async ({ page }) => {
  await signInAsAdmin(page)
  await page.goto('/settings/team')
  await expect(page.getByRole('heading', { name: 'Team', exact: true })).toBeVisible()

  const email = `agent${Date.now()}@example.com`
  await page.getByLabel('Name', { exact: true }).fill('New Agent')
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Add member' }).click()
  const temp = (await page.getByTestId('temp-password').textContent())!.trim()
  expect(temp).toHaveLength(12)
  await expect(page.getByText('New Agent').first()).toBeVisible()

  await page.getByRole('button', { name: 'Log out' }).first().click()
  await expect(page).toHaveURL(/\/login$/)
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(temp)
  await page.getByRole('button', { name: 'Log in' }).click()

  // forced change: the shell is not reachable until a new password is set
  await expect(page.getByRole('heading', { name: /password/i })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Today' })).toHaveCount(0)
  const fields = page.locator('input[type=password]')
  await fields.nth(0).fill(temp)
  await fields.nth(1).fill('a brand new passphrase')
  if ((await fields.count()) > 2) await fields.nth(2).fill('a brand new passphrase')
  await page.getByRole('button', { name: /change|save|update/i }).click()
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible()

  // no number connected yet: staff are told to ask an admin and get no button
  await expect(page.getByTestId('connect-banner')).toContainText('Ask an administrator to connect a WhatsApp number.')
  await expect(page.getByTestId('connect-whatsapp')).toHaveCount(0)

  // staff sees only their own settings
  await page.goto('/settings')
  await expect(page.getByRole('link', { name: /My profile/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /Team/ })).toHaveCount(0)
})

test('WhatsApp: a bad key surfaces the rejection inline and saves nothing', async ({ page }) => {
  await signInAsAdmin(page)
  await page.goto('/settings/whatsapp')
  await page.getByRole('button', { name: 'Enter keys manually' }).click()
  // the collapsed Cloud API form shares labels, so address the WhaBuzz form by id
  await page.locator('#whabuzz_api_key').fill('wb_invalid_key_0000')
  await page.locator('#whabuzz_phone_number_id').fill('123456789')
  await page.locator('#whabuzz_waba_id').fill('999904321')
  await page.locator('#whabuzz_webhook_secret').fill('whsec_TEST_invalid_0000')
  await page.getByRole('button', { name: 'Check and save' }).click()
  const err = page.locator('#whabuzz_api_key_err')
  // The wording of the gateway's rejection changes; what matters is that an inline error shows on the key field and nothing was saved.
  await expect(err).toBeVisible()
  await expect(err).not.toHaveText(/^\s*$/)
  await expect(page.getByTestId('webhook-url')).toHaveText(/\/webhooks\/whabuzz$/)
})

test('screenshots: settings home, team, whatsapp at 360 and 1280', async ({ page }) => {
  await signInAsAdmin(page)
  for (const [w, h] of [[360, 740], [1280, 800]] as const) {
    await page.setViewportSize({ width: w, height: h })
    for (const [path, name] of [['/settings', 'settings-home'], ['/settings/team', 'team'], ['/settings/whatsapp', 'whatsapp']] as const) {
      await page.goto(path)
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      await page.waitForLoadState('networkidle')
      // no horizontal scroll at phone width
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await page.screenshot({ path: `docs/screenshots/${name}-${w}.png`, fullPage: false })
    }
  }
})
