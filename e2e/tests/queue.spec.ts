import { expect, test, type BrowserContext, type Page, type Request, type TestInfo } from '@playwright/test'
import fs from 'node:fs'
import { accessToken, json, primary } from '../fixtures/accounts'
import { countRequests, failInitiate, failParts, hangParts, holdParts, throttleParts } from '../fixtures/faults'
import { makeFiles } from '../fixtures/files'
import { closeUploads, createProject, dropFiles, openUploads, rows, signIn, uploadRow, type UploadRow } from '../fixtures/stack'

/**
 * The upload queue, in real browsers: drops wait in a queue and start in order,
 * three at a time; Cancel and Cancel all queued; a refused or held initiate; a
 * Resume that goes next; a New Version behind a long queue; a storage cap; a
 * project deleted under queued files. One test per row of SCENARIOS.md, named
 * with its ID.
 *
 * Most of them freeze the queue with `holdParts` (the files that started sit in
 * Uploading with their parts on hold, the rest wait), look at it, act, then
 * release it. Files are PNGs, so a finished upload reads "complete" at once
 * and holds no event stream open (see the README's Traps).
 */

const MB = 1024 * 1024
const MAX_ACTIVE_FILES = 3
/** The tab-wide part budget of the stack under test: NEXT_PUBLIC_UPLOAD_CONCURRENCY, default 5. */
const BUDGET = Number(process.env.E2E_UPLOAD_CONCURRENCY ?? 5)
/** A file this small or smaller is certainly one part (MIN_PART_SIZE_BYTES), and counts as one while initiating. */
const SINGLE_PART_BYTES = 5 * MB

// ─── Files and projects ────────────────────────────────────────────────────────

// The files are hundreds of MB between them; Playwright keeps a test's output, so remove them.
test.afterEach(({}, testInfo) => {
  fs.rmSync(testInfo.outputPath('files'), { recursive: true, force: true })
})

type Dropped = {
  /** The asset name: the file's name without its extension, which is what the panel shows. */
  name: string
  file: string
  bytes: number
}

/**
 * PNG files, named `<tag>-<stamp>-<nn>` with a stamp no earlier run used (the
 * panel lists earlier uploads too, so a scenario finds its rows by name).
 */
async function pngs(testInfo: TestInfo, tag: string, sizes: number[]): Promise<Dropped[]> {
  const stamp = Date.now().toString(36)
  const specs = sizes.map((bytes, i) => ({ name: `${tag}-${stamp}-${String(i + 1).padStart(2, '0')}.png`, bytes }))
  const paths = await makeFiles(testInfo.outputPath('files'), specs)
  return specs.map((spec, i) => ({ name: spec.name.replace(/\.png$/, ''), file: paths[i], bytes: spec.bytes }))
}

/** A fresh project, open in `page`, signed in as primary. */
async function openProject(page: Page, label: string) {
  const account = await primary()
  await signIn(page, account)
  const project = await createProject(account, `E2E ${label} ${Date.now()}`)
  await page.goto(`/projects/${project.id}`)
  await expect(page.getByText('No assets')).toBeVisible()
  return { account, project }
}

/** Names of the assets in a project's root, through the API. */
async function assetNames(projectId: string): Promise<string[]> {
  const token = await accessToken(await primary())
  const assets = await json<Array<{ name: string }>>('GET', `/projects/${projectId}/assets?folder_id=root`, { token })
  return assets.map((a) => a.name)
}

// ─── What the page sent ────────────────────────────────────────────────────────

const INITIATE = /\/(upload\/initiate|assets\/[^/]+\/versions)(\?|$)/
const PART = /[?&]partNumber=\d+/
const PARTS_LIST = /\/upload\/[0-9a-f-]{36}\/parts(\?|$)/

type InitiateCall = {
  /** `asset_name` as sent: what the asset is created with. */
  name: string
  file: string
  bytes: number
  at: number
  /** The answer's status, and when it came; null while unanswered (or when the page gave up). */
  status: number | null
  doneAt: number | null
  uploadId: string | null
  chunk: number | null
}
type PartCall = { uploadId: string; partNumber: number; at: number; status: number | null; doneAt: number | null }
type Timed = { uploadId: string; at: number; status: number | null; doneAt: number | null }

/**
 * Everything the page sends that the queue decides: initiates (with the name
 * and size in them, so a request can be tied to a file), part PUTs, completes,
 * aborts and the resume's part listing. Passive; it never touches the traffic.
 */
function recordTraffic(page: Page) {
  const initiates: InitiateCall[] = []
  const parts: PartCall[] = []
  const completes: Timed[] = []
  const aborts: Array<{ uploadId: string; at: number }> = []
  const partLists: Array<{ versionId: string; at: number }> = []
  // The call each request became, so its response can fill in the status.
  const answered = new Map<Request, { status: number | null; doneAt: number | null }>()
  const initiateOf = new Map<Request, InitiateCall>()

  const body = (request: Request): Record<string, any> => {
    try {
      return (request.postDataJSON() as Record<string, any>) ?? {}
    } catch {
      return {}
    }
  }

  page.on('request', (request) => {
    const url = request.url()
    const method = request.method()
    const at = Date.now()
    if (method === 'POST' && INITIATE.test(url)) {
      const b = body(request)
      const call: InitiateCall = {
        name: String(b.asset_name ?? ''),
        file: String(b.original_filename ?? ''),
        bytes: Number(b.file_size_bytes ?? 0),
        at,
        status: null,
        doneAt: null,
        uploadId: null,
        chunk: null,
      }
      initiates.push(call)
      answered.set(request, call)
      initiateOf.set(request, call)
    } else if (method === 'PUT' && PART.test(url)) {
      const u = new URL(url)
      const call: PartCall = {
        uploadId: u.searchParams.get('uploadId') ?? '',
        partNumber: Number(u.searchParams.get('partNumber')),
        at,
        status: null,
        doneAt: null,
      }
      parts.push(call)
      answered.set(request, call)
    } else if (method === 'POST' && /\/upload\/complete$/.test(url)) {
      const call: Timed = { uploadId: String(body(request).upload_id ?? ''), at, status: null, doneAt: null }
      completes.push(call)
      answered.set(request, call)
    } else if (method === 'POST' && /\/upload\/abort$/.test(url)) {
      aborts.push({ uploadId: String(body(request).upload_id ?? ''), at })
    } else if (method === 'GET' && PARTS_LIST.test(url)) {
      partLists.push({ versionId: url.match(/\/upload\/([0-9a-f-]{36})\/parts/)![1], at })
    }
  })

  page.on('response', async (response) => {
    const request = response.request()
    const call = answered.get(request)
    if (!call) return
    call.status = response.status()
    call.doneAt = Date.now()
    const initiate = initiateOf.get(request)
    if (initiate) {
      const answer = await response.json().catch(() => null)
      initiate.uploadId = answer?.upload_id ?? null
      initiate.chunk = answer?.chunk_size_bytes ?? null
    }
  })

  return { initiates, parts, completes, aborts, partLists }
}
type Traffic = ReturnType<typeof recordTraffic>

