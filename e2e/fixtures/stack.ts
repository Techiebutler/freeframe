import { expect, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
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
  await submitLoginForm(page, account)
}

/**
 * Fill in and send the login form the page is already showing, as `account`,
 * ending on `/projects`. For a login page reached some other way than
 * `signInThroughForm` loading it: one the app redirected to, say, that a
 * person goes on to use even after another tab has signed in (the login page
 * looks for a token only when it loads). One `POST /auth/login`.
 */
export async function submitLoginForm(page: Page, account: Account): Promise<void> {
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
 * Close the uploads panel, the way a person does: a click on the page beside it.
 *
 * While the panel is open a full-screen backdrop sits over the page (and the
 * sidebar), so a link behind it cannot be clicked. The click lands on the
 * backdrop's far right edge, well clear of the 380px panel.
 */
export async function closeUploads(page: Page): Promise<void> {
  const panel = uploadsPanel(page)
  if (!(await panel.isVisible())) return
  const width = page.viewportSize()?.width ?? 1280
  await page.mouse.click(width - 20, 300)
  await panel.waitFor({ state: 'hidden' })
}

/** One row of the uploads panel, as `rows` reads it. */
export type UploadRow = {
  name: string
  /**
   * The row's `data-status`: queued, starting, uploading, processing, complete,
   * failed, cancelled, interrupted or elsewhere. Not the badge's wording
   * ("Ready" is `complete`, "Resuming" is `starting`).
   */
  status: string
  /** The line under the progress bar, as written ("Waiting to start", an error message, ...). */
  detail: string
  /** The row's `data-detail`: which kind of line that is ("waiting-to-start", "resuming", "failed", ...), or '' for none. */
  kind: string
}

/**
 * Every row of the uploads panel, top to bottom, as the panel shows it.
 *
 * Rows are found by `data-testid="upload-row"`, and `status` and `kind` are read from the
 * row's `data-status` and `data-detail`, so the badge's wording does not matter. `name` and
 * `detail` still come from the markup (the row's name element and its first `div.mt-1`), so a
 * change to those classes breaks them, here and only here. A row without a status throws: a read that quietly returned "" would let a
 * scenario that waits for "no row is Starting" pass without looking at anything.
 * Open the panel first with `openUploads`.
 */
export async function rows(page: Page): Promise<UploadRow[]> {
  return uploadsPanel(page).evaluate((panel) =>
    Array.from(panel.querySelectorAll('[data-testid="upload-row"]')).map((row) => {
      const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
      const editing = row.querySelector<HTMLInputElement>('input[aria-label="Asset name"]')
      const name = editing ? editing.value : text(row.querySelector('p.font-medium, button[title="Rename"]'))
      const status = row.getAttribute('data-status')
      if (!status) throw new Error(`The uploads panel has a row ("${name}") with no data-status`)
      return {
        name,
        status,
        detail: text(row.querySelector('div.mt-1')),
        kind: row.getAttribute('data-detail') ?? '',
      }
    }),
  )
}

/**
 * The panel row of the upload named `name` (the asset name, which is the file's
 * name without its extension). For clicking its actions: Cancel is the button
 * titled "Cancel upload", Retry "Retry", Dismiss "Dismiss", Resume
 * "Resume — pick <file> again". They fade in on hover, so hover the row first.
 */
export function uploadRow(page: Page, name: string): Locator {
  const exact = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
  return uploadsPanel(page)
    .getByTestId('upload-row')
    .filter({ has: page.locator('button[title="Rename"]', { hasText: exact }) })
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
    } else {
      // The server renders the drop region before React has hydrated it, and a drop
      // that lands in that gap goes nowhere (seen in WebKit): React finds no handler
      // on a node it has not hydrated. Hydrating gives the node its props.
      await page.waitForFunction((region) => {
        const found = document.querySelectorAll(region)
        return found.length === 1 && Object.keys(found[0]).some((k) => k.startsWith('__reactProps$'))
      }, PROJECT_DROP_REGION)
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

// ─── Storage (infra scenarios) ─────────────────────────────────────────────────

/**
 * The e2e stack's MinIO container: `E2E_MINIO_CONTAINER`, default
 * `ffe2e-minio-1` (the `-p ffe2e` stack in section 1 of the README).
 *
 * These helpers stop, start, pause and unplug a real container, so they act on
 * that one container only, and refuse any name outside the `ffe2e-` stack: a
 * typo must not reach another stack's storage. Nothing here removes a
 * container, a volume or a network.
 */
export function storageContainer(): string {
  const name = process.env.E2E_MINIO_CONTAINER ?? 'ffe2e-minio-1'
  if (!/^ffe2e-[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
    throw new Error(`Refusing to touch container "${name}": the infra helpers act only on the ffe2e stack's MinIO (a name starting "ffe2e-").`)
  }
  return name
}

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

type Inspected = {
  State: { Status: string; Running: boolean; Paused: boolean }
  Config: { Labels: Record<string, string> | null }
  HostConfig: { PortBindings: Record<string, Array<{ HostIp: string; HostPort: string }> | null> | null }
  NetworkSettings: { Networks: Record<string, { Aliases: string[] | null; DNSNames?: string[] | null }> | null }
}

function inspectStorage(): Inspected {
  const [found] = JSON.parse(docker('inspect', storageContainer())) as Inspected[]
  return found
}

/**
 * Where the container belongs: its compose network (`<project>_default`) and
 * the names it answers to there (the compose service, which is the host name
 * the API's S3 endpoint uses, and the container name). Read from the
 * container's compose labels, which survive a disconnect, so a run killed
 * mid-scenario can still be put back by the next one.
 */
function storageHome(c: Inspected): { network: string; aliases: string[] } {
  const labels = c.Config.Labels ?? {}
  const project = labels['com.docker.compose.project']
  const service = labels['com.docker.compose.service']
  if (!project || !service) throw new Error(`${storageContainer()} has no compose project/service labels; cannot tell its network`)
  const network = `${project}_default`
  if (!network.startsWith('ffe2e_')) throw new Error(`Refusing to touch network "${network}": not the ffe2e stack's`)
  return { network, aliases: [service, storageContainer()] }
}

/** MinIO's liveness URL as the browser reaches it: the host port bound to the container's 9000. */
function storageHealthUrl(c: Inspected): string {
  const port = c.HostConfig.PortBindings?.['9000/tcp']?.[0]?.HostPort
  if (!port) throw new Error(`${storageContainer()} publishes no host port for 9000/tcp`)
  return `http://localhost:${port}/minio/health/live`
}

/**
 * Wait until storage is back for both of its users: MinIO answers its liveness
 * check on the host port (the browser's way in), and the container is on its
 * compose network under the service name (the API's way in). Throws after
 * `timeoutMs`, so a test that cannot put storage back says so.
 */
export async function waitForStorage(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  for (;;) {
    const c = inspectStorage()
    const { network, aliases } = storageHome(c)
    const names = c.NetworkSettings.Networks?.[network]?.DNSNames ?? c.NetworkSettings.Networks?.[network]?.Aliases ?? []
    if (!c.State.Running || c.State.Paused) last = `container ${c.State.Status}${c.State.Paused ? ' (paused)' : ''}`
    else if (!aliases.every((a) => names.includes(a))) last = `not on ${network} as ${aliases.join(', ')} (names: ${names.join(', ') || 'none'})`
    else {
      const status = await fetch(storageHealthUrl(c), { signal: AbortSignal.timeout(2_000) }).then((r) => r.status, (e) => String(e))
      if (status === 200) return
      last = `liveness check answered ${status}`
    }
    if (Date.now() > deadline) throw new Error(`Storage (${storageContainer()}) not healthy after ${timeoutMs} ms: ${last}`)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

/** `docker stop` the e2e MinIO: the browser's connections to it are refused, and the API cannot resolve it. */
export function stopStorage(): void {
  docker('stop', storageContainer())
}

/** `docker start` the e2e MinIO, and wait until it is healthy. */
export async function startStorage(): Promise<void> {
  docker('start', storageContainer())
  await waitForStorage()
}

/**
 * Make storage a black hole: reachable in name, answering nothing.
 *
 * - `'disconnect'` (default, the mechanism SCENARIOS.md S4 names): `docker
 *   network disconnect` from its compose network. Measured on Docker Desktop
 *   for Mac (2026-10-23): the browser's connection to the host port is still
 *   accepted and the request then hangs (no answer in 15 s). The API cannot
 *   resolve the service name, so a cold initiate fails at once with the coded
 *   503 `storage_unavailable` (0.09 s); one sent on a connection its S3 client
 *   already had open gets no answer and fails at its 10 s read timeout instead.
 * - `'pause'`: `docker pause`. Every request hangs, the browser's and the
 *   API's alike: the API's initiate waits out its 10 s read timeout and then
 *   answers the same coded 503 (10.04 s, measured). The stricter test of a
 *   time bound.
 *
 * (`stopStorage` is the third: refused at once on both sides.) Always undo it
 * with `restoreStorage`, from an `afterEach` or a `finally`.
 */
export function blackholeStorage(how: 'disconnect' | 'pause' = 'disconnect'): void {
  if (how === 'pause') {
    docker('pause', storageContainer())
    return
  }
  const { network } = storageHome(inspectStorage())
  docker('network', 'disconnect', network, storageContainer())
}

/**
 * Put storage back however it was taken away (stopped, paused, unplugged, or
 * any of these together), and wait until it is healthy. Safe to call when
 * nothing is wrong: it then only checks. Reconnecting gives the container back
 * its service alias, which a plain `docker network connect` would not, and
 * without which the API cannot find it.
 */
export async function restoreStorage(): Promise<void> {
  let c = inspectStorage()
  if (c.State.Paused) docker('unpause', storageContainer())
  else if (!c.State.Running) docker('start', storageContainer())
  c = inspectStorage()
  const { network, aliases } = storageHome(c)
  if (!c.NetworkSettings.Networks?.[network]) {
    docker('network', 'connect', ...aliases.flatMap((a) => ['--alias', a]), network, storageContainer())
  }
  await waitForStorage()
}
