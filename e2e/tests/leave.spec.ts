import { expect, test, type Page } from '@playwright/test'
import { primary, secondary, type Account } from '../fixtures/accounts'
import { holdParts } from '../fixtures/faults'
import { count, MB, mineOf, pngs, removeScenarioFiles, summary, until } from '../fixtures/scenario'
import { closeUploads, createProject, dropFiles, openUploads, resetUploads, rows, signIn } from '../fixtures/stack'

/**
 * Leaving the page with uploads on their way (SCENARIOS.md: L1, L2, L3).
 *
 * While any of the signed-in account's uploads is queued, starting or sending,
 * the app asks the browser to confirm before the page goes (`beforeunload`).
 * Log out asks in the app instead ("N uploads will stop. Log out anyway?") and
 * then leaves with no browser prompt, and so does a session that ends by force.
 *
 * A browser shows the `beforeunload` prompt only to a page the person has
 * interacted with (sticky activation), so every test clicks the page before it
 * leaves; the negatives click too, so a missing prompt is the app's doing.
 * Playwright's clicks are trusted input and count.
 *
 * How Playwright 1.59 reports a dismissed prompt depends on the engine and on
 * how the navigation was started (measured in both engines on this app's
 * /login page, with a listener like the app's added to it):
 *
 * | navigation                               | Chromium, dismissed                 | WebKit, dismissed                                      |
 * |------------------------------------------|-------------------------------------|--------------------------------------------------------|
 * | `page.reload()`                          | never settles (runs to its timeout) | rejects, "navigation cancelled by beforeunload dialog" |
 * | `page.goto(url)`                         | rejects, `net::ERR_ABORTED`         | never settles (runs to its timeout)                    |
 * | `page.evaluate(() => location.reload())` | resolves                            | resolves                                               |
 * | `page.close({ runBeforeUnload: true })`  | resolves, the page stays open       | resolves, the page stays open                          |
 *
 * Accepted, each of them goes through in both engines, and every one shows the
 * prompt as a `dialog` of type `beforeunload`. L1 reloads with `page.reload()`,
 * the browser's own Reload (not a script's), and so does not wait on the
 * promise when the prompt is dismissed: it waits for the dialog and then looks
 * at the page.
 *
 * A dialog nobody answers blocks the page, so each test answers every dialog
 * from the moment it starts (`answerDialogs`).
 *
 * Not run on Firefox: Playwright's Firefox does not launch on the Mac this was
 * written on (see README.md, Known gaps), so L1's prompt there is unmeasured.
 */

test.afterEach(() => removeScenarioFiles())

/**
 * The API allows each account 600 reads a minute (`GlobalRateLimitMiddleware`),
 * and these tests are short: one reads about 30 times in 2 to 4 s (measured;
 * the dev server's strict mode asks twice for most things), so a pass of this
 * file read about 200 times in under 20 s. With every test as primary,
 * `--repeat-each=3` in WebKit spent the minute's budget by its 18th test, twice
 * in two runs. So the L2 tests sign in as `secondary` and the rest as
 * primary, which halves each account's share. The 429 carries no CORS header,
 * so the page sees a failed request rather than an answer, the project page
 * never learns the account's role, and the test times out somewhere
 * unrelated. Count them, and say so when a test fails. Both listeners are
 * needed: a real 429 reached WebKit only as a failed request whose error text
 * names the status, and a 429 fulfilled by `page.route` (no CORS header)
 * reached both engines as a response with that status (checked once, by hand).
 */
let rateLimited = 0
test.beforeEach(({ page }) => {
  rateLimited = 0
  page.on('response', (r) => { if (r.status() === 429) rateLimited += 1 })
  page.on('requestfailed', (r) => { if (/\b429\b/.test(r.failure()?.errorText ?? '')) rateLimited += 1 })
})
test.afterEach(({}, testInfo) => {
  if (rateLimited > 0 && testInfo.status !== testInfo.expectedStatus) {
    throw new Error(`The API answered 429 (its per-account read limit) ${rateLimited} times during this test; the failure above is likely that, not the app. Let a minute pass and run it again.`)
  }
})

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Answer every dialog `page` raises with `answer` (changeable as the test goes),
 * and keep the type of each one seen. Where a test expects no dialog the answer
 * is accept, so a prompt that should not have appeared lets the navigation go
 * on and the test fails on the dialog it recorded, not on a page left behind.
 */
