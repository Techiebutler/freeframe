import { expect, type Page, test as setup } from '@playwright/test'
import fs from 'node:fs'
import { type Account, primary, secondary } from '../fixtures/accounts'
import { AUTH_DIR } from '../fixtures/env'
import { authFile, sessionIsFresh } from '../fixtures/stack'

/**
 * Sign each account in through the real login form, in password mode, and save
 * the session to `.auth/` for `signIn` to load in every test.
 *
 * `/auth/login` allows 10 attempts per 600 s per IP and a run needs two, so a
 * session that still works (its refresh token is accepted) is kept rather than
 * replaced. Set `E2E_FORCE_LOGIN=1` to sign in regardless.
 */
async function signInThroughForm(page: Page, account: Account) {
  await page.goto('/login')
  // The form opens in magic-code mode unless the instance defaults to a password.
  const toPassword = page.getByRole('button', { name: 'Sign in with password instead' })
  const email = page.getByPlaceholder('you@example.com')
  await expect(toPassword.or(page.getByPlaceholder('Your password'))).toBeVisible()
  // Let React hydrate before typing: a controlled input is reset to '' when it does.
  await page.waitForLoadState('networkidle')
  if (await toPassword.isVisible()) await toPassword.click()

  await email.fill(account.email)
  await page.getByPlaceholder('Your password').fill(account.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).toHaveURL(/\/projects/)
}

for (const [role, get] of [
  ['primary', primary],
  ['secondary', secondary],
] as const) {
  setup(`sign in ${role} through the login form`, async ({ page }) => {
    const account = await get()
    if (!process.env.E2E_FORCE_LOGIN && (await sessionIsFresh(account))) {
      setup.info().annotations.push({ type: 'kept', description: `${role}'s saved session still works` })
      return
    }
    await signInThroughForm(page, account)
    fs.mkdirSync(AUTH_DIR, { recursive: true })
    await page.context().storageState({ path: authFile(account) })
  })
}
