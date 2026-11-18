import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { crc32 } from 'node:zlib'
import { accessToken, json, primary, savedRefreshToken, secondary } from '../fixtures/accounts'
import { countRequests, failInitiate, failParts, hangParts, holdParts, networkSwitch, partBodyBytes, stallParts, throttleParts, trackUploads } from '../fixtures/faults'
import { makeFiles, remove, rewrite, touch } from '../fixtures/files'
import { apiUrl, createProject, dropFiles, openUploads, resetUploads, rows, signIn, storageContainer } from '../fixtures/stack'

/**
 * What the fixtures promise, one observable effect per test. Later scenarios
 * stand on these, so a fixture that quietly stops doing its job (a throttle
 * that does not slow, a fault that does not reach the page) has to fail here
 * rather than make a scenario pass for the wrong reason.
 */

const MB = 1024 * 1024
const PART = /[?&]partNumber=\d+/

/** A fresh project, open in `page`, signed in as primary. Returns the project's id and the account. */
async function openProject(page: Page) {
  const account = await primary()
  await signIn(page, account)
  const project = await createProject(account, `E2E fixtures ${Date.now()}`)
  await page.goto(`/projects/${project.id}`)
  await expect(page.getByText('No assets')).toBeVisible()
  return { account, projectId: project.id }
}

/**
 * A PNG (so the row finishes as "Ready" and holds no event stream open) with a
 * name no earlier run used.
 */
