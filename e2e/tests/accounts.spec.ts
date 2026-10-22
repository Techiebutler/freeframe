import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { accessToken, json, primary, savedRefreshToken, secondary, type Account } from '../fixtures/accounts'
import { hangParts, holdParts } from '../fixtures/faults'
import { count, MB, mineOf, openProject, pngs, recordUploadCalls, removeScenarioFiles, summary, until } from '../fixtures/scenario'
import { closeUploads, dropFiles, openUploads, rows, submitLoginForm, uploadRow } from '../fixtures/stack'

/**
 * Accounts and tabs (SCENARIOS.md: A1, A2, A3, R2). Every test runs two pages in
 * one browser context, so they share localStorage the way two tabs of one
 * browser do: a sign-in or a log out in one reaches the other as a `storage`
 * event, which is what the upload queue listens for.
 *
 * Signing in mid-test writes the two tokens the way the login form does
 * (`setTokens`: both in localStorage, both as cookies) instead of going through
 * the form each time, because `/auth/login` allows 10 per 600 s per IP. The
 * other tab sees the same `storage` event either way. A1 signs back in through
 * the real form once, since "after signing back in" is the scenario.
 */

test.afterEach(() => removeScenarioFiles())

const ACCOUNT_SWITCHED = 'Another account signed in. Add these files again after signing back in.'
const SIGNED_OUT = 'Signed out in another tab. Add these files again after signing in.'

// ─── Accounts ──────────────────────────────────────────────────────────────────

/** A fresh pair of tokens for an account, from its saved session's refresh token. */
async function tokensFor(account: Account): Promise<{ access: string; refresh: string }> {
  const refresh = savedRefreshToken(account)
  if (!refresh) throw new Error(`No saved session for ${account.email}; run the suite so the setup project makes one`)
  const t = await json<{ access_token: string; refresh_token?: string }>('POST', '/auth/refresh', { body: { refresh_token: refresh } })
  return { access: t.access_token, refresh: t.refresh_token ?? refresh }
}

/**
 * Sign `page` in with these tokens, exactly as the login form's `setTokens`
 * does, then load `path`. The page must already be on the app's origin.
 */
async function signInWithTokens(page: Page, tokens: { access: string; refresh: string }, path = '/projects'): Promise<void> {
  await page.evaluate(({ access, refresh }) => {
    window.localStorage.setItem('ff_access_token', access)
    window.localStorage.setItem('ff_refresh_token', refresh)
    const week = 60 * 60 * 24 * 7
    document.cookie = `ff_access_token=${access}; path=/; max-age=${week}; SameSite=Lax`
    document.cookie = `ff_refresh_token=${refresh}; path=/; max-age=${week}; SameSite=Lax`
  }, tokens)
  // A login page still settling may send itself on to /projects now that it sees a token, as it does
  // when a person signs in; that interrupts this load, and then this one is made again.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await page.goto(path)
      return
    } catch (error) {
      if (attempt >= 2 || !/interrupted by another navigation/.test(String(error))) throw error
      await page.waitForLoadState('load')
    }
  }
}

/**
 * Log out through the sidebar's account menu, as a person does. The menu's
 * button shows the account's email in the wide sidebar and is titled with its
 * name in the narrow rail.
 */
async function logOut(page: Page, account: Account): Promise<void> {
  const me = await json<{ name: string }>('GET', '/auth/me', { token: await accessToken(account) })
  await page.locator(`button[aria-haspopup="menu"]:has-text("${account.email}"), button[aria-haspopup="menu"][title="${me.name}"]`).click()
  await page.getByRole('menuitem', { name: 'Log out' }).click()
  await expect(page).toHaveURL(/\/login/)
}

/** The rows saved in shared storage for these files, as the store wrote them. */
async function savedRows(page: Page, names: string[]) {
  return page.evaluate((wanted) => {
    const files = JSON.parse(window.localStorage.getItem('ff-uploads') ?? '{}').state?.files ?? []
    return (files as any[])
      .filter((f) => wanted.includes(f.assetName))
      .map((f) => ({ name: f.assetName as string, status: f.status as string, error: (f.error ?? null) as string | null, ownerId: (f.ownerId ?? null) as string | null }))
  }, names)
}