function answerDialogs(page: Page, answer: 'accept' | 'dismiss' = 'accept') {
  const state = { seen: [] as string[], answer }
  page.on('dialog', (d) => {
    state.seen.push(d.type())
    void (state.answer === 'accept' ? d.accept() : d.dismiss()).catch(() => {})
  })
  return state
}

/** A fresh project of `account`'s, open in `page`, signed in, with no upload of this browser's left over. */
async function openCleanProject(page: Page, label: string, account: Account) {
  await signIn(page, account)
  // The saved session carries the uploads list of the browser that made it.
  await resetUploads(page)
  const project = await createProject(account, `E2E ${label} ${Date.now()}`)
  await page.goto(`/projects/${project.id}`)
  await expect(page.getByText('No assets')).toBeVisible()
  // The page takes a drop only once it knows the account may upload here: the role comes from the
  // project's members matched against `/auth/me`, and until both have answered it is "viewer": the drop
  // region's handlers are attached but return early while it is not enabled (`useFileDropRegion`), so a
  // drop goes nowhere (no initiate, no row). Seen in WebKit when those
  // reads were slow to answer (they were being refused with 429, see above). The header's Upload button
  // is drawn on the same condition; the empty project's own is drawn regardless, so two means known.
  await expect(page.getByRole('button', { name: 'Upload', exact: true })).toHaveCount(2, { timeout: 60_000 })
  return { account, project }
}

/**
 * Drop `n` 1 MB PNGs with every part held, and wait for the queue to freeze:
 * the first three Uploading (parts on hold), the rest Queued. The uploads
 * panel is left open. Keep what follows well under the app's 90 s part
 * watchdog (see `holdParts`).
 */
async function freezeQueue(page: Page, tag: string, n: number) {
  const hold = await holdParts(page)
  const files = await pngs(tag, Array(n).fill(1 * MB))
  await dropFiles(page, 'project', files.map((f) => f.file))
  // Opening the panel is two real clicks (the Uploads button, then its All tab): the page now has
  // sticky activation.
  await openUploads(page)
  const sending = Math.min(n, 3)
  const frozen = await until(page, files, `${sending} uploading and ${n - sending} queued`, (m) =>
    m.length === n && count(m, 'uploading') === sending && count(m, 'queued') === n - sending)
  return { hold, files, frozen }
}

/** Drop one small PNG and wait for it to finish, so the account has an upload and nothing on its way. */
async function uploadOneAndFinish(page: Page, tag: string) {
  const files = await pngs(tag, [256 * 1024])
  await dropFiles(page, 'project', files.map((f) => f.file))
  await openUploads(page)
  await until(page, files, 'the upload complete', (m) => m.length === 1 && m[0].status === 'complete')
  return files
}

/** Mark the document, so a reload can be told from a page that stayed. */
async function markDocument(page: Page): Promise<string> {
  const mark = `doc-${Date.now()}-${Math.random()}`
  await page.evaluate((m) => { (window as any).__e2eDocument = m }, mark)
  return mark
}
const documentMark = (page: Page) => page.evaluate(() => ((window as any).__e2eDocument ?? null) as string | null)

/** Both tokens, as the app keeps them. */
const tokens = (page: Page) => page.evaluate(() => ({
  access: window.localStorage.getItem('ff_access_token'),
  refresh: window.localStorage.getItem('ff_refresh_token'),
}))

/**
 * Open the sidebar's account menu, as a person does: the one menu button in
 * the sidebar (it shows the account's email in the wide sidebar and its
 * avatar in the narrow rail). Found without asking the API for the account's
 * name, since the API's per-account read limit is shared with whatever else
 * runs against the stack as the same account. The uploads panel's backdrop covers the
 * sidebar, so close the panel first.
 */
async function openAccountMenu(page: Page): Promise<void> {
  await page.locator('aside button[aria-haspopup="menu"]').click()
  await expect(page.getByRole('menuitem', { name: 'Log out' })).toBeVisible()
}

/** The Log out confirmation, by its exact title. */
const logoutConfirm = (page: Page, uploads: number) =>
  page.getByRole('dialog', { name: `${uploads} ${uploads === 1 ? 'upload' : 'uploads'} will stop. Log out anyway?`, exact: true })

// ─── L1 ────────────────────────────────────────────────────────────────────────

