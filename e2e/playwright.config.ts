import { defineConfig, devices } from '@playwright/test'

/**
 * Real-browser tests against a running FreeFrame stack. See README.md.
 *
 * One worker, no retries: the scenarios share one backend and one set of
 * accounts, and a retry that passes would hide exactly the races (a second
 * tab, a reload mid-transfer) these tests exist to catch.
 *
 * The `setup` project signs the two accounts in through the real login form
 * and saves their sessions to `.auth/`. Every browser project depends on it,
 * so `pnpm test:webkit` runs it first too (it always runs in Chromium; a saved
 * session is plain cookies plus localStorage and loads in any engine).
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // A dev-mode Next server compiles each route on first visit, and a large
  // upload is slow by design, so the budgets are generous.
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    navigationTimeout: 60_000,
    actionTimeout: 20_000,
  },
  projects: [
    {
      name: 'setup',
      testMatch: /.*\.setup\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'chromium',
      testMatch: /.*\.spec\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'webkit',
      testMatch: /.*\.spec\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Safari'] },
    },
    {
      name: 'firefox',
      testMatch: /.*\.spec\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Firefox'] },
    },
  ],
})