/**
 * Resolves once `page` has its first page of upload history from the server
 * (`fetchHistory`, `/me/assets?filter=owned&skip=0`) and has drawn what it
 * holds. Call it before the load that asks: the panel's history is the last of
 * what a freshly signed-in page shows, so a row missing after it is missing.
 */
function historyShown(page: Page): Promise<void> {
  return page
    .waitForResponse((r) => r.request().method() === 'GET' && /\/me\/assets\?filter=owned&skip=0&/.test(r.url()), { timeout: 30_000 })
    .then(async (r) => {
      await r.finished()
      await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
    })
}

// ─── A1 ────────────────────────────────────────────────────────────────────────

test('A1: a log out in another tab fails the queued files with the signed-out message, kept for the owner', async ({ context, page }) => {
  test.setTimeout(4 * 60_000)
  const me = await primary()
  await openProject(page, 'A1')
  const calls = recordUploadCalls(page)
  const hold = await holdParts(page)
  const files = await pngs('a1', Array(5).fill(1 * MB))
  await dropFiles(page, 'project', files.map((f) => f.file))
  await openUploads(page)
  const frozen = await until(page, files, '3 uploading and 2 queued', (m) => m.length === 5 && count(m, 'uploading') === 3 && count(m, 'queued') === 2)
  const queued = frozen.filter((r) => r.status === 'queued').map((r) => r.name)
  const started = frozen.filter((r) => r.status === 'uploading').map((r) => r.name)

  // Tab B, same browser: log out.
  const pageB = await context.newPage()
  await pageB.goto('/projects')
  await logOut(pageB, me)

  // A: the queued files fail at once, saved with their owner, and none of them asks for anything.
  await expect.poll(async () => (await savedRows(page, queued)).map((r) => `${r.status}|${r.error}|${r.ownerId}`), { timeout: 10_000 })
    .toEqual(queued.map(() => `failed|${SIGNED_OUT}|${me.id}`))
  // The three that were sending carry on as far as they can without the account: their parts were
  // presigned before the log out and go through, and then nothing more is sent (the completion would
  // need the owner's token). They end Interrupted, resumable by their owner.
  hold.release()
  await expect.poll(async () => (await savedRows(page, started)).map((r) => r.status), { timeout: 30_000 })
    .toEqual(started.map(() => 'interrupted'))
  await page.waitForTimeout(1_000)
  expect(calls.initiates.filter((c) => queued.includes(c.name)), 'no initiate for a queued file').toEqual([])
  expect(calls.completes, 'no completion sent without the owner').toEqual([])

  // A goes to the login page, with no prompt, at its next request to the API: the 401, with no
  // refresh token left to try, ends the session (spec goal 9, "Token removed"). Nothing in A asks the
  // server anything on its own once its uploads have stopped, so the person uses the tab again: they
  // open Notifications, which asks the API for them. (A click on a link would be answered by the
  // middleware instead; see the Phase 4 results in SCENARIOS.md for what that does to the sign-in after.)
  const dialogs: string[] = []
  page.on('dialog', (d) => {
    dialogs.push(d.type())
    void d.dismiss().catch(() => {})
  })
  await closeUploads(page)
  // The login page looks for a token once, as it mounts, and with none it asks the API whether setup is
  // needed: that request is the page's own, made by the browser (the middleware's is made by the server).
  const loginChecked = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/setup/status'), { timeout: 30_000 })
  await page.locator('button[title="Notifications"], button:has(span:text-is("Notifications"))').first().click()
  await expect(page).toHaveURL(/\/login/, { timeout: 30_000 })
  expect(dialogs, 'no prompt on the way to the login page').toEqual([])
  // The login form is up (it looks for a token only as it loads, so it stays up whoever signs in elsewhere).
  // Wait for that look to have been made too: the server renders the form before the page's own check has
  // run, and that check, run after B's sign-in below, would take A straight to B's account.
  await expect(page.getByRole('button', { name: 'Sign in with password instead' }).or(page.getByPlaceholder('Your password'))).toBeVisible()
  await loginChecked
  await page.waitForLoadState('networkidle')

  // B signs in as secondary, who sees none of it.
  const secondarysHistory = historyShown(pageB)
  await signInWithTokens(pageB, await tokensFor(await secondary()))
  await openUploads(pageB)
  await secondarysHistory
  expect(mineOf(await rows(pageB), files), 'secondary sees none of primary\'s rows').toEqual([])

  // A signs back in as primary, through the login form it was sent to: the queued files are Failed with
  // the signed-out message, and the ones that had started are Interrupted.
  await submitLoginForm(page, me)
  await openUploads(page)
  const back = await until(page, files, 'all five rows back', (m) => m.length === 5)
  for (const name of queued) {
    expect(back.find((r) => r.name === name), name).toMatchObject({ status: 'failed', kind: 'failed', detail: SIGNED_OUT })
  }
  test.info().annotations.push({ type: 'rows after signing back in', description: summary(back) })
  for (const name of started) {
    expect(back.find((r) => r.name === name), name).toMatchObject({ status: 'interrupted', kind: 'interrupted' })
  }
})