test('L1: a reload with files queued and sending asks first; Stay keeps the page and its rows, Leave reloads', async ({ page }) => {
  test.setTimeout(3 * 60_000)
  await openCleanProject(page, 'L1', await primary())
  const dialogs = answerDialogs(page, 'dismiss')
  const { files, frozen } = await freezeQueue(page, 'l1', 5)
  const mark = await markDocument(page)

  // Reload, and stay. The reload's own promise is left alone (see the table at the top: in Chromium it
  // never settles once the prompt is dismissed, in WebKit it rejects); the prompt is what is awaited.
  const prompted = page.waitForEvent('dialog', { timeout: 15_000 })
  void page.reload().catch(() => {})
  expect((await prompted).type()).toBe('beforeunload')
  // Settle window for a negative: a reload the answer did not stop would replace the document within
  // this time (an accepted one takes about 400 ms on this stack, measured). One second is plenty.
  await page.waitForTimeout(1_000)
  expect(await documentMark(page), 'the page stayed').toBe(mark)
  expect(summary(mineOf(await rows(page), files)), 'the rows are as they were').toBe(summary(frozen))
  expect(dialogs.seen).toEqual(['beforeunload'])

  // Reload again, and leave: the page reloads.
  dialogs.answer = 'accept'
  await openUploads(page) // a click on the page again (its All tab), as a person reaching for Reload would have
  await page.reload()
  expect(dialogs.seen).toEqual(['beforeunload', 'beforeunload'])
  expect(await documentMark(page), 'a new document').toBeNull()
  // What the prompt was about: the three that had started come back Interrupted, to be resumed. (What
  // becomes of the two never-started ones is not this scenario's business, and is left unchecked.)
  await openUploads(page)
  const started = frozen.filter((r) => r.status === 'uploading').map((r) => r.name).sort()
  const isStarted = (r: { name: string }) => started.includes(r.name)
  const after = await until(page, files, 'the three that had started, Interrupted', (m) =>
    m.filter((r) => isStarted(r) && r.status === 'interrupted').length === 3)
  test.info().annotations.push({ type: 'rows after the reload', description: summary(after) })
  expect(after.filter(isStarted).map((r) => `${r.name}|${r.status}`).sort(), summary(after)).toEqual(started.map((n) => `${n}|interrupted`))
})

test('L1 (negative): with nothing queued or sending, a reload asks nothing', async ({ page }) => {
  test.setTimeout(3 * 60_000)
  await openCleanProject(page, 'L1N', await primary())
  const dialogs = answerDialogs(page)
  await uploadOneAndFinish(page, 'l1n') // the panel's clicks give the page sticky activation
  const mark = await markDocument(page)
  // A prompt would be raised, and answered, before the reload could finish, so once `reload()` has
  // resolved there is nothing left to wait for.
  await page.reload()
  expect(await documentMark(page), 'a new document').toBeNull()
  expect(dialogs.seen, 'no prompt').toEqual([])
})

// ─── L2 ────────────────────────────────────────────────────────────────────────

test('L2: Log out with files queued asks in the app; Cancel keeps everything and the page usable, Log out leaves with no browser prompt', async ({ page }) => {
  test.setTimeout(3 * 60_000)
  await openCleanProject(page, 'L2', await secondary())
  const dialogs = answerDialogs(page)
  const { files, frozen } = await freezeQueue(page, 'l2', 5)
  const signedIn = await tokens(page)
  expect(signedIn.access && signedIn.refresh, 'signed in').toBeTruthy()
  await closeUploads(page)

  // Log out: the app asks, with the count of what would stop (three sending, two queued).
  await openAccountMenu(page)
  await page.getByRole('menuitem', { name: 'Log out' }).click()
  const confirm = logoutConfirm(page, 5)
  await expect(confirm).toBeVisible()

  // Cancel: nothing is cleared, the rows are as they were, and the page takes clicks again.
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(confirm).toBeHidden()
  expect(await tokens(page), 'the tokens are kept').toEqual(signedIn)
  // Radix holds <body> at `pointer-events: none` while a modal is open and puts it back as the modal
  // closes; a lock left behind keeps every click from landing. The click that follows is the real check.
  // This does not guard the sidebar's handoff (the confirmation opened only once the menu has closed):
  // with that reverted, so the dialog opens from inside the menu's pick, this test still passed, twice in
  // each engine. This stack has a single Radix copy (react-dismissable-layer 1.2.1) and cannot reproduce
  // the duplicate-layer lock; the jsdom unit test "asks only once the menu has let go of the page"
  // (`sidebar-logout-confirm.test.tsx`) pins the handoff.
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).pointerEvents), { timeout: 5_000 }).not.toBe('none')
  await openUploads(page)
  expect(summary(mineOf(await rows(page), files)), 'the rows are as they were').toBe(summary(frozen))
  await closeUploads(page)
  expect(page.url(), 'still here').toContain('/projects/')

  // Log out again, and confirm: the login page, with no browser prompt on the way.
  await openAccountMenu(page)
  await page.getByRole('menuitem', { name: 'Log out' }).click()
  await expect(confirm).toBeVisible()
  await confirm.getByRole('button', { name: 'Log out', exact: true }).click()
  await expect(page).toHaveURL(/\/login/)
  expect(dialogs.seen, 'no browser prompt').toEqual([])
  expect(await tokens(page), 'signed out').toEqual({ access: null, refresh: null })
})

