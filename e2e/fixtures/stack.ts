import { expect, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs'
import { type Account, accessToken, json, savedRefreshToken } from './accounts'
import { authFile } from './env'

export { apiUrl, authFile } from './env'

// ─── Sessions ──────────────────────────────────────────────────────────────────

type StorageState = {
  cookies: Parameters<ReturnType<Page['context']>['addCookies']>[0]
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>
}

/**
 * Sign `page` in as `account` without touching the login form.
 *
 * Loads the session the `setup` project saved to `.auth/<account>.json`: its
 * cookies go into the page's context and its localStorage (where the app keeps
 * its tokens) into the app's origin. Doing it per test keeps a suite of any
 * size under `/auth/login`'s limit of 10 per 600 s. The access token in the
 * file may have expired by now; the app swaps it for a new one with the
 * refresh token on its first 401.
 *
 * Leaves the page on `/login`, which is public and does not redirect until a
 * reload, so call `page.goto` afterwards.
 */
export async function signIn(page: Page, account: Account): Promise<void> {
  const file = authFile(account)
  if (!fs.existsSync(file)) {
    throw new Error(`No saved session at ${file}. The "setup" project creates it; run the suite, not a single project with --no-deps.`)
  }
  const state = JSON.parse(fs.readFileSync(file, 'utf8')) as StorageState
  if (state.cookies.length) await page.context().addCookies(state.cookies)
  await page.goto('/login')
  const items = state.origins.flatMap((o) => o.localStorage)
  await page.evaluate((entries) => {
    for (const { name, value } of entries) window.localStorage.setItem(name, value)
  }, items)
}

/**
 * Sign `page` in as `account` the way a person does: through the real login
 * form, in password mode, ending on `/projects`.
 *
 * Each call is one `POST /auth/login`, which allows 10 per 600 s per IP, so
 * use it where the form is the thing under test (the smoke scenario, and the
 * `setup` project when it has no session to reuse) and `signIn` everywhere else.
 */
export async function signInThroughForm(page: Page, account: Account): Promise<void> {
  await page.goto('/login')
  // The form opens in magic-code mode unless the instance defaults to a password.
  const toPassword = page.getByRole('button', { name: 'Sign in with password instead' })
  const password = page.getByPlaceholder('Your password')
  await expect(toPassword.or(password)).toBeVisible()
  // Let React hydrate before typing: a controlled input is reset to '' when it does.
  await page.waitForLoadState('networkidle')
  if (await toPassword.isVisible()) await toPassword.click()

  await page.getByPlaceholder('you@example.com').fill(account.email)
  await password.fill(account.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).toHaveURL(/\/projects/)
  await settleOn(page, '/projects')
}

/**
 * Load `path` for real, and be sure nothing is still on its way to the page.
 *
 * The app gets from the login form to /projects by a client-side navigation
 * that, on a dev server still compiling the page, fails (`ChunkLoadError`) and
 * falls back to a full page load of /projects a moment after the URL has
 * already changed. A `page.goto` made in that moment is interrupted by it
 * ("interrupted by another navigation to /projects"); seen in WebKit in half
 * of a series of runs. Loading the page ourselves replaces whatever the router
 * had pending, and an interruption means the fallback got there first, which is
 * the same place.
 */
async function settleOn(page: Page, path: string): Promise<void> {
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

/** Whether an account's saved session still works: its refresh token buys a new access token. */
export async function sessionIsFresh(account: Account): Promise<boolean> {
  if (!savedRefreshToken(account)) return false
  try {
    await accessToken(account)
    return true
  } catch {
    return false
  }
}

// ─── API shortcuts ─────────────────────────────────────────────────────────────

/** Create a project owned by `account`, through the API. */
export async function createProject(account: Account, name: string): Promise<{ id: string }> {
  const token = await accessToken(account)
  const project = await json<{ id: string }>('POST', '/projects', { token, body: { name } })
  return { id: project.id }
}

/**
 * Forget every upload this browser knows about: the `ff-uploads` list in
 * localStorage and the tab's id in sessionStorage.
 *
 * Call it on an app page before the page that should start clean is loaded
 * (right after `signIn`, say). Called on a page that is running the upload
 * store, the store writes its in-memory list straight back.
 */
export async function resetUploads(page: Page): Promise<void> {
  await page.evaluate(() => {
    try {
      window.localStorage.removeItem('ff-uploads')
      window.sessionStorage.removeItem('ff-upload-tab')
    } catch {
      /* storage blocked: nothing to reset */
    }
  })
}

// ─── The uploads panel ─────────────────────────────────────────────────────────

/**
 * The sidebar's Uploads button. Titled "Uploads" in the narrow rail, labelled by
 * a span in the wide sidebar; a badge with the active count replaces the
 * accessible name in the rail, so neither can be found by role.
 */
function uploadsButton(page: Page): Locator {
  return page.locator('button[title="Uploads"], button:has(span:text-is("Uploads"))').first()
}

/** The uploads panel: the fixed column that holds the "Uploads" heading. */
function uploadsPanel(page: Page): Locator {
  return page.locator('div.fixed', { has: page.getByRole('heading', { name: /^Uploads/ }) })
}

/**
 * Open the uploads panel and show every row.
 *
 * The panel opens on its Active tab, which hides finished uploads, so this
 * switches to All. The panel also lists the account's earlier uploads from the
 * server; give a scenario's files names no other run used and find them by
 * name.
 */
export async function openUploads(page: Page): Promise<void> {
  const panel = uploadsPanel(page)
  if (!(await panel.isVisible())) {
    await uploadsButton(page).click()
    await panel.waitFor({ state: 'visible' })
  }
  // The tab's name is "All" followed by its count with no space, "All1".
  await panel.getByRole('button', { name: /^All/ }).click()
}

/**
 * Every row of the uploads panel, top to bottom, as the panel shows it.
 *
 * `status` is the badge ("Queued", "Uploading", "Processing", "Ready",
 * "Failed", ...) and `detail` the line under the progress bar ("Uploading 40%",
 * an error message, ...). Open the panel first with `openUploads`.
 */
export async function rows(page: Page): Promise<Array<{ name: string; status: string; detail: string }>> {
  return uploadsPanel(page).evaluate((panel) =>
    Array.from(panel.querySelectorAll('div.group.items-start')).map((row) => {
      const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
      const editing = row.querySelector<HTMLInputElement>('input[aria-label="Asset name"]')
      return {
        name: editing ? editing.value : text(row.querySelector('p.font-medium, button[title="Rename"]')),
        status: text(row.querySelector('span.rounded-full')),
        detail: text(row.querySelector('div.mt-1')),
      }
    }),
  )
}

// ─── Dropping files ────────────────────────────────────────────────────────────

/**
 * The asset area of a project page: the element that owns the drop handlers
 * for "upload into the folder being shown". It and the folder-card lookup in
 * `dropFiles` are the only places that know what the page looks like.
 */
const PROJECT_DROP_REGION = 'div.relative.flex-1.flex.min-w-0.h-full'

/**
 * Drop files from disk onto a project page, the way a user drags them in.
 *
 * `'project'` drops on the asset area (which uploads into the folder it shows);
 * `{ folderId }` drops on that folder's card, which must be on screen.
 *
 * Playwright cannot drag from the desktop, so this builds the same thing the
 * browser would hand the page: real `File` objects, read from disk by
 * `setInputFiles` on a throwaway hidden input, packed into a `DataTransfer`
 * and delivered as `dragenter`, `dragover` and `drop` at the target's centre.
 */
export async function dropFiles(
  page: Page,
  target: 'project' | { folderId: string },
  paths: string[],
): Promise<void> {
  const inputId = `e2e-drop-input-${Date.now()}`
  await page.evaluate((id) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.id = id
    input.style.display = 'none'
    document.body.appendChild(input)

    // A folder card carries no id in the DOM; React knows which folder each one
    // shows. The card sits under a few context-menu wrappers, hence the depth.
    ;(window as any).__e2eFolderCard = (folderId: string): Element | null => {
      for (const el of Array.from(document.querySelectorAll('[draggable="true"]'))) {
        const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'))
        let fiber = key ? (el as any)[key] : null
        for (let depth = 0; fiber && depth < 40; depth += 1, fiber = fiber.return) {
          if (fiber.memoizedProps?.folder?.id === folderId) return el
        }
      }
      return null
    }
  }, inputId)

  try {
    if (typeof target === 'object') {
      // The grid fills in after the page loads, so the card may not be there yet.
      await page.waitForFunction((id) => !!(window as any).__e2eFolderCard(id), target.folderId)
    }
    await page.locator(`#${inputId}`).setInputFiles(paths)
    await page.evaluate(
      ({ id, region, folderId }) => {
        const input = document.getElementById(id) as HTMLInputElement
        const transfer = new DataTransfer()
        for (const file of Array.from(input.files ?? [])) transfer.items.add(file)

        let element: Element | null = null
        if (folderId) {
          element = (window as any).__e2eFolderCard(folderId)
          if (!element) throw new Error(`No folder card for ${folderId} on screen`)
        } else {
          const regions = document.querySelectorAll(region)
          if (regions.length !== 1) {
            throw new Error(`Expected one drop region (${region}), found ${regions.length}`)
          }
          element = regions[0]
        }

        const box = element.getBoundingClientRect()
        const at = { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 }
        for (const type of ['dragenter', 'dragover', 'drop']) {
          const init = { bubbles: true, cancelable: true, composed: true, dataTransfer: transfer, ...at }
          let event: Event = new DragEvent(type, init)
          // Engines that ignore `dataTransfer` in the constructor.
          if ((event as DragEvent).dataTransfer !== transfer) {
            event = new MouseEvent(type, init)
            Object.defineProperty(event, 'dataTransfer', { value: transfer })
          }
          element.dispatchEvent(event)
        }
      },
      { id: inputId, region: PROJECT_DROP_REGION, folderId: typeof target === 'object' ? target.folderId : null },
    )
  } finally {
    await page.evaluate((id) => {
      document.getElementById(id)?.remove()
      delete (window as any).__e2eFolderCard
    }, inputId)
  }
}