// ─── A2 ────────────────────────────────────────────────────────────────────────

/**
 * A new user invited by primary, through the admin API. A fresh address every
 * run: an invite can be accepted once, and the cached `secondary` accepted its
 * own when it was made. `example.com`, as `accounts.ts` uses: the API's email
 * check refuses the reserved `.test` domain.
 */
async function freshInvite(): Promise<{ id: string; email: string; token: string }> {
  const email = `e2e-invitee-${Date.now()}@example.com`
  const invited = await json<{ id: string; invite_token: string }>('POST', '/users/invite', {
    token: await accessToken(await primary()),
    body: { email, name: 'E2E Invitee' },
  })
  return { id: invited.id, email, token: invited.invite_token }
}

/** Deactivates, then deletes, a user `freshInvite` made, so runs do not pile them up. */
async function removeInvitee(id: string): Promise<void> {
  const token = await accessToken(await primary())
  await json('PATCH', `/admin/users/${id}/deactivate`, { token })
  await json('DELETE', `/users/${id}`, { token })
}

test('A2: an invite accepted in another tab while A sends: sending rows end Interrupted, queued rows fail, nothing lands in the new account', async ({ context, page }) => {
  test.setTimeout(4 * 60_000)
  const me = await primary()
  const invitee = await freshInvite()
  // The invitee is removed whatever happens. A failure to remove it fails a run that passed, and does
  // not hide the reason one failed. The project stays, as every scenario's does.
  let passed = false
  try {
    const { project } = await openProject(page, 'A2')
    // The invitee may upload into this project, so a file sent with their token would be accepted and
    // land in their account. That is what must not happen.
    await json('POST', `/projects/${project.id}/members`, {
      token: await accessToken(me),
      body: { user_id: invitee.id, role: 'editor' },
    })

    const calls = recordUploadCalls(page)
    const hold = await holdParts(page)
    const files = await pngs('a2', Array(5).fill(1 * MB))
    await dropFiles(page, 'project', files.map((f) => f.file))
    await openUploads(page)
    const frozen = await until(page, files, '3 uploading and 2 queued', (m) => m.length === 5 && count(m, 'uploading') === 3 && count(m, 'queued') === 2)
    const queued = frozen.filter((r) => r.status === 'queued').map((r) => r.name)
    const started = frozen.filter((r) => r.status === 'uploading').map((r) => r.name)
    expect(calls.initiates.map((c) => c.name).sort()).toEqual([...started].sort())

    // Tab B, same browser: the invite link, accepted the way the invitee does it.
    const pageB = await context.newPage()
    await pageB.goto(`/invite/${invitee.token}`)
    await pageB.getByPlaceholder('Alex Johnson').fill('E2E Invitee')
    await pageB.getByPlaceholder('Min. 8 characters').fill('e2e-invitee-password')
    await pageB.getByPlaceholder('Repeat password').fill('e2e-invitee-password')
    await pageB.getByRole('button', { name: 'Create account & join' }).click()
    await expect(pageB).toHaveURL(/\/projects/, { timeout: 30_000 })
    const inviteeToken = await pageB.evaluate(() => window.localStorage.getItem('ff_access_token'))
    expect(inviteeToken, 'B is signed in as the invitee').toBeTruthy()

    // A: the queued files fail at once with the account message, saved for their owner.
    await expect.poll(async () => (await savedRows(page, queued)).map((r) => `${r.status}|${r.error}|${r.ownerId}`), { timeout: 10_000 })
      .toEqual(queued.map(() => `failed|${ACCOUNT_SWITCHED}|${me.id}`))
    // The ones sending: their presigned parts go through, nothing more is sent, and they end Interrupted.
    hold.release()
    await expect.poll(async () => (await savedRows(page, started)).map((r) => `${r.status}|${r.ownerId}`), { timeout: 30_000 })
      .toEqual(started.map(() => `interrupted|${me.id}`))
    // A now shows the invitee's uploads, which are none of these.
    await expect.poll(async () => mineOf(await rows(page), files), { timeout: 10_000 }).toEqual([])
    await page.waitForTimeout(2_000) // anything still on its way from A goes out in this time
    expect(calls.initiates.filter((c) => queued.includes(c.name)), 'no initiate for a queued file').toEqual([])
    expect(calls.completes, 'no completion sent').toEqual([])

    // Nothing landed in the invitee's account. `/me/assets?filter=owned` lists every asset an account
    // created, unfinished uploads included (the panel rebuilds Interrupted rows from it): primary's list
    // holds the three that started, which shows the check can see such an asset at all.
    const owned = async (token: string) =>
      (await json<Array<{ name: string; project_id: string }>>('GET', '/me/assets?filter=owned&limit=100', { token }))
    expect((await owned(inviteeToken!)).map((a) => a.name), 'assets created by the invitee').toEqual([])
    const primarys = (await owned(await accessToken(me))).filter((a) => a.project_id === project.id).map((a) => a.name)
    expect(primarys.sort(), 'the assets made in this project, all primary\'s').toEqual([...started].sort())

    // Back as primary (in B): A shows them again, the queued ones Failed with the account message.
    await signInWithTokens(pageB, await tokensFor(me))
    const back = await until(page, files, 'all five rows back in A', (m) => m.length === 5)
    for (const name of queued) {
      expect(back.find((r) => r.name === name), name).toMatchObject({ status: 'failed', kind: 'failed', detail: ACCOUNT_SWITCHED })
    }
    for (const name of started) {
      expect(back.find((r) => r.name === name), name).toMatchObject({ status: 'interrupted', kind: 'interrupted' })
    }
    passed = true
  } finally {
    try {
      await removeInvitee(invitee.id)
    } catch (error) {
      if (passed) throw error
      test.info().annotations.push({ type: 'invitee not removed', description: String(error) })
    }
  }
})