/** Initiate calls for the given files, in the order the page sent them. */
const initiatesOf = (traffic: Traffic, files: Array<{ name: string }>) => {
  const names = new Set(files.map((f) => f.name))
  return traffic.initiates.filter((c) => names.has(c.name))
}

// ─── What the panel shows ──────────────────────────────────────────────────────

const mineOf = (all: UploadRow[], files: Array<{ name: string }>) => {
  const names = new Set(files.map((f) => f.name))
  return all.filter((r) => names.has(r.name))
}
const summary = (list: UploadRow[]) => list.map((r) => `${r.name}:${r.status}${r.kind ? `/${r.kind}` : ''}`).join('  ')
const count = (list: UploadRow[], ...statuses: string[]) => list.filter((r) => statuses.includes(r.status)).length
const FINISHED_UPLOADING = ['processing', 'complete']

/** The exact line the panel shows for each kind of waiting row (the design's copy; `detail` is the text as written). */
const WAITING_COPY: Record<string, string> = {
  'waiting-to-start': 'Waiting to start',
  'waiting-for-connection': 'Waiting for connection',
  'waiting-for-storage': 'Waiting for storage',
  'waiting-to-resume': 'Waiting to resume',
  starting: 'Starting…',
  resuming: 'Resuming…',
}
/** Rows whose line is not the copy for their kind, as strings for a failure message. Rows of other kinds are not looked at. */
const wrongCopy = (list: UploadRow[]) =>
  list.filter((r) => r.kind in WAITING_COPY && r.detail !== WAITING_COPY[r.kind]).map((r) => `${r.name}: ${r.kind} reads "${r.detail}"`)

/**
 * Wait until `ok` holds for the rows of `files`, and return them. On a timeout
 * the error says what the panel did show, which `expect.poll` would not.
 */
