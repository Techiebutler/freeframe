import { test as setup } from '@playwright/test'
import fs from 'node:fs'
import { primary, secondary } from '../fixtures/accounts'
import { AUTH_DIR } from '../fixtures/env'
import { authFile, sessionIsFresh, signInThroughForm } from '../fixtures/stack'

/**
 * Sign each account in through the login form and save the session to `.auth/`
 * for `signIn` to load in every other test.
 *
 * `/auth/login` allows 10 attempts per 600 s per IP, so a session that still
 * works (its refresh token is accepted) is kept and the test is reported as
 * skipped, not passed. The form itself is covered by the smoke scenario, which
 * logs in through it on every run. Set `E2E_FORCE_LOGIN=1` to sign in here
 * regardless.
 */
for (const [role, get] of [
  ['primary', primary],
  ['secondary', secondary],
] as const) {
  setup(`sign in ${role} through the login form`, async ({ page }) => {
    const account = await get()
    setup.skip(
      !process.env.E2E_FORCE_LOGIN && (await sessionIsFresh(account)),
      `${role}'s saved session still works; set E2E_FORCE_LOGIN=1 to sign in again`,
    )
    await signInThroughForm(page, account)
    fs.mkdirSync(AUTH_DIR, { recursive: true })
    await page.context().storageState({ path: authFile(account) })
  })
}