// ─── A3 ────────────────────────────────────────────────────────────────────────

/**
 * A fresh page of `context` that is a closed tab reopened: it gets the closed
 * page's tab id, which the app keeps in sessionStorage and a browser's "reopen
 * closed tab" brings back. Without it the page is another tab, and an upload
 * the closed one stamped less than 150 s ago reads "Elsewhere", not
 * "Interrupted".
 */
async function reopenTab(context: BrowserContext, tab: string, path: string): Promise<Page> {
  const page = await context.newPage()
  await page.addInitScript((id) => {
    try {
      if (!window.sessionStorage.getItem('ff-upload-tab')) window.sessionStorage.setItem('ff-upload-tab', id)
    } catch {
      /* storage blocked */
    }
  }, tab)
  await page.goto(path)
  return page
}

/**
 * Uploads of `account`'s that were interrupted by closing the page sending
 * them: every part PUT hangs, so the rows are saved with their version and
 * multipart ids and nothing sent. Returns the files and the closed tab's id.
 */
async function leaveInterrupted(page: Page, tag: string, n: number, bytes = 1 * MB) {
  const { project } = await openProject(page, tag.toUpperCase())
  await hangParts(page)
  const files = await pngs(tag, Array(n).fill(bytes))
  await dropFiles(page, 'project', files.map((f) => f.file))
  await openUploads(page)
  await until(page, files, `${n} uploading`, (m) => m.length === n && count(m, 'uploading') === n)
  // Saved with the ids a resume needs.
  await expect.poll(async () => page.evaluate((names) => {
    const saved = JSON.parse(window.localStorage.getItem('ff-uploads') ?? '{}').state?.files ?? []
    return (saved as any[]).filter((f) => names.includes(f.assetName) && f.versionId && f.uploadId).length
  }, files.map((f) => f.name)), { timeout: 30_000 }).toBe(n)
  const tab = await page.evaluate(() => window.sessionStorage.getItem('ff-upload-tab'))
  expect(tab).toBeTruthy()
  await page.close()
  return { project, files, tab: tab! }
}

