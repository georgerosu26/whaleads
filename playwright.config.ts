import { defineConfig, devices } from '@playwright/test'

const AUTH_FILE = 'test/e2e/.auth/admin.json'
const PORT = Number(process.env.PW_PORT ?? 8799)
export default defineConfig({
  testDir: 'test/e2e',
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
  // Login is rate-limited per IP (10 per 15 min), so the later specs share one signed-in storageState instead of each logging in.
  // The onboarding specs exercise setup/login/logout themselves and run first; 'auth' signs in once; 'app' reuses it.
  projects: [
    { name: 'onboarding', testMatch: /(setup-login|settings-staff|zrecover)\.spec\.ts/ },
    { name: 'auth', testMatch: /auth\.setup\.ts/, dependencies: ['onboarding'] },
    { name: 'app', testMatch: /(inbox|inbox-send-media|crm-leads|push|templates|broadcasts|automation-run|flow-editor|reports-export|whabuzz-connect|zlive|zws)\.spec\.ts/, dependencies: ['auth'], use: { storageState: AUTH_FILE } },
    // Safari engine, for the flow-editor canvas only. PW_WEBKIT overrides the binary when the cached revision differs. Run: npx playwright test --project=auth --project=app-webkit
    { name: 'app-webkit', testMatch: /flow-editor\.spec\.ts/, dependencies: ['auth'], use: { ...devices['Desktop Safari'], storageState: AUTH_FILE, serviceWorkers: 'block', launchOptions: process.env.PW_WEBKIT ? { executablePath: process.env.PW_WEBKIT } : {} } },
  ],
  use: { baseURL: `http://localhost:${PORT}`, ...(process.env.PW_CHROMIUM ? { launchOptions: { executablePath: process.env.PW_CHROMIUM } } : {}) },
  webServer: {
    // Fresh local D1 on every run; throwaway secrets, local only.
    command: `rm -rf .e2e-state && npx wrangler dev --port ${PORT} --local-upstream localhost:${PORT} --persist-to .e2e-state --var SESSION_SECRET:e2e-local-session-secret-0123456789 --var ADMIN_KEY:e2e-local-admin-key --var WHABUZZ_BASE_URL:http://127.0.0.1:${PORT + 1}/v1 --var WHABUZZ_CONNECT_BASE:http://127.0.0.1:${PORT + 1}`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