test('L2 (one file): the confirmation says "1 upload will stop", and Log out leaves with no browser prompt', async ({ page }) => {
  test.setTimeout(3 * 60_000)
  await openCleanProject(page, 'L2S', await secondary())
  const dialogs = answerDialogs(page)
  await freezeQueue(page, 'l2s', 1)
  await closeUploads(page)
  await openAccountMenu(page)
  await page.getByRole('menuitem', { name: 'Log out' }).click()
  const confirm = logoutConfirm(page, 1)
  await expect(confirm).toBeVisible()
  await confirm.getByRole('button', { name: 'Log out', exact: true }).click()
  await expect(page).toHaveURL(/\/login/)
  expect(dialogs.seen, 'no browser prompt').toEqual([])
})

test('L2 (negative): Log out with nothing queued or sending asks nothing', async ({ page }) => {
  test.setTimeout(3 * 60_000)
  await openCleanProject(page, 'L2N', await secondary())
  const dialogs = answerDialogs(page)
  await uploadOneAndFinish(page, 'l2n')
  await closeUploads(page)
  // The page leaves the moment Log out is picked, so a confirmation that flashed up on the way would be
  // gone before it could be looked for. Watch for one as it happens, and keep what was seen in
  // sessionStorage, which the tab keeps across the load of /login.
  await page.evaluate(() => {
    new MutationObserver(() => {
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) window.sessionStorage.setItem('e2e-dialog-seen', '1')
    }).observe(document.body, { childList: true, subtree: true })
  })
  await openAccountMenu(page)
  await page.getByRole('menuitem', { name: 'Log out' }).click()
  await expect(page).toHaveURL(/\/login/)
  expect(await page.evaluate(() => window.sessionStorage.getItem('e2e-dialog-seen')), 'no confirmation').toBeNull()
  expect(dialogs.seen, 'no browser prompt').toEqual([])
})

// ─── L3 ────────────────────────────────────────────────────────────────────────

test('L3: a session that ends on its own goes to /login with no prompt, even with files queued', async ({ page }) => {
  test.setTimeout(3 * 60_000)
  await openCleanProject(page, 'L3', await primary())
  const dialogs = answerDialogs(page)
  const { files } = await freezeQueue(page, 'l3', 5)
  await closeUploads(page)

  // The session expires: both tokens are gone from storage (in this tab, so no `storage` event tells the
  // queue). Nothing happens until the page next asks the API something: the person opens Notifications,
  // the request answers 401, there is no refresh token to try, and `clearTokens` sends the page to
  // /login (the same chain as A1). The uploads were still queued and sending as it went.
  await page.evaluate(() => {
    window.localStorage.removeItem('ff_access_token')
    window.localStorage.removeItem('ff_refresh_token')
  })
  const saved = await page.evaluate((names) => {
    const all = JSON.parse(window.localStorage.getItem('ff-uploads') ?? '{}').state?.files ?? []
    return (all as any[]).filter((f) => names.includes(f.assetName)).map((f) => f.status as string).sort()
  }, files.map((f) => f.name))
  // Nothing in the tab noticed: the three sending are still saved as sending. (Queued rows are kept in
  // memory only, never in storage, so the two queued ones are not in this list; the panel showed them
  // Queued a moment ago, in `freezeQueue`.)
  expect(saved, 'still on their way as the session ends').toEqual(['uploading', 'uploading', 'uploading'])
  await page.locator('button[title="Notifications"], button:has(span:text-is("Notifications"))').first().click()
  await expect(page).toHaveURL(/\/login/, { timeout: 30_000 })
  expect(dialogs.seen, 'no browser prompt').toEqual([])
})