test('A3: another account signed in after primary left interrupted uploads sees none of them, and primary sees them again', async ({ context, page }) => {
  test.setTimeout(4 * 60_000)
  const me = await primary()
  const other = await secondary()
  const { project, files, tab } = await leaveInterrupted(page, 'a3', 2)

  // The closed tab, reopened: primary's two uploads are Interrupted, with Resume.
  const pageA = await reopenTab(context, tab, `/projects/${project.id}`)
  await openUploads(pageA)
  await until(pageA, files, 'both Interrupted', (m) => m.length === 2 && count(m, 'interrupted') === 2)

  // Tab B, same browser: primary logs out, and secondary signs in.
  const pageB = await context.newPage()
  await pageB.goto('/projects')
  await logOut(pageB, me)
  const othersHistory = historyShown(pageB)
  await signInWithTokens(pageB, await tokensFor(other))
  await openUploads(pageB)
  // A hears of it at once and shows secondary's uploads, which are none of these.
  await expect.poll(async () => mineOf(await rows(pageA), files), { timeout: 10_000 }).toEqual([])
  await othersHistory
  expect(mineOf(await rows(pageB), files), 'secondary sees none of primary\'s uploads').toEqual([])
  expect(await pageB.getByText(files[0].name).count(), 'not anywhere on secondary\'s page').toBe(0)
  // Hidden, not deleted: both are still saved, for their owner.
  expect((await savedRows(pageB, files.map((f) => f.name))).map((r) => `${r.status}|${r.ownerId}`).sort())
    .toEqual(files.map(() => `interrupted|${me.id}`))

  // Back to primary (in B, logging secondary out first): A shows them again as they were, and so does B.
  await closeUploads(pageB)
  await logOut(pageB, other)
  await signInWithTokens(pageB, await tokensFor(me), `/projects/${project.id}`)
  const againA = await until(pageA, files, 'both back in A', (m) => m.length === 2)
  expect(againA.map((r) => r.status), summary(againA)).toEqual(['interrupted', 'interrupted'])
  await openUploads(pageB)
  const againB = await until(pageB, files, 'both in B', (m) => m.length === 2)
  // B is another tab, so an upload the closed one stamped moments ago may read Elsewhere there for its
  // 150 s window; either way it is primary's and on show.
  expect(againB.every((r) => r.status === 'interrupted' || r.status === 'elsewhere'), summary(againB)).toBe(true)
})

// ─── R2 ────────────────────────────────────────────────────────────────────────

/** What the app waits after an upload last moved before another tab may take it up (LIVE_WINDOW_MS). */
const LIVE_WINDOW_MS = 150_000