async function pngFile(testInfo: TestInfo, tag: string, bytes = 3 * MB) {
  const name = `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const [file] = await makeFiles(testInfo.outputPath('files'), [{ name: `${name}.png`, bytes }])
  return { name, file }
}

const rowOf = (page: Page, name: string) => async () => (await rows(page)).find((r) => r.name === name)
const statusOf = (page: Page, name: string) => async () => (await rowOf(page, name)())?.status

/** The status of every response to a part PUT the page has received, in order. */
function partStatuses(page: Page): number[] {
  const seen: number[] = []
  page.on('response', (r) => {
    if (r.request().method() === 'PUT' && PART.test(r.url())) seen.push(r.status())
  })
  return seen
}

// ─── Accounts and sessions ─────────────────────────────────────────────────────

test('primary() and secondary() are two different, working accounts', async () => {
  const [p, s] = [await primary(), await secondary()]
  expect(p.email).not.toBe(s.email)
  expect(p.id).not.toBe(s.id)

  const meP = await json<{ id: string; email: string; is_superadmin: boolean }>('GET', '/auth/me', { token: await accessToken(p) })
  expect(meP).toMatchObject({ id: p.id, email: p.email, is_superadmin: true })
  const meS = await json<{ id: string; email: string; is_superadmin: boolean }>('GET', '/auth/me', { token: await accessToken(s) })
  expect(meS).toMatchObject({ id: s.id, email: s.email, is_superadmin: false })
})

test('signIn() leaves the page holding the account\'s saved session', async ({ page }) => {
  const account = await secondary()
  await signIn(page, account)
  const stored = await page.evaluate(() => ({
    refresh: window.localStorage.getItem('ff_refresh_token'),
    access: window.localStorage.getItem('ff_access_token'),
  }))
  expect(stored.refresh).toBe(savedRefreshToken(account))
  expect(stored.access).toBeTruthy()

  // Signed in means the app does not bounce /projects to the login form.
  await page.goto('/projects')
  await expect(page).toHaveURL(/\/projects$/)
  await expect(page.getByPlaceholder('you@example.com')).toHaveCount(0)
})

test('resetUploads() clears the upload list and the tab id', async ({ page }) => {
  await page.goto('/login')
  await page.evaluate(() => {
    window.localStorage.setItem('ff-uploads', '{"state":{"files":[]},"version":0}')
    window.sessionStorage.setItem('ff-upload-tab', 'a-tab')
  })
  await resetUploads(page)
  const left = await page.evaluate(() => [window.localStorage.getItem('ff-uploads'), window.sessionStorage.getItem('ff-upload-tab')])
  expect(left).toEqual([null, null])
})

// ─── Files ─────────────────────────────────────────────────────────────────────

test('storageContainer() names the ffe2e MinIO and refuses any other container', async () => {
  // Only reads: a name check, and `docker inspect` of the container's labels. Nothing is stopped.
  const before = process.env.E2E_MINIO_CONTAINER
  const named = (name: string | undefined) => {
    if (name === undefined) delete process.env.E2E_MINIO_CONTAINER
    else process.env.E2E_MINIO_CONTAINER = name
    return () => storageContainer()
  }
  try {
    expect(named(undefined)()).toBe('ffe2e-minio-1')
    // Another stack's: refused by name, before docker is asked anything.
    expect(named('otherstack-minio-1')).toThrow(/only on the ffe2e stack's MinIO/)
    // The ffe2e stack's database: refused by its compose service.
    expect(named('ffe2e-postgres-1')).toThrow(/compose service "postgres".*not the ffe2e stack's minio/)
    // A name that is no container at all.
    expect(named('ffe2e-nosuch-1')).toThrow(/cannot inspect it/)
  } finally {
    if (before === undefined) delete process.env.E2E_MINIO_CONTAINER
    else process.env.E2E_MINIO_CONTAINER = before
  }
})

const sha = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

test('makeFiles() writes files of exactly the size asked, with different random content', async ({}, testInfo) => {
  const dir = testInfo.outputPath('files')
  const [a, b, c] = await makeFiles(dir, [
    { name: 'a.bin', bytes: 1 * MB },
    { name: 'b.bin', bytes: 1 * MB },
    { name: 'c.mp4', bytes: 5 * MB + 17 },
  ])
  expect(path.dirname(a)).toBe(dir)
  expect([a, b, c].map((f) => fs.statSync(f).size)).toEqual([1 * MB, 1 * MB, 5 * MB + 17])
  expect(sha(a)).not.toBe(sha(b))
  // Not zeros: a run of zero bytes would compress away somewhere on the path.
  expect(fs.readFileSync(a).subarray(0, 4096).some((byte) => byte !== 0)).toBe(true)
})

test('makeFiles() makes a .png a valid PNG of exactly the size asked', async ({}, testInfo) => {
  const [file] = await makeFiles(testInfo.outputPath('files'), [{ name: 'p.png', bytes: 3 * MB }])
  const data = fs.readFileSync(file)
  expect(data.length).toBe(3 * MB)
  expect(data.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))

  // Walk the chunks: lengths line up with the file, every CRC checks, IHDR first and IEND last.
  const types: string[] = []
  let at = 8
  while (at < data.length) {
    const length = data.readUInt32BE(at)
    const type = data.toString('ascii', at + 4, at + 8)
    const crc = data.readUInt32BE(at + 8 + length)
    expect(crc32(data.subarray(at + 4, at + 8 + length)), `CRC of ${type}`).toBe(crc)
    types.push(type)
    at += 12 + length
  }
  expect(at).toBe(data.length)
  expect(types[0]).toBe('IHDR')
  expect(types[types.length - 1]).toBe('IEND')
})

test('touch() moves the modification time and leaves the bytes', async ({}, testInfo) => {
  const [file] = await makeFiles(testInfo.outputPath('files'), [{ name: 't.bin', bytes: 1000 }])
  const old = new Date(Date.now() - 3_600_000)
  fs.utimesSync(file, old, old)
  const before = sha(file)
  await touch(file)
  expect(fs.statSync(file).mtimeMs).toBeGreaterThan(old.getTime() + 3_000_000)
  expect(sha(file)).toBe(before)
})

test('rewrite() replaces the content of the same file with a new size', async ({}, testInfo) => {
  const [file] = await makeFiles(testInfo.outputPath('files'), [{ name: 'r.bin', bytes: 2000 }])
  const before = { sha: sha(file), ino: fs.statSync(file).ino }
  await rewrite(file, 5000)
  expect(fs.statSync(file).size).toBe(5000)
  expect(sha(file)).not.toBe(before.sha)
  expect(fs.statSync(file).ino, 'rewritten in place, not replaced').toBe(before.ino)
})

test('remove() deletes a file, and is fine with one that is already gone', async ({}, testInfo) => {
  const [file] = await makeFiles(testInfo.outputPath('files'), [{ name: 'x.bin', bytes: 10 }])
  await remove(file)
  expect(fs.existsSync(file)).toBe(false)
  await expect(remove(file)).resolves.toBeUndefined()
})

// ─── The uploads panel ─────────────────────────────────────────────────────────

test('rows() reads data-status and data-detail, and throws for a row that has no status', async ({ page }, testInfo) => {
  await openProject(page)
  const hold = await holdParts(page)
  const { name, file } = await pngFile(testInfo, 'rows')
  await dropFiles(page, 'project', [file])
  await openUploads(page)
  await expect.poll(hold.held, { timeout: 30_000 }).toBeGreaterThan(0)

  const mine = (await rows(page)).filter((r) => r.name === name)
  expect(mine).toHaveLength(1)
  expect(mine[0]).toMatchObject({ status: 'uploading', kind: 'uploading' })
  expect(mine[0].detail).toMatch(/^Uploading \d+%/)
  hold.release()

  // A row the panel renders without its status hook must not read as "" and let
  // a "no row is Starting" wait pass.
  await page.evaluate(() => {
    const panel = Array.from(document.querySelectorAll('h2'))
      .find((h) => h.textContent?.startsWith('Uploads'))
      ?.closest('div.fixed')
    const row = document.createElement('div')
    row.setAttribute('data-testid', 'upload-row')
    panel?.appendChild(row)
  })
  await expect(rows(page)).rejects.toThrow(/no data-status/)
})

// ─── Dropping files ────────────────────────────────────────────────────────────

test('dropFiles() uploads into the project root or into a folder, as the target says', async ({ page }, testInfo) => {
  const { account, projectId } = await openProject(page)
  const token = await accessToken(account)
  const folder = await json<{ id: string }>('POST', `/projects/${projectId}/folders`, { token, body: { name: 'target' } })
  await page.reload()
  await expect(page.getByText('target', { exact: true }).first()).toBeVisible()

  const inFolder = await pngFile(testInfo, 'in-folder')
  const atRoot = await pngFile(testInfo, 'at-root')
  await dropFiles(page, { folderId: folder.id }, [inFolder.file])
  await dropFiles(page, 'project', [atRoot.file])

  await openUploads(page)
  await expect.poll(statusOf(page, inFolder.name), { timeout: 60_000 }).toBe('complete')
  await expect.poll(statusOf(page, atRoot.name), { timeout: 60_000 }).toBe('complete')

  const names = async (where: string) =>
    (await json<Array<{ name: string }>>('GET', `/projects/${projectId}/assets?folder_id=${where}`, { token })).map((a) => a.name)
  expect(await names(folder.id)).toEqual([inFolder.name])
  expect(await names('root')).toEqual([atRoot.name])
})

test('dropFiles() with several files starts one upload for each', async ({ page }, testInfo) => {
  await openProject(page)
  const files = [await pngFile(testInfo, 'multi-a', 200_000), await pngFile(testInfo, 'multi-b', 300_000)]
  await dropFiles(page, 'project', files.map((f) => f.file))
  await openUploads(page)
  for (const f of files) await expect.poll(statusOf(page, f.name), { timeout: 60_000 }).toBe('complete')
})

// ─── Faults ────────────────────────────────────────────────────────────────────

test('countRequests() counts the requests that match, and only those', async ({ page }, testInfo) => {
  await openProject(page)
  const initiates = countRequests(page, /\/upload\/initiate$/)
  const parts = countRequests(page, PART)
  const never = countRequests(page, /\/this-is-never-requested/)
  expect([initiates.count(), parts.count()]).toEqual([0, 0])

  const { name, file } = await pngFile(testInfo, 'count')
  await dropFiles(page, 'project', [file])
  await openUploads(page)
  await expect.poll(statusOf(page, name), { timeout: 60_000 }).toBe('complete')

  expect(initiates.count()).toBe(1)
  expect(parts.count()).toBe(1) // one 3 MB part
  expect(never.count()).toBe(0)
})

test('failParts(page, status, times) answers that many part PUTs with the status, then lets them through', async ({ page }, testInfo) => {
  await openProject(page)
  const statuses = partStatuses(page)
  await failParts(page, 500, 1)

  const { name, file } = await pngFile(testInfo, 'failparts')
  await dropFiles(page, 'project', [file])
  await openUploads(page)
  await expect.poll(statusOf(page, name), { timeout: 60_000 }).toBe('complete')

  // The page saw the injected 500 (not a network error), then the app's retry got through.
  expect(statuses).toEqual([500, 200])
})

test('failParts(page, status) with no count fails every part PUT', async ({ page }, testInfo) => {
  await openProject(page)
  const statuses = partStatuses(page)
  await failParts(page, 403) // a refusal the app does not retry

  const { name, file } = await pngFile(testInfo, 'failall')
  await dropFiles(page, 'project', [file])
  await openUploads(page)
  await expect.poll(async () => (await rowOf(page, name)())?.status, { timeout: 60_000 }).toMatch(/^(failed|interrupted)$/)

  expect(statuses.length).toBeGreaterThan(0)
  expect(new Set(statuses)).toEqual(new Set([403]))
})

test('hangParts() leaves a part PUT unanswered and the row uploading', async ({ page }, testInfo) => {
  await openProject(page)
  const statuses = partStatuses(page)
  const parts = countRequests(page, PART)
  await hangParts(page)

  const { name, file } = await pngFile(testInfo, 'hang')
  await dropFiles(page, 'project', [file])
  await openUploads(page)
  await expect.poll(() => parts.count(), { timeout: 30_000 }).toBeGreaterThan(0)

  await page.waitForTimeout(4_000)
  expect(statuses, 'no part PUT was ever answered').toEqual([])
  expect((await rowOf(page, name)())?.status).toBe('uploading')
})

test('hangParts() with only and times hangs just those PUTs, and lets the rest through', async ({ page }, testInfo) => {
  await openProject(page)
  const statuses = partStatuses(page)
  const uploads = trackUploads(page)
  const hung = await pngFile(testInfo, 'hangonly-a')
  const free = await pngFile(testInfo, 'hangonly-b')
  // The first PUT of the first file only: the second file's PUT passes, and so would a retry of the first.
  await hangParts(page, { only: uploads.partsOf(`${hung.name}.png`), times: 1 })

  await dropFiles(page, 'project', [hung.file, free.file])
  await openUploads(page)
  await expect.poll(statusOf(page, free.name), { timeout: 60_000 }).toBe('complete')
  await page.waitForTimeout(3_000)
  expect(statuses, 'only the other file\'s PUT was answered').toEqual([200])
  expect((await rowOf(page, hung.name)())?.status).toBe('uploading')
  // trackUploads knows the key of each file's upload.
  expect((await uploads.of(`${hung.name}.png`)).s3Key).toMatch(/^raw\/[0-9a-f-]+\/[0-9a-f-]+\/[0-9a-f-]+\/original\.png$/)
})

test('stallParts() lets a part start, so the browser reports progress, and then answers nothing', async ({ page }, testInfo) => {
  await openProject(page)
  // What the browser reports as sent for each PUT, as the page's own XHR sees it.
  await page.addInitScript(() => {
    const w = window as any
    w.__e2eProgress = {} as Record<string, { loaded: number; total: number }>
    const send = XMLHttpRequest.prototype.send
    XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: any) {
      const total = body && typeof body.size === 'number' ? body.size : 0
      const id = (w.__e2eProgressCount = (w.__e2eProgressCount ?? 0) + 1)
      this.upload.addEventListener('progress', (e) => {
        w.__e2eProgress[id] = { loaded: e.loaded, total }
      })
      return send.call(this, body)
    }
  })
  await page.reload()
  await expect(page.getByText('No assets')).toBeVisible()
  const statuses = partStatuses(page)
  const stall = await stallParts(page, { times: 1 })

  // 20 MB: two parts of 10 MB, more than the sockets hold, so the stalled one is partly sent.
  const { name, file } = await pngFile(testInfo, 'stall', 20 * MB)
  await dropFiles(page, 'project', [file])
  await openUploads(page)
  await expect.poll(() => stall.stalled(), { timeout: 60_000 }).toBe(1)
  await page.waitForTimeout(5_000)

  expect(stall.partNumbers()).toHaveLength(1)
  expect(stall.bytesRead()).toBeGreaterThan(0)
  // The other part went to the bucket and was answered; the stalled one never was.
  expect(statuses).toEqual([200])
  expect((await rowOf(page, name)())?.status).toBe('uploading')
  const progress = Object.values(await page.evaluate(() => (window as any).__e2eProgress as Record<string, { loaded: number; total: number }>))
  const partial = progress.filter((p) => p.total > 0 && p.loaded > 0 && p.loaded < p.total)
  expect(partial.length, `progress events: ${JSON.stringify(progress)}`).toBeGreaterThan(0)
  stall.stop()
})

test('networkSwitch() fails the API and the bucket while down, leaves files readable, and restores both', async ({ context, page, browserName }, testInfo) => {
  const network = networkSwitch(context, browserName)
  await signIn(page, await primary())
  const [file] = await makeFiles(testInfo.outputPath('files'), [{ name: 'net.bin', bytes: 1 * MB }])
  await page.evaluate(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.id = 'e2e-net-input'
    document.body.appendChild(input)
  })
  await page.locator('#e2e-net-input').setInputFiles(file)
  const probe = () =>
    page.evaluate(async (url) => {
      const picked = (document.getElementById('e2e-net-input') as HTMLInputElement).files![0]
      const api = await fetch(url).then((r) => r.status, (e) => `${e.name}`)
      const read = await picked.slice(0, 1).arrayBuffer().then((b) => b.byteLength, (e) => `${e.name}`)
      return { api, read }
    }, `${apiUrl()}/health`)

  expect(await probe()).toEqual({ api: 200, read: 1 })
  await network.down()
  expect(await probe()).toEqual({ api: 'TypeError', read: 1 })
  await network.up()
  expect(await probe()).toEqual({ api: 200, read: 1 })
})

test('holdParts() holds every part PUT until released, then lets them all through', async ({ page }, testInfo) => {
  await openProject(page)
  const statuses = partStatuses(page)
  const hold = await holdParts(page)

  const { name, file } = await pngFile(testInfo, 'holdparts')
  await dropFiles(page, 'project', [file])
  await openUploads(page)
  await expect.poll(hold.held, { timeout: 30_000 }).toBeGreaterThan(0)
  await page.waitForTimeout(3_000)
  expect(statuses, 'no held part PUT was answered').toEqual([])
  expect((await rowOf(page, name)())?.status).toBe('uploading')

  hold.release()
  await expect.poll(statusOf(page, name), { timeout: 60_000 }).toBe('complete')
  expect(statuses).toEqual([200])
})

test('failInitiate() answers the initiate call with the reply, for as many calls as asked', async ({ page }, testInfo) => {
  await openProject(page)
  // A refusal (400): the row fails with the reason and the queue moves on. A 5xx
  // would not fail the row, the queue holds and retries it (see queue.spec.ts, S1).
  await failInitiate(page, { status: 400, body: { detail: 'not today' }, headers: { 'retry-after': '7' } }, 1)

  const first = await pngFile(testInfo, 'init-first')
  const second = await pngFile(testInfo, 'init-second')
  await dropFiles(page, 'project', [first.file])
  await openUploads(page)
  await expect.poll(rowOf(page, first.name), { timeout: 30_000 }).toMatchObject({ status: 'failed', detail: 'not today' })

  // The second call is past `times`, so it reaches the API.
  await dropFiles(page, 'project', [second.file])
  await expect.poll(statusOf(page, second.name), { timeout: 60_000 }).toBe('complete')
})

test('failInitiate() delivers status, body and headers to the page intact', async ({ page }) => {
  await page.goto('/login') // any page on the app's origin: the call below is cross-origin to the API
  await failInitiate(page, { status: 429, body: { detail: 'slow down' }, headers: { 'retry-after': '7' } })
  const seen = await page.evaluate(async (url) => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    return { status: res.status, retryAfter: res.headers.get('retry-after'), body: await res.json() }
  }, `${apiUrl()}/upload/initiate`)
  // Unintercepted, this unauthenticated call would be a 401.
  expect(seen).toEqual({ status: 429, retryAfter: '7', body: { detail: 'slow down' } })
})

test('throttleParts() holds a part PUT for its size over the rate', async ({ page }, testInfo) => {
  await openProject(page)
  await throttleParts(page, 1 * MB) // a 3 MB part at 1 MB/s: three seconds

  let startedAt = 0
  let tookMs = 0
  page.on('request', (r) => {
    if (r.method() === 'PUT' && PART.test(r.url())) startedAt = Date.now()
  })
  page.on('response', (r) => {
    if (r.request().method() === 'PUT' && PART.test(r.url())) tookMs = Date.now() - startedAt
  })

  const { name, file } = await pngFile(testInfo, 'throttle')
  await dropFiles(page, 'project', [file])
  await openUploads(page)
  await expect.poll(statusOf(page, name), { timeout: 60_000 }).toBe('complete')

  expect(tookMs).toBeGreaterThan(2_500)
  expect(tookMs).toBeLessThan(15_000)
})

// A part whose size nobody can read must stop the scenario, not slip through
// undelayed (which would make every throttled scenario pass vacuously). The
// probe request is a PUT with no body, sent with fetch, so neither Playwright,
// nor a content-length header, nor the XHR size probe can say how big it is.
const UNSIZABLE = `${apiUrl()}/not-a-real-part?partNumber=1&uploadId=none`

test('partBodyBytes() refuses a part whose size it cannot determine', async ({ page }) => {
  await page.goto('/login')
  const sent = page.waitForRequest((r) => r.url().includes('/not-a-real-part'))
  await page.evaluate((url) => void fetch(url, { method: 'PUT' }).catch(() => {}), UNSIZABLE)
  await expect(partBodyBytes(page, await sent)).rejects.toThrow(/cannot determine the size/)
})

test('throttleParts() fails the test on a part it cannot size, instead of passing it through', async ({ page }) => {
  // The route handler throws, and Playwright ends the test with that error. If
  // the part were passed through instead, nothing would throw and this test
  // would pass, which `fail` turns into a failure.
  test.fail(true, 'an unsizable part must fail the test that throttles it')
  await page.goto('/login')
  await throttleParts(page, 1 * MB)
  await page.evaluate((url) => void fetch(url, { method: 'PUT' }).catch(() => {}), UNSIZABLE)
  await page.waitForTimeout(3_000)
})