async function until(
  page: Page,
  files: Array<{ name: string }>,
  what: string,
  ok: (mine: UploadRow[]) => boolean,
  timeoutMs = 60_000,
): Promise<UploadRow[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const mine = mineOf(await rows(page), files)
    if (ok(mine)) return mine
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}. Rows: ${summary(mine)}`)
    await page.waitForTimeout(250)
  }
}

/** A row's action button. The actions fade in on hover, so hover the row first. */
async function clickRowAction(page: Page, name: string, title: string): Promise<void> {
  const row = uploadRow(page, name)
  await row.hover()
  await row.locator(`button[title="${title}"]`).click()
}

/**
 * Drop `files`, open the panel and wait for the queue to settle with the first
 * three uploading (their parts on hold) and the rest queued.
 */
async function freezeQueue(page: Page, files: Dropped[]) {
  await dropFiles(page, 'project', files.map((f) => f.file))
  await openUploads(page)
  return until(
    page,
    files,
    `${MAX_ACTIVE_FILES} uploading and ${files.length - MAX_ACTIVE_FILES} queued`,
    (m) => m.length === files.length && count(m, 'uploading') === MAX_ACTIVE_FILES && count(m, 'queued') === files.length - MAX_ACTIVE_FILES,
  )
}

// ─── Q1 ────────────────────────────────────────────────────────────────────────

/** 50 files, 1 KB to 40 MB, about 290 MB in all, in a fixed order that mixes big and small. */
function q1Sizes(): number[] {
  const sizes = [
    ...Array(3).fill(40 * MB),
    ...Array(3).fill(25 * MB),
    ...Array(4).fill(12 * MB),
    ...Array(5).fill(6 * MB),
    ...Array(10).fill(Math.round(1.5 * MB)),
    ...Array(10).fill(200 * 1024),
    ...Array(10).fill(20 * 1024),
    ...Array(5).fill(1024),
  ] as number[]
  // A fixed shuffle (a small linear congruential generator), so every run drops the same order.
  let seed = 20261021
  const next = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296
  for (let i = sizes.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1))
    ;[sizes[i], sizes[j]] = [sizes[j], sizes[i]]
  }
  return sizes
}

test('Q1: 50 mixed files start in drop order, at most three at a time', async ({ page }, testInfo) => {
  test.setTimeout(30 * 60_000)
  const { project } = await openProject(page, 'Q1')
  const traffic = recordTraffic(page)
  await throttleParts(page, 2 * MB) // each part waits its size over 2 MB/s

  const files = await pngs(testInfo, 'q1', q1Sizes())
  expect(files).toHaveLength(50)
  expect(files.reduce((sum, f) => sum + f.bytes, 0)).toBeGreaterThan(250 * MB)

  await dropFiles(page, 'project', files.map((f) => f.file))
  await openUploads(page)

  // Sample the panel every 500 ms until every file has been uploaded.
  let samples = 0
  let mostMoving = 0
  const overLimit: string[] = []
  const outOfOrder: string[] = []
  let final: UploadRow[] = []
  const deadline = Date.now() + 25 * 60_000
  for (;;) {
    const mine = mineOf(await rows(page), files)
    samples += 1
    // Every row is there at every sample: a panel that lost rows would pass the checks below for nothing.
    expect(mine, `sample ${samples}: all 50 rows`).toHaveLength(50)

    // "Starting", "Resuming" and "Uploading" (finalizing included) are the rows doing something.
    const moving = count(mine, 'starting', 'uploading')
    mostMoving = Math.max(mostMoving, moving)
    if (moving > MAX_ACTIVE_FILES) overLimit.push(`sample ${samples}: ${moving} moving: ${summary(mine)}`)

    // Start order: a file that has left the queue means every file dropped before it has too.
    const byName = new Map(mine.map((r) => [r.name, r]))
    let waitingAhead: string | null = null
    for (const f of files) {
      const row = byName.get(f.name)!
      if (row.status === 'queued') waitingAhead ??= f.name
      else if (waitingAhead) outOfOrder.push(`sample ${samples}: ${f.name} (${row.status}) began before ${waitingAhead} (queued)`)
    }

    const failed = mine.filter((r) => ['failed', 'interrupted', 'cancelled'].includes(r.status))
    expect(failed.map((r) => `${r.name}:${r.status} ${r.detail}`), 'no file fails on the way').toEqual([])
    // Whatever a row says it is waiting for, it says in the design's words.
    expect(wrongCopy(mine), `sample ${samples}: waiting lines`).toEqual([])
    final = mine
    if (count(mine, ...FINISHED_UPLOADING) === 50) break
    if (Date.now() > deadline) throw new Error(`Q1 did not finish in 25 minutes. ${summary(mine)}`)
    await page.waitForTimeout(500)
  }
  testInfo.annotations.push({ type: 'samples', description: `${samples} samples, at most ${mostMoving} rows moving at once` })

  expect(overLimit, 'rows in Starting, Resuming or Uploading at a sample').toEqual([])
  expect(outOfOrder).toEqual([])
  // Not vacuous: the limit was reached, so the queue really ran files side by side.
  expect(mostMoving).toBeGreaterThanOrEqual(2)
  expect(count(final, ...FINISHED_UPLOADING)).toBe(50)

  // Start order = drop order, from what the page sent: one initiate per file, in the order dropped.
  const initiates = initiatesOf(traffic, files)
  expect(initiates.map((c) => c.name)).toEqual(files.map((f) => f.name))
  expect(initiates.every((c) => c.status === 200)).toBe(true)

  // "The next file starts only near the end of the one ahead": whenever a file was
  // started, the files already running had fewer than MAX_ACTIVE_FILES between
  // them and fewer than BUDGET parts still to send (a file still initiating
  // counts as the whole budget, or one part when it is a single-part file).
  const ordered = [...traffic.initiates].sort((a, b) => a.at - b.at)
  let mostRunning = 0
  let mostUnfinished = 0
  const startRule: string[] = []
  for (const call of ordered) {
    const running = ordered.filter((o) => o !== call && o.at < call.at && !finishedBy(traffic, o, call.at))
    const unfinished = running.reduce((sum, o) => sum + unfinishedParts(traffic, o, call.at), 0)
    mostRunning = Math.max(mostRunning, running.length)
    mostUnfinished = Math.max(mostUnfinished, unfinished)
    if (running.length >= MAX_ACTIVE_FILES || unfinished >= BUDGET) {
      startRule.push(`${call.name} started with ${running.length} files running and ${unfinished} parts unfinished`)
    }
  }
  testInfo.annotations.push({ type: 'start rule', description: `most running ${mostRunning}, most unfinished parts ${mostUnfinished}` })
  expect(startRule).toEqual([])

  // And all 50 arrived.
  await expect.poll(async () => (await assetNames(project.id)).length, { timeout: 60_000 }).toBe(50)
})

/** Whether the file behind `call` had stopped holding a place by `t`: completed, or its initiate was refused. */
function finishedBy(traffic: Traffic, call: InitiateCall, t: number): boolean {
  if (call.doneAt !== null && call.doneAt <= t && call.status !== 200) return true
  return traffic.completes.some((c) => c.uploadId === call.uploadId && call.uploadId && c.doneAt !== null && c.doneAt <= t)
}

/** Parts the file behind `call` still had to send at `t`, as the start rule counts them. */
function unfinishedParts(traffic: Traffic, call: InitiateCall, t: number): number {
  const answered = call.doneAt !== null && call.doneAt <= t && call.chunk
  if (!answered) return call.bytes <= SINGLE_PART_BYTES ? 1 : BUDGET
  const total = Math.ceil(call.bytes / call.chunk!)
  const done = new Set(
    traffic.parts
      .filter((p) => p.uploadId === call.uploadId && p.status === 200 && p.doneAt !== null && p.doneAt <= t)
      .map((p) => p.partNumber),
  )
  return Math.max(0, total - done.size)
}

// ─── Q3 ────────────────────────────────────────────────────────────────────────

test('Q3: the second of two drops 2 s apart starts after the first', async ({ page }, testInfo) => {
  const { project } = await openProject(page, 'Q3')
  const traffic = recordTraffic(page)
  const hold = await holdParts(page)
  // Each initiate answers 2.5 s late, so a file that has begun and has no ids yet stays in "Starting…" long enough to read
  // (at 1.2 s the panel poll could miss it on a slow machine).
  await page.route(INITIATE, async (route, request) => {
    if (request.method() === 'POST') await new Promise((resolve) => setTimeout(resolve, 2_500))
    await route.fallback()
  })
  const first = await pngs(testInfo, 'q3a', Array(6).fill(1 * MB))
  const second = await pngs(testInfo, 'q3b', Array(4).fill(1 * MB))
  const all = [...first, ...second]

  await dropFiles(page, 'project', first.map((f) => f.file))
  const droppedAt = Date.now()
  await openUploads(page)
  // A file that has begun but is waiting on its initiate says "Starting…"; the rest of the drop says "Waiting to start".
  const beginning = await until(page, first, 'a file Starting…', (m) => m.some((r) => r.status === 'starting'))
  const starting = beginning.filter((r) => r.status === 'starting')
  expect(starting.map((r) => `${r.kind}: ${r.detail}`)).toEqual(starting.map(() => 'starting: Starting…'))
  expect(wrongCopy(beginning)).toEqual([])
  await until(page, first, '3 of the first drop uploading and 3 queued', (m) => count(m, 'uploading') === 3 && count(m, 'queued') === 3)
  await page.waitForTimeout(Math.max(0, 2_000 - (Date.now() - droppedAt)))

  await dropFiles(page, 'project', second.map((f) => f.file))
  // The second drop joins the back of the line: every one of its files waits.
  const queued = await until(page, second, 'the second drop queued', (m) => m.length === 4)
  expect(queued.map((r) => `${r.status}/${r.kind}: ${r.detail}`)).toEqual(Array(4).fill('queued/waiting-to-start: Waiting to start'))
  // Nothing of the second drop has asked the server for anything.
  expect(initiatesOf(traffic, second)).toEqual([])
  // The panel lists the newest drop first, and each drop in the order its files start.
  expect(mineOf(await rows(page), all).map((r) => r.name)).toEqual([...second, ...first].map((f) => f.name))

  hold.release()
  await until(page, all, 'all ten uploaded', (m) => m.length === 10 && count(m, ...FINISHED_UPLOADING) === 10, 120_000)

  // Every file of the first drop was started before any file of the second.
  const order = initiatesOf(traffic, all).map((c) => c.name)
  expect(order).toEqual(all.map((f) => f.name))
  await expect.poll(async () => (await assetNames(project.id)).length, { timeout: 60_000 }).toBe(10)
})

// ─── Q4 ────────────────────────────────────────────────────────────────────────

test('Q4: a queued file renamed before its turn is created with the new name', async ({ page }, testInfo) => {
  const { project } = await openProject(page, 'Q4')
  const traffic = recordTraffic(page)
  const hold = await holdParts(page)
  const files = await pngs(testInfo, 'q4', Array(5).fill(1 * MB))
  await freezeQueue(page, files)

  const target = files[4]
  const renamed = `${target.name}-renamed`
  expect((await rows(page)).find((r) => r.name === target.name)?.status).toBe('queued')

  const row = uploadRow(page, target.name)
  await row.hover()
  await row.locator('button[title="Rename"]').first().click()
  // The row is found by its name, which the field replaces while it is open: ask the panel for the field.
  const field = page.getByRole('textbox', { name: 'Asset name' })
  await field.fill(renamed)
  await field.press('Enter')
  // The row says the new name, still queued, and nothing was sent: the asset does not exist yet.
  await until(page, [{ name: renamed }], 'the row renamed', (m) => m.length === 1 && m[0].status === 'queued')
  expect(initiatesOf(traffic, [{ name: target.name }, { name: renamed }])).toEqual([])

  hold.release()
  await until(page, [...files.slice(0, 4), { name: renamed }], 'all five uploaded', (m) => m.length === 5 && count(m, ...FINISHED_UPLOADING) === 5, 90_000)

  // The initiate for the fifth file carried the new name, and so did the asset it made.
  const sent = traffic.initiates.find((c) => c.file === `${target.name}.png`)
  expect(sent?.name).toBe(renamed)
  await expect.poll(() => assetNames(project.id), { timeout: 60_000 }).toEqual(expect.arrayContaining([renamed]))
  const names = await assetNames(project.id)
  expect(names).not.toContain(target.name)
  expect(names).toHaveLength(5)
})

// ─── C1, C2, C3 ────────────────────────────────────────────────────────────────

test('C1: cancelling a queued file removes its row and sends nothing for it', async ({ page }, testInfo) => {
  const { project } = await openProject(page, 'C1')
  const traffic = recordTraffic(page)
  const initiates = countRequests(page, /\/upload\/initiate$/)
  const aborts = countRequests(page, /\/upload\/abort$/)
  const hold = await holdParts(page)
  const files = await pngs(testInfo, 'c1', Array(5).fill(1 * MB))
  await freezeQueue(page, files)
  expect(initiates.count()).toBe(3)

  const cancelled = files[4]
  await clickRowAction(page, cancelled.name, 'Cancel upload')
  await expect.poll(async () => (await rows(page)).some((r) => r.name === cancelled.name), { timeout: 10_000 }).toBe(false)

  hold.release()
  const rest = files.slice(0, 4)
  await until(page, rest, 'the other four uploaded', (m) => m.length === 4 && count(m, ...FINISHED_UPLOADING) === 4, 90_000)

  // Four initiates in all, none of them for the cancelled file; nothing was created, so nothing to abort.
  expect(initiates.count()).toBe(4)
  expect(traffic.initiates.map((c) => c.name)).toEqual(rest.map((f) => f.name))
  expect(aborts.count()).toBe(0)
  expect((await rows(page)).some((r) => r.name === cancelled.name), 'the row stays gone').toBe(false)
  await expect.poll(() => assetNames(project.id), { timeout: 60_000 }).toHaveLength(4)
  expect(await assetNames(project.id)).not.toContain(cancelled.name)
})

test('C2: Cancel all queued removes every queued row and leaves the active files running', async ({ page }, testInfo) => {
  const { project } = await openProject(page, 'C2')
  const traffic = recordTraffic(page)
  const aborts = countRequests(page, /\/upload\/abort$/)
  const hold = await holdParts(page)
  const files = await pngs(testInfo, 'c2', Array(8).fill(1 * MB))
  await freezeQueue(page, files)
  const active = files.slice(0, 3)
  const queued = files.slice(3)

  const button = page.getByRole('button', { name: 'Cancel all queued' })
  await expect(button).toBeVisible()
  await button.click()

  // Every queued row is gone, the three active ones are untouched, and the button goes with the queue.
  const left = await until(page, files, 'only the active files left', (m) => m.length === 3)
  expect(left.map((r) => r.name)).toEqual(active.map((f) => f.name))
  expect(left.every((r) => r.status === 'uploading')).toBe(true)
  await expect(button).toHaveCount(0)

  hold.release()
  await until(page, active, 'the active files finished', (m) => m.length === 3 && count(m, ...FINISHED_UPLOADING) === 3, 90_000)

  // Nothing started for the cancelled files, and nothing was aborted.
  const asked = initiatesOf(traffic, files).map((c) => c.name)
  expect(asked).toEqual(active.map((f) => f.name))
  expect(aborts.count()).toBe(0)
  expect(mineOf(await rows(page), queued)).toEqual([])
  await expect.poll(() => assetNames(project.id), { timeout: 60_000 }).toHaveLength(3)
})

test('C3: cancelling the active file starts the next one and aborts the upload once', async ({ page }, testInfo) => {
  const { project } = await openProject(page, 'C3')
  const traffic = recordTraffic(page)
  const aborts = countRequests(page, /\/upload\/abort$/)
  const hold = await holdParts(page)
  const files = await pngs(testInfo, 'c3', Array(5).fill(1 * MB))
  await freezeQueue(page, files)
  expect(initiatesOf(traffic, files).map((c) => c.name)).toEqual(files.slice(0, 3).map((f) => f.name))

  const [cancelled, , , next] = files
  await clickRowAction(page, cancelled.name, 'Cancel upload')

  // The cancelled row stops; the first queued file takes its place.
  await until(page, [cancelled], 'the cancelled row', (m) => m.length === 1 && m[0].status === 'cancelled')
  await until(page, [next], 'the next file started', (m) => m.length === 1 && (m[0].status === 'starting' || m[0].status === 'uploading'))
  await expect.poll(() => initiatesOf(traffic, [next]).length, { timeout: 15_000 }).toBe(1)
  await expect.poll(() => aborts.count(), { timeout: 15_000 }).toBe(1)

  hold.release()
  const rest = files.slice(1)
  await until(page, rest, 'the rest uploaded', (m) => m.length === 4 && count(m, ...FINISHED_UPLOADING) === 4, 90_000)

  // One abort, for the cancelled upload and for no other, even after everything else finished.
  await page.waitForTimeout(1_500)
  expect(aborts.count()).toBe(1)
  expect(traffic.aborts).toHaveLength(1)
  expect(traffic.aborts[0].uploadId).toBe(initiatesOf(traffic, [cancelled])[0].uploadId)
  expect(initiatesOf(traffic, files).map((c) => c.name)).toEqual(files.map((f) => f.name))
  await expect.poll(() => assetNames(project.id), { timeout: 60_000 }).toHaveLength(4)
  expect(await assetNames(project.id)).not.toContain(cancelled.name)
})

// ─── S1, S2 ────────────────────────────────────────────────────────────────────

test('S1: a storage outage at initiate holds the queue, retries no sooner than 5 s apart, then carries on', async ({ page }, testInfo) => {
  test.setTimeout(5 * 60_000)
  const { project } = await openProject(page, 'S1')
  const traffic = recordTraffic(page)
  // The API's coded answer to an unreachable storage, three times.
  await failInitiate(
    page,
    {
      status: 503,
      body: { detail: { code: 'storage_unavailable', message: 'Could not reach storage to start this upload. Please retry.', retry_after: 5 } },
      headers: { 'retry-after': '5' },
    },
    3,
  )
  // Just over 5 MiB: a file this size counts as the whole part budget while it initiates, so the
  // queue asks for one file at a time and all three refusals land on the first. (A file of 5 MiB
  // or less counts as one part, and three of them ask at once.)
  const files = await pngs(testInfo, 's1', Array(3).fill(6 * MB))
  await dropFiles(page, 'project', files.map((f) => f.file))
  await openUploads(page)

  // The first file is the one asking; the queue says why it is waiting. The rest wait their turn, not failed.
  const held = await until(page, files, 'Waiting for storage', (m) => m.some((r) => r.kind === 'waiting-for-storage'), 30_000)
  const probe = held.find((r) => r.kind === 'waiting-for-storage')!
  expect(probe.name).toBe(files[0].name)
  expect(probe.detail).toBe('Waiting for storage')
  expect(probe.status).toBe('queued')
  expect(held.filter((r) => r.name !== probe.name).map((r) => `${r.status}/${r.kind}: ${r.detail}`)).toEqual(
    Array(2).fill('queued/waiting-to-start: Waiting to start'),
  )

  // Through the whole outage no row fails.
  const failures: string[] = []
  const deadline = Date.now() + 120_000
  for (;;) {
    const mine = mineOf(await rows(page), files)
    failures.push(...mine.filter((r) => r.status === 'failed').map((r) => `${r.name}: ${r.detail}`))
    // At every sample of the outage each waiting line (the probe's between tries, "Starting…" during one) reads as designed.
    failures.push(...wrongCopy(mine))
    if (mine.length === 3 && count(mine, ...FINISHED_UPLOADING) === 3) break
    if (Date.now() > deadline) throw new Error(`S1 did not finish: ${summary(mine)}`)
    await page.waitForTimeout(500)
  }
  expect(failures).toEqual([])

  // The first file asked four times (three refusals, then the answer), each try at least 5 s after the one before.
  // A 250 ms allowance covers the jitter between the page's clock and the test's.
  const asked = traffic.initiates.map((c) => c.name)
  expect(asked).toEqual([files[0].name, files[0].name, files[0].name, files[0].name, files[1].name, files[2].name])
  expect(traffic.initiates.slice(0, 4).map((c) => c.status)).toEqual([503, 503, 503, 200])
  const tries = traffic.initiates.slice(0, 4).map((c) => c.at)
  const gaps = tries.slice(1).map((t, i) => t - tries[i])
  expect(gaps).toHaveLength(3)
  for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(5_000 - 250)
  // The held queue started nothing else until the first file got through.
  expect(traffic.initiates[4].at).toBeGreaterThanOrEqual(traffic.initiates[3].doneAt!)
  await expect.poll(async () => (await assetNames(project.id)).length, { timeout: 60_000 }).toBe(3)
})

test('S2: every part PUT refused for 60 s makes no more presign requests than budget x 8', async ({ page }, testInfo) => {
  test.setTimeout(5 * 60_000)
  await openProject(page, 'S2')
  const presigns = countRequests(page, /\/upload\/presign-part/)
  const puts = countRequests(page, PART)
  await failParts(page, 503) // every part PUT, for as long as the page lives

  // Twenty parts of 10 MB, four times the budget: only the rule that keeps a file with a part in backoff from
  // starting fresh ones holds the count down. (With six parts the bound could not be exceeded even without it.)
  const PARTS = 20
  const [file] = await pngs(testInfo, 's2', [PARTS * 10 * MB])
  await dropFiles(page, 'project', [file.file])
  await openUploads(page)
  const startedAt = Date.now()
  await until(page, [file], 'the upload to start', (m) => m.length === 1 && m[0].status === 'uploading', 30_000)
  const before = presigns.count()

  await page.waitForTimeout(60_000 - (Date.now() - startedAt))
  const inWindow = presigns.count()
  testInfo.annotations.push({ type: 'presigns', description: `${inWindow} presign requests and ${puts.count()} part PUTs in 60 s` })

  // The retry ladder ran: PUTs were made and refused, and some parts were tried again ...
  expect(before).toBeGreaterThan(0)
  expect(puts.count()).toBeGreaterThan(0)
  expect(inWindow).toBeGreaterThan(2 * BUDGET)
  // ... and stayed inside the budget: at most BUDGET parts working or sleeping, each on an 8-step ladder.
  expect(inWindow).toBeLessThanOrEqual(BUDGET * 8)
  // Still trying: the ladder is minutes long, so the row has neither failed nor given up.
  expect((await rows(page)).find((r) => r.name === file.name)?.status).toBe('uploading')
})

// ─── R1, R3 ────────────────────────────────────────────────────────────────────

/**
 * An upload that was interrupted by closing its page, and the project it was
 * going into. Every part PUT hangs, so no byte of it ever reaches storage: the
 * row is saved with its version and multipart ids and nothing sent.
 *
 * Closing a page and opening another is what a browser's "reopen closed tab" does,
 * and it hands the new page the old one's sessionStorage, which is where the app
 * keeps the tab's id. Without it the new page is a different tab, and an upload
 * the old one stamped less than 150 s ago reads "Elsewhere", not "Interrupted".
 */
async function interruptedUpload(context: BrowserContext, page: Page, testInfo: TestInfo, tag: string) {
  const { project } = await openProject(page, tag)
  const parts = countRequests(page, PART)
  await hangParts(page)
  const [file] = await pngs(testInfo, tag.toLowerCase(), [12 * MB]) // two parts
  await dropFiles(page, 'project', [file.file])
  await openUploads(page)
  await until(page, [file], 'the upload hanging', (m) => m.length === 1 && m[0].status === 'uploading')
  await expect.poll(() => parts.count(), { timeout: 30_000 }).toBeGreaterThan(0)

  const saved = await page.evaluate((name) => {
    const files = JSON.parse(window.localStorage.getItem('ff-uploads') ?? '{}').state?.files ?? []
    const row = files.find((f: any) => f.assetName === name)
    return row ? { id: row.id, versionId: row.versionId, uploadId: row.uploadId, tab: window.sessionStorage.getItem('ff-upload-tab') } : null
  }, file.name)
  expect(saved?.versionId, 'the row is saved with its version').toBeTruthy()
  expect(saved?.uploadId, 'the row is saved with its multipart upload').toBeTruthy()
  await page.close()
  return { project, file, saved: saved! }
}

/** Open the project in a fresh page of `context` that is the closed tab reopened. */
async function reopen(context: BrowserContext, projectId: string, tab: string | null, watchRowId: string): Promise<Page> {
  const page = await context.newPage()
  await page.addInitScript(
    ({ tab, id }) => {
      try {
        if (tab && !window.sessionStorage.getItem('ff-upload-tab')) window.sessionStorage.setItem('ff-upload-tab', tab)
      } catch {
        /* storage blocked */
      }
      // Every write of the upload list, and whether it still holds the row.
      const writes: Array<{ at: number; has: boolean | null; status: string | null }> = []
      ;(window as any).__e2eUploadWrites = writes
      const setItem = Storage.prototype.setItem
      Storage.prototype.setItem = function (key: string, value: string) {
        if (key === 'ff-uploads') {
          let row: any = null
          let parsed = true
          try {
            row = (JSON.parse(value).state?.files ?? []).find((f: any) => f.id === id)
          } catch {
            parsed = false
          }
          writes.push({ at: Date.now(), has: parsed ? !!row : null, status: row?.status ?? null })
        }
        return setItem.call(this, key, value)
      }
    },
    { tab, id: watchRowId },
  )
  await page.goto(`/projects/${projectId}`)
  // Hydrated: a drop made before the page's handlers are attached goes nowhere.
  await expect(page.getByText('No assets')).toBeVisible()
  return page
}

/** The saved row, as shared storage holds it right now. */
const savedRow = (page: Page, id: string) =>
  page.evaluate((rowId) => {
    const files = JSON.parse(window.localStorage.getItem('ff-uploads') ?? '{}').state?.files ?? []
    const row = files.find((f: any) => f.id === rowId)
    return row ? { status: row.status as string, queuedResume: !!row.queuedResume } : null
  }, id)

test('R1: a Resume made while ten files are queued starts next, and stays saved throughout', async ({ context, page }, testInfo) => {
  test.setTimeout(5 * 60_000)
  const { project, file, saved } = await interruptedUpload(context, page, testInfo, 'R1')

  const page2 = await reopen(context, project.id, saved.tab, saved.id)
  const traffic = recordTraffic(page2)
  const hold = await holdParts(page2)
  // Three start, ten wait.
  const queue = await pngs(testInfo, 'r1q', Array(13).fill(1 * MB))
  await dropFiles(page2, 'project', queue.map((f) => f.file))
  await openUploads(page2)
  await until(page2, queue, '3 uploading and 10 queued', (m) => m.length === 13 && count(m, 'uploading') === 3 && count(m, 'queued') === 10)

  // The closed tab's upload is back as Interrupted, saved, and offers Resume.
  const interrupted = await until(page2, [file], 'the interrupted row', (m) => m.length === 1 && m[0].status === 'interrupted')
  expect(interrupted[0].kind).toBe('interrupted')
  expect(await savedRow(page2, saved.id)).toMatchObject({ status: 'interrupted' })

  // Resume: pick the same file again.
  const resumedAt = Date.now()
  const row = uploadRow(page2, file.name)
  await row.hover()
  const chooser = page2.waitForEvent('filechooser')
  await row.locator('button[title^="Resume"]').click()
  await (await chooser).setFiles(file.file)

  // It waits its turn at the front of the queue, saved as an interrupted upload the whole time.
  const waiting = await until(page2, [file], 'Waiting to resume', (m) => m.length === 1 && m[0].kind === 'waiting-to-resume')
  expect(waiting[0]).toMatchObject({ status: 'interrupted', detail: 'Waiting to resume' })
  expect(await savedRow(page2, saved.id)).toMatchObject({ status: 'interrupted' })
  expect(traffic.partLists, 'nothing asked for the resume before its turn').toEqual([])

  hold.release()
  await until(page2, [file, ...queue], 'everything uploaded', (m) => m.length === 14 && count(m, ...FINISHED_UPLOADING) === 14, 150_000)

  // The Resume took its turn before the first of the ten that had been waiting: it asked for
  // its parts before the fourth file of the drop asked to be created.
  const firstOfTheTen = initiatesOf(traffic, [queue[3]])[0]
  const resume = traffic.partLists.find((p) => p.versionId === saved.versionId)
  expect(resume, 'the resume asked the server which parts it holds').toBeTruthy()
  expect(firstOfTheTen).toBeTruthy()
  expect(resume!.at).toBeLessThan(firstOfTheTen.at)
  expect(resume!.at).toBeGreaterThan(resumedAt)
  // The drop still started in order around it.
  expect(initiatesOf(traffic, queue).map((c) => c.name)).toEqual(queue.map((f) => f.name))

  // Its entry in ff-uploads existed at every write from the Resume click until the upload was
  // across (once it is Processing or Ready the panel gets it back from the server's history,
  // and the app stops saving it). Bounded by when the test saw the completion go out: the page
  // sent it before that, and it was answered after, so every write before it is from before the
  // upload was across. (A bound 250 ms before the answer arrived left out the whole send when the
  // resume sent its two parts and completed in under 250 ms, which it does once the queue ahead
  // of it has drained: seen in WebKit, 2026-10-22.)
  const writes = await page2.evaluate(() => (window as any).__e2eUploadWrites as Array<{ at: number; has: boolean | null; status: string | null }>)
  const completed = traffic.completes.find((c) => c.uploadId === saved.uploadId)
  expect(completed?.doneAt, 'the resumed upload was completed').toBeTruthy()
  const throughout = writes.filter((w) => w.at >= resumedAt && w.at < completed!.at)
  expect(throughout.length, 'the app wrote the upload list while the resume ran').toBeGreaterThan(5)
  expect(throughout.filter((w) => w.has !== true), 'writes that lost the row').toEqual([])
  // It went from saved as Interrupted (while it waited) to saved as Uploading (while it sent).
  expect(new Set(throughout.map((w) => w.status))).toEqual(new Set(['interrupted', 'uploading']))
})

/**
 * Regression test for APP-BUG-1, found by the phase 2 live Chrome pass (live-runs/2026-10-22-phase-2.md, R1).
 *
 * A Resume that had to wait in the queue was read as "Still uploading in another tab or on another
 * device" when its turn came, if its turn came more than 30 s (OWN_STOP_GRACE_MS) after the page that was
 * sending it stopped: `activeElsewhere` measured the user's control of their own upload from the row's
 * last heartbeat, and nothing refreshes that heartbeat while the Resume waits. It now judges a queued
 * Resume as of the click, provided the server has seen nothing move since. R1 does not cover this because
 * its Resume starts within seconds of the page closing.
 */
test('R1b: a Resume that waits in the queue past the own-stop grace still resumes', async ({ context, page }, testInfo) => {
  test.setTimeout(4 * 60_000)
  const { project, file, saved } = await interruptedUpload(context, page, testInfo, 'R1b')

  const page2 = await reopen(context, project.id, saved.tab, saved.id)
  const hold = await holdParts(page2)
  const queue = await pngs(testInfo, 'r1bq', Array(8).fill(1 * MB))
  await dropFiles(page2, 'project', queue.map((f) => f.file))
  await openUploads(page2)
  await until(page2, queue, '3 uploading and 5 queued', (m) => m.length === 8 && count(m, 'uploading') === 3 && count(m, 'queued') === 5)

  // Resume at once: the click is well inside the grace. The queue is frozen, so the Resume waits.
  const row = uploadRow(page2, file.name)
  await row.hover()
  const chooser = page2.waitForEvent('filechooser')
  await row.locator('button[title^="Resume"]').click()
  await (await chooser).setFiles(file.file)
  await until(page2, [file], 'Waiting to resume', (m) => m.length === 1 && m[0].kind === 'waiting-to-resume')

  // Its turn comes after the grace: the last heartbeat is older than 15 s when the page closed, plus this wait.
  await page2.waitForTimeout(35_000)
  hold.release()

  // It should carry on from the parts the server holds, like the rest of the queue.
  await until(page2, [file, ...queue], 'everything uploaded', (m) => m.length === 9 && count(m, ...FINISHED_UPLOADING) === 9, 60_000)
})

test('R3: cancelling during Resuming returns the row to Interrupted and sends no abort', async ({ context, page }, testInfo) => {
  test.setTimeout(3 * 60_000)
  const { project, file, saved } = await interruptedUpload(context, page, testInfo, 'R3')

  const page2 = await reopen(context, project.id, saved.tab, saved.id)
  const traffic = recordTraffic(page2)
  const aborts = countRequests(page2, /\/upload\/abort$/)
  const puts = countRequests(page2, PART)
  // The resume's call for the parts it holds is not answered until the test lets it: the row sits in Resuming until then.
  let listCalls = 0
  let answerParts!: () => void
  const mayAnswer = new Promise<void>((resolve) => (answerParts = resolve))
  await page2.route(PARTS_LIST, async (route) => {
    listCalls += 1
    await mayAnswer
    await route.fallback().catch(() => {})
  })
  await openUploads(page2)
  await until(page2, [file], 'the interrupted row', (m) => m.length === 1 && m[0].status === 'interrupted')

  const row = uploadRow(page2, file.name)
  await row.hover()
  const chooser = page2.waitForEvent('filechooser')
  await row.locator('button[title^="Resume"]').click()
  await (await chooser).setFiles(file.file)

  const resuming = await until(page2, [file], 'Resuming', (m) => m.length === 1 && m[0].kind === 'resuming', 20_000)
  expect(resuming[0]).toMatchObject({ status: 'starting', detail: 'Resuming…' })
  expect(traffic.partLists).toHaveLength(1)

  await clickRowAction(page2, file.name, 'Cancel upload')
  const back = await until(page2, [file], 'back to Interrupted', (m) => m.length === 1 && m[0].status === 'interrupted' && m[0].kind === 'interrupted', 10_000)
  expect(back[0].detail).not.toMatch(/Resuming|Waiting/)

  // The cancelled run is still waiting for its answer, so Resume is not offered yet; the row is Interrupted and nothing is torn down.
  expect(listCalls).toBe(1)
  await expect(uploadRow(page2, file.name).locator('button[title^="Resume"]')).toHaveCount(0)
  expect(aborts.count()).toBe(0)

  // Now let the listing answer. The run ends when it does, which is when Resume comes back: wait for that, not for a clock.
  const answered = page2.waitForResponse((r) => PARTS_LIST.test(r.url()))
  answerParts()
  await answered
  await expect(uploadRow(page2, file.name).locator('button[title^="Resume"]')).toHaveCount(1)
  await page2.waitForTimeout(500) // anything the run would still send after its answer goes out in this time
  expect(aborts.count(), 'no abort: the parts already on the server are the point').toBe(0)
  expect(traffic.aborts).toEqual([])
  expect(puts.count(), 'no part was sent after the cancel').toBe(0)
  const settled = (await rows(page2)).find((r) => r.name === file.name)
  expect(settled).toMatchObject({ status: 'interrupted', kind: 'interrupted' })
  expect(await savedRow(page2, saved.id)).toMatchObject({ status: 'interrupted', queuedResume: false })
  // And the upload itself was never touched on the server: it still has its version.
  const token = await accessToken(await primary())
  const state = await json<{ state: string }>('GET', `/upload/${saved.versionId}/parts`, { token })
  expect(state.state).toBe('resumable')
})

// ─── V1 ────────────────────────────────────────────────────────────────────────

test('V1: a New Version behind a long queue says so, and appears without a reload', async ({ page }, testInfo) => {
  test.setTimeout(5 * 60_000)
  const { project } = await openProject(page, 'V1')
  const traffic = recordTraffic(page)

  // An asset to put a version on.
  const [base] = await pngs(testInfo, 'v1base', [1 * MB])
  await dropFiles(page, 'project', [base.file])
  await openUploads(page)
  await until(page, [base], 'the first asset uploaded', (m) => m.length === 1 && m[0].status === 'complete')
  await page.reload() // the grid only refetches on its own once a row is Ready; the page starts clean again
  const card = page.getByRole('button', { name: `${base.name} menu` })
  await expect(card).toHaveCount(1)

  // A long queue: three uploading, three waiting, parts on hold.
  const hold = await holdParts(page)
  const queue = await pngs(testInfo, 'v1q', Array(6).fill(1 * MB))
  await dropFiles(page, 'project', queue.map((f) => f.file))
  await expect.poll(() => hold.held(), { timeout: 30_000 }).toBe(3)

  // To the asset by clicking, so the page is not reloaded and the queue stays in memory.
  await page.evaluate(() => ((window as any).__e2eStillHere = true))
  await closeUploads(page) // a drop opens the panel, and its backdrop covers the page
  await page.getByText(base.name, { exact: true }).first().dblclick() // a click selects, a double click opens
  await expect(page).toHaveURL(/\/assets\//)
  const assetId = page.url().match(/\/assets\/([0-9a-f-]{36})/)![1]

  // New Version: pick a file in the asset page's own chooser.
  const [version] = await pngs(testInfo, 'v1new', [1 * MB])
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'New Version' }).click()
  await (await chooser).setFiles(version.file)

  const line = page.getByRole('status').filter({ hasText: 'New version queued, waiting for other uploads' })
  await expect(line).toBeVisible()
  // It really is waiting: the server has not been asked for a version yet.
  expect(traffic.initiates.filter((c) => c.name !== base.name && c.file === `${version.name}.png`)).toEqual([])
  const token = await accessToken(await primary())
  expect(await json<unknown[]>('GET', `/assets/${assetId}/versions`, { token })).toHaveLength(1)

  hold.release()
  // The line goes when the version exists, and the version shows up in the switcher, no reload.
  await expect(line).toHaveCount(0, { timeout: 120_000 })
  await expect(async () => {
    await closeUploads(page) // starting an upload opens the panel again
    await page.getByText('Version:').locator('..').getByRole('button').first().click()
    await expect(page.getByRole('menuitem', { name: /^v2/ })).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 60_000 })
  await page.keyboard.press('Escape')
  expect(await page.evaluate(() => (window as any).__e2eStillHere), 'the page was not reloaded').toBe(true)

  // It queued behind all six, and created version 2 of the same asset.
  const order = traffic.initiates.map((c) => c.file)
  expect(order.slice(-1)).toEqual([`${version.name}.png`])
  expect(order).toHaveLength(8)
  expect(await json<unknown[]>('GET', `/assets/${assetId}/versions`, { token })).toHaveLength(2)
  expect(await assetNames(project.id)).toHaveLength(7)
})

// ─── P1 ────────────────────────────────────────────────────────────────────────

type InstanceSettings = { storage_limit_bytes: number; storage_used_bytes: number; upload_part_size_bytes?: number }

test('P1: a storage cap that fits about 3 of 10 files refuses the rest with Retry and none hangs', async ({ page }, testInfo) => {
  test.setTimeout(10 * 60_000)
  const account = await primary()
  // Every call takes the token afresh (`accessToken` caches one for ten minutes, a token lives fifteen): this test can run long.
  const settings = async () => json<InstanceSettings>('GET', '/instance/settings', { token: await accessToken(account) })
  const before = await settings()
  expect(before.storage_limit_bytes, 'a cap is already set: a run that crashed left it, reset it by hand').toBe(0)

  // Seven 5 MiB parts per file: more than the part budget, so each file is still sending
  // when the next one starts and at most two are ever in flight (see the comment below).
  const FILE = 35 * MB
  const files = await pngs(testInfo, 'p1', Array(10).fill(FILE))
  const cap = before.storage_used_bytes + Math.floor(3.5 * FILE)
  const { project } = await openProject(page, 'P1')
  const traffic = recordTraffic(page)
  await throttleParts(page, 5 * MB) // a 5 MiB part takes 1 s

  try {
    await json('PUT', '/instance/settings', { token: await accessToken(account), body: { storage_limit_bytes: cap, upload_part_size_bytes: 5 * MB } })
    await dropFiles(page, 'project', files.map((f) => f.file))
    await openUploads(page)
    const ended = await until(
      page,
      files,
      'every row Complete, Processing or Failed',
      (m) => m.length === 10 && m.every((r) => ['complete', 'processing', 'failed'].includes(r.status)),
      240_000,
    )

    const failed = ended.filter((r) => r.status === 'failed')
    const accepted = ended.filter((r) => r.status !== 'failed')
    testInfo.annotations.push({ type: 'cap', description: `${accepted.length} accepted, ${failed.length} refused` })
    expect(failed.length, 'at least one row refused').toBeGreaterThanOrEqual(1)
    expect(accepted.length, 'some rows fit').toBeGreaterThanOrEqual(1)
    for (const row of failed) expect(row.detail).toMatch(/^Storage limit reached/)
    // Nothing is left waiting or half started.
    expect(count(ended, 'queued', 'starting', 'uploading')).toBe(0)
    // Every refused row offers Retry (and Dismiss).
    for (const row of failed) {
      await uploadRow(page, row.name).hover()
      await expect(uploadRow(page, row.name).locator('button[title="Retry"]')).toHaveCount(1)
      await expect(uploadRow(page, row.name).locator('button[title="Dismiss"]')).toHaveCount(1)
    }

    // The refusals are the files at the end of the drop, answered 400 by the initiate: the cap only grows tighter.
    const answers = initiatesOf(traffic, files).map((c) => c.status)
    expect(answers).toEqual([...Array(accepted.length).fill(200), ...Array(failed.length).fill(400)])

    // The cap counts only committed media, so files in flight when a later one was checked
    // went over it. With a file or two in flight at a time, that is by less than one file.
    const after = await settings()
    const committed = after.storage_used_bytes - before.storage_used_bytes
    // (The accepted files, plus the few KB of thumbnail the transcoder may have made of each.)
    expect(committed).toBeGreaterThanOrEqual(accepted.length * FILE)
    expect(after.storage_used_bytes - cap, 'bytes over the cap').toBeLessThanOrEqual(FILE)
    expect(await assetNames(project.id)).toHaveLength(accepted.length)
  } finally {
    // A token taken afresh: one from the start of a slow run may have expired, and a failed restore leaves the cap set.
    await json('PUT', '/instance/settings', {
      token: await accessToken(account),
      body: { storage_limit_bytes: before.storage_limit_bytes, upload_part_size_bytes: before.upload_part_size_bytes ?? 0 },
    })
  }
  expect((await settings()).storage_limit_bytes).toBe(0)
})

// ─── P2 ────────────────────────────────────────────────────────────────────────

test('P2: files queued for a project that is deleted fail with 404 while another project\'s upload', async ({ page }, testInfo) => {
  test.setTimeout(5 * 60_000)
  const account = await primary()
  const token = await accessToken(account)
  const stamp = Date.now()
  const doomed = await createProject(account, `E2E P2 doomed ${stamp}`)
  const kept = await createProject(account, `E2E P2 kept ${stamp}`)
  const doomedName = `E2E P2 doomed ${stamp}`
  const keptName = `E2E P2 kept ${stamp}`

  // Three blockers keep every active place busy while the rest are queued.
  const { project: blockerProject } = await openProject(page, 'P2 blockers')
  const traffic = recordTraffic(page)
  const hold = await holdParts(page)
  const blockers = await pngs(testInfo, 'p2b', Array(3).fill(1 * MB))
  await dropFiles(page, 'project', blockers.map((f) => f.file))
  await expect.poll(() => hold.held(), { timeout: 30_000 }).toBe(3)

  // Then, by clicking through the app (a reload would lose what is queued), five files for one project and two for another.
  const goToProject = async (name: string) => {
    await closeUploads(page) // a drop opens the panel, and its backdrop covers the sidebar
    await page.locator('a[href="/projects"]').first().click()
    await expect(page).toHaveURL(/\/projects$/)
    await page.getByText(name, { exact: true }).first().click()
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/)
    await expect(page.getByText('No assets')).toBeVisible()
  }
  const five = await pngs(testInfo, 'p2d', Array(5).fill(1 * MB))
  const two = await pngs(testInfo, 'p2k', Array(2).fill(1 * MB))
  await goToProject(doomedName)
  await dropFiles(page, 'project', five.map((f) => f.file))
  await goToProject(keptName)
  await dropFiles(page, 'project', two.map((f) => f.file))

  await openUploads(page)
  const all = [...blockers, ...five, ...two]
  await until(page, all, '3 uploading and 7 queued', (m) => m.length === 10 && count(m, 'uploading') === 3 && count(m, 'queued') === 7)

  // The first project goes away under its five queued files.
  await json('DELETE', `/projects/${doomed.id}`, { token })

  hold.release()
  const ended = await until(
    page,
    all,
    'the blockers and the kept project\'s files done, the deleted project\'s failed',
    (m) => m.length === 10 && m.every((r) => ['complete', 'processing', 'failed'].includes(r.status)),
    120_000,
  )

  // The five fail, each refused with a 404 and a reason, and offer Dismiss.
  const failedRows = ended.filter((r) => r.status === 'failed')
  expect(failedRows.map((r) => r.name).sort()).toEqual(five.map((f) => f.name).sort())
  for (const row of failedRows) {
    expect(row.detail).toMatch(/not found/i)
    await uploadRow(page, row.name).hover()
    await expect(uploadRow(page, row.name).locator('button[title="Dismiss"]')).toHaveCount(1)
  }
  const refused = initiatesOf(traffic, five)
  expect(refused.map((c) => c.status)).toEqual(Array(5).fill(404))
  // The two for the other project, and the blockers, uploaded.
  expect(ended.filter((r) => r.status !== 'failed').map((r) => r.name).sort()).toEqual([...blockers, ...two].map((f) => f.name).sort())
  expect(initiatesOf(traffic, two).map((c) => c.status)).toEqual([200, 200])
  await expect.poll(() => assetNames(kept.id), { timeout: 60_000 }).toHaveLength(2)
  expect(await assetNames(blockerProject.id)).toHaveLength(3)
})