test('R2: two tabs Resume the same interrupted upload at once, and exactly one of them sends it', async ({ context, page }) => {
  test.setTimeout(8 * 60_000)
  const { project, files } = await leaveInterrupted(page, 'r2', 1, 12 * MB) // two parts
  const [file] = files
  // Neither tab below is the one that was sending, so both are told to keep off it while the closed
  // tab's last heartbeat (and the server's last sight of the upload) is within the live window: the row
  // reads Elsewhere, with no Resume. Past it, both offer Resume, and only the tabs themselves can keep
  // each other off it.
  await new Promise((resolve) => setTimeout(resolve, LIVE_WINDOW_MS + 10_000))

  const tabs = await Promise.all([1, 2].map(async () => {
    const p = await context.newPage()
    const presigns: number[] = []
    const puts: number[] = []
    const completes: number[] = []
    const partLists: number[] = []
    p.on('request', (r) => {
      const url = r.url()
      if (r.method() === 'GET' && /\/upload\/[0-9a-f-]{36}\/parts(\?|$)/.test(url)) partLists.push(Date.now())
      else if (r.method() === 'POST' && /\/upload\/presign-part$/.test(url)) presigns.push(Date.now())
      else if (r.method() === 'PUT' && /[?&]partNumber=\d+/.test(url)) puts.push(Date.now())
      else if (r.method() === 'POST' && /\/upload\/complete$/.test(url)) completes.push(Date.now())
    })
    await p.goto(`/projects/${project.id}`)
    await openUploads(p)
    await until(p, files, 'the row Interrupted, with Resume', (m) => m.length === 1 && m[0].status === 'interrupted')
    return { page: p, presigns, puts, completes, partLists }
  }))

  // Resume in both: each opens its file picker, then both pick the file at the same moment.
  const choosers = []
  for (const t of tabs) {
    const row = uploadRow(t.page, file.name)
    await row.hover()
    const chooser = t.page.waitForEvent('filechooser')
    await row.locator('button[title^="Resume"]').click()
    choosers.push(await chooser)
  }
  await Promise.all(choosers.map((c) => c.setFiles(file.file)))

  // One of them carries it to the end.
  await expect.poll(async () => {
    const states = await Promise.all(tabs.map(async (t) => mineOf(await rows(t.page), files)[0]?.status ?? '-'))
    return states.some((s) => s === 'processing' || s === 'complete')
  }, { timeout: 120_000 }).toBe(true)
  await tabs[0].page.waitForTimeout(2_000) // anything the other tab would still send goes out in this time

  const states = await Promise.all(tabs.map(async (t) => summary(mineOf(await rows(t.page), files))))
  const t0 = Math.min(...tabs.flatMap((t) => t.partLists))
  const sent = tabs.map((t) => `parts lists at +${t.partLists.map((at) => at - t0).join('/')} ms, presigns ${t.presigns.length}, part PUTs ${t.puts.length}, completes ${t.completes.length}`)
  const report = tabs.map((_, i) => `tab ${i + 1}: ${states[i]}; ${sent[i]}`).join(' | ')
  test.info().annotations.push({ type: 'tabs', description: report })
  // Both really did resume: each asked the server which parts it holds.
  expect(tabs.map((t) => t.partLists.length > 0), `tabs that asked for the parts: ${sent.join(' | ')}`).toEqual([true, true])
  expect(tabs.filter((t) => t.presigns.length > 0).length, `tabs that presigned: ${sent.join(' | ')}`).toBe(1)
  expect(tabs.reduce((n, t) => n + t.completes.length, 0), 'completions sent').toBe(1)
  // The other tab stands aside, and neither ends with a broken upload (two senders once left one tab
  // reading "Upload is incomplete: 1 part(s) missing").
  const finals = await Promise.all(tabs.map(async (t) => mineOf(await rows(t.page), files)[0]?.status))
  expect(finals.filter((s) => s === 'failed' || s === 'interrupted'), report).toEqual([])
  expect(finals.map((s) => (s === 'processing' || s === 'complete' ? 'sent' : s)).sort(), report).toEqual(['elsewhere', 'sent'])
})
