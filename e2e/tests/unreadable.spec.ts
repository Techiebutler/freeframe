import { expect, test } from '@playwright/test'
import { hangParts, holdParts, stallParts, trackUploads } from '../fixtures/faults'
import { remove, touch } from '../fixtures/files'
import {
  assetNames, count, FILE_CHANGED_COPY, FINISHED_UPLOADING, initiatesOf, MB, mineOf, openProject, pngs,
  recordUploadCalls, removeScenarioFiles, summary, until,
} from '../fixtures/scenario'
import { dropFiles, openUploads, rows, uploadRow } from '../fixtures/stack'

/**
 * Files the page can no longer read, and parts that stop moving (SCENARIOS.md:
 * U1, U2, U3). A `File` from a picker or a drop is a handle on a file on disk;
 * touch, rewrite, move or delete the file and the handle goes stale. Chromium
 * then fails a read, and an upload of it, with an error. WebKit fails a read,
 * but an upload of a stale handle (`xhr.send` of a slice) just hangs, with no
 * event at all, which only the part watchdog ends.
 *
 * The files are real files on disk (`.live-files/`, never committed), so what
 * `touch` and `remove` do to them is what the browser sees.
 */

test.afterEach(() => removeScenarioFiles())

// ─── U1 ────────────────────────────────────────────────────────────────────────

test('U1: a queued file touched before its turn fails with the changed-file copy, sends nothing, and the queue goes on', async ({ page }) => {
  const { project } = await openProject(page, 'U1')
  const calls = recordUploadCalls(page)
  const hold = await holdParts(page)
  const files = await pngs('u1', Array(5).fill(1 * MB))
  const [a, b, c, d, e] = files

  // Three start (their parts on hold), D and E wait.
  await dropFiles(page, 'project', files.map((f) => f.file))
  await openUploads(page)
  await until(page, files, '3 uploading and 2 queued', (m) => m.length === 5 && count(m, 'uploading') === 3 && count(m, 'queued') === 2)
  expect(initiatesOf(calls, [d, e])).toEqual([])

  // D is changed on disk while it waits; its turn comes when the first three are across.
  await touch(d.file)
  hold.release()

  const failed = await until(page, [d], 'D failed', (m) => m.length === 1 && m[0].status === 'failed', 60_000)
  expect(failed[0]).toMatchObject({ status: 'failed', kind: 'failed', detail: FILE_CHANGED_COPY })

  // The queue went on past it: E started and everything else is across.
  const done = await until(page, [a, b, c, e], 'the other four uploaded', (m) => m.length === 4 && count(m, ...FINISHED_UPLOADING) === 4, 90_000)
  expect(done.map((r) => r.status).every((s) => FINISHED_UPLOADING.includes(s))).toBe(true)

  // Nothing was sent for D: no initiate, so no asset, no upload to abort. The other four asked in drop order.
  expect(initiatesOf(calls, [d])).toEqual([])
  // (The first three start together, so their order among themselves is the browser's; E asks last.)
  expect(calls.initiates.map((i) => i.file).sort()).toEqual([a, b, c, e].map((f) => f.fileName).sort())
  expect(calls.initiates[3].file).toBe(e.fileName)
  expect(calls.aborts).toEqual([])
  await expect.poll(() => assetNames(project.id), { timeout: 60_000 }).toHaveLength(4)
  expect(await assetNames(project.id)).not.toContain(d.name)

  // The row offers Dismiss and nothing else: adding the file again is the only way out. It stays failed.
  const row = uploadRow(page, d.name)
  await row.hover()
  await expect(row.locator('button[title="Dismiss"]')).toHaveCount(1)
  await expect(row.locator('button[title="Retry"]')).toHaveCount(0)
  await expect(row.locator('button[title^="Resume"]')).toHaveCount(0)
  expect((await rows(page)).find((r) => r.name === d.name)).toMatchObject({ status: 'failed', detail: FILE_CHANGED_COPY })
  await row.locator('button[title="Dismiss"]').click()
  await expect.poll(async () => (await rows(page)).some((r) => r.name === d.name), { timeout: 10_000 }).toBe(false)
})

// ─── U2 ────────────────────────────────────────────────────────────────────────

test('U2: the sending file deleted mid-part ends Interrupted with the changed-file copy, and the queue goes on', async ({ page }, testInfo) => {
  test.setTimeout(10 * 60_000)
  const { project } = await openProject(page, 'U2')
  const calls = recordUploadCalls(page)
  const uploads = trackUploads(page)
  // A is two parts (12 MB); the rest are small.
  const files = await pngs('u2', [12 * MB, ...Array(4).fill(1 * MB)])
  const [a, ...rest] = files
  // Every part waits at the network until released. A's own wait is the later route, so it sees A's parts
  // first and counts them: the test knows A itself is mid-part, not just that three parts are out.
  const hold = await holdParts(page)
  const holdA = await holdParts(page, { only: uploads.partsOf(a.fileName) })

  await dropFiles(page, 'project', files.map((f) => f.file))
  await openUploads(page)
  await until(page, files, '3 uploading and 2 queued', (m) => m.length === 5 && count(m, 'uploading') === 3 && count(m, 'queued') === 2)
  // A is mid-part: a PUT of its own is on its way, held at the network.
  await expect.poll(() => holdA.held(), { timeout: 30_000 }).toBeGreaterThanOrEqual(1)
  expect(initiatesOf(calls, rest.slice(2))).toEqual([])

  await remove(a.file)
  const releasedAt = Date.now()
  hold.release()
  holdA.release()

  // A ends Interrupted, not hung and not Failed: its upload is still on the server to be finished.
  // Chromium errors the send at once; in WebKit it hangs until the part watchdog (90 s) ends it.
  const ended = await until(page, [a], 'A interrupted', (m) => m.length === 1 && m[0].status === 'interrupted', 4 * 60_000)
  const endedAfter = Date.now() - releasedAt
  expect(ended[0]).toMatchObject({ status: 'interrupted', kind: 'interrupted', detail: FILE_CHANGED_COPY })
  testInfo.annotations.push({ type: 'A interrupted', description: `${(endedAfter / 1000).toFixed(1)} s after the parts were released` })
  // 90 s watchdog + one backoff step + slack; a row that took longer was not freed by the watchdog.
  expect(endedAfter).toBeLessThan(120_000)

  // The queue went on: the other four are across, and the interrupted row holds no place.
  await until(page, rest, 'the others uploaded', (m) => m.length === 4 && count(m, ...FINISHED_UPLOADING) === 4, 120_000)
  expect(initiatesOf(calls, rest)).toHaveLength(4)
  await expect.poll(() => assetNames(project.id), { timeout: 60_000 }).toEqual(expect.arrayContaining(rest.map((f) => f.name)))
  expect((await rows(page)).find((r) => r.name === a.name)).toMatchObject({ status: 'interrupted', detail: FILE_CHANGED_COPY })

  // Nothing was thrown away: no abort, so the parts the server holds stay for a resume. And the part the
  // watchdog or the network error ended was not sent again (the retry's read of the file failed first).
  expect(calls.aborts).toEqual([])
  const aUpload = initiatesOf(calls, [a])[0]
  expect(aUpload?.uploadId).toBeTruthy()
  expect(calls.puts.filter((p) => p.uploadId === aUpload.uploadId).length, 'A is not sent a second time').toBeLessThanOrEqual(2)
})

// ─── U3 ────────────────────────────────────────────────────────────────────────

/**
 * The part watchdog. A part PUT is aborted, and retried, when it stops moving:
 *
 * - after its first upload-progress event, when 90 s pass with none (own clock);
 * - before it, only when the whole tab has had no upload progress for 90 s, or when
 *   the part itself has waited 5 min (a part held by the browser for a socket gets no
 *   progress for as long as the six sockets of a host are busy with other parts);
 * - after its last byte, when 5 min pass with no answer.
 *
 * The first two are here. The 5 min cap is not: it needs a sibling that keeps
 * the tab moving for 5 minutes, and is covered with a fake clock in
 * stores/__tests__/upload-store.test.ts ("a part that never starts is given up on
 * at 5 min even while another part keeps moving").
 */
const WATCHDOG_MS = 90_000

test('U3: parts that never start are aborted after 90 s of silence and retried, and the queue does not freeze', async ({ page }, testInfo) => {
  test.setTimeout(10 * 60_000)
  const { project } = await openProject(page, 'U3')
  const calls = recordUploadCalls(page)
  // The first PUT of each of the three files that start is never answered and never sent (no progress, no
  // answer: what a connection that never opens looks like). Their retries go through.
  await hangParts(page, { times: 3 })
  const files = await pngs('u3', Array(5).fill(1 * MB))
  const [, , , d, e] = files

  await dropFiles(page, 'project', files.map((f) => f.file))
  await openUploads(page)
  await until(page, files, '3 uploading and 2 queued', (m) => m.length === 5 && count(m, 'uploading') === 3 && count(m, 'queued') === 2)
  await expect.poll(() => calls.puts.length, { timeout: 30_000 }).toBe(3)
  const hungAt = Math.min(...calls.puts.map((p) => p.at))

  // The whole tab is silent and the three places are taken: for most of the 90 s nothing moves, D and E wait,
  // and no row fails. (Sampled until 70 s; the abort is due at 90 s.)
  while (Date.now() - hungAt < 70_000) {
    const mine = mineOf(await rows(page), files)
    expect(mine.filter((r) => ['failed', 'interrupted', 'cancelled'].includes(r.status)).map((r) => summary([r])), 'while the parts hang').toEqual([])
    expect(count(mine, 'uploading'), summary(mine)).toBe(3)
    expect(count(mine, 'queued'), summary(mine)).toBe(2)
    expect(calls.puts.length, 'no part is sent again before the watchdog acts').toBe(3)
    await page.waitForTimeout(2_000)
  }
  expect(initiatesOf(calls, [d, e])).toEqual([])

  // Then the watchdog ends each part, they go again, and the queue moves on: all five are across.
  await until(page, files, 'all five uploaded', (m) => m.length === 5 && count(m, ...FINISHED_UPLOADING) === 5, 180_000)

  // One retry per part, 90 s after the first PUT went out (+ the 2 s backoff and the presign), not before.
  const first = calls.puts.slice(0, 3)
  const gaps: number[] = []
  for (const hung of first) {
    const again = calls.puts.filter((p) => p.uploadId === hung.uploadId && p.partNumber === hung.partNumber)
    expect(again, `PUTs of ${hung.uploadId}`).toHaveLength(2)
    expect(again[1].status, 'the retry was answered').toBe(200)
    gaps.push(again[1].at - again[0].at)
  }
  testInfo.annotations.push({ type: 'retry after', description: `${gaps.map((g) => (g / 1000).toFixed(1)).join(' s, ')} s (watchdog 90 s + backoff 2 s)` })
  for (const gap of gaps) {
    expect(gap).toBeGreaterThanOrEqual(WATCHDOG_MS)
    expect(gap).toBeLessThan(WATCHDOG_MS + 15_000)
  }
  // D and E were held until a place came free, after the retries began.
  const retriedAt = Math.min(...first.map((hung) => calls.puts.filter((p) => p.uploadId === hung.uploadId)[1].at))
  expect(Math.min(...initiatesOf(calls, [d, e]).map((i) => i.at))).toBeGreaterThan(retriedAt)
  expect(initiatesOf(calls, files).map((i) => i.file).sort()).toEqual(files.map((f) => f.fileName).sort())
  await expect.poll(() => assetNames(project.id), { timeout: 60_000 }).toHaveLength(5)
})

test('U3b: a part that stops after it started is aborted 90 s after its last byte, not when the tab goes quiet, and retried', async ({ page }, testInfo) => {
  test.setTimeout(10 * 60_000)
  const { project } = await openProject(page, 'U3b')
  const calls = recordUploadCalls(page)
  const uploads = trackUploads(page)
  // A is two parts of 10 MB. One PUT of it really starts and then stops dead after a few hundred KB (so it
  // has upload progress behind it); the other part and the retry go to the bucket.
  const [a, b] = await pngs('u3b', [20 * MB, 1 * MB])
  const stall = await stallParts(page, { only: uploads.partsOf(a.fileName), times: 1 })

  await dropFiles(page, 'project', [a.file])
  await openUploads(page)
  await expect.poll(() => stall.stalled(), { timeout: 60_000 }).toBe(1)
  const stalledAt = Date.now()
  expect(stall.bytesRead(), 'the part got a first stretch across').toBeGreaterThan(0)
  const aUpload = (await uploads.of(a.fileName)).uploadId
  expect(initiatesOf(calls, [a])).toHaveLength(1)

  // 45 s in, another file is sent in full: the tab moves, but the stalled part's own clock is what counts.
  await page.waitForTimeout(Math.max(0, 45_000 - (Date.now() - stalledAt)))
  expect((await rows(page)).find((r) => r.name === a.name)?.status, 'A is still waiting on the stalled part').toBe('uploading')
  await dropFiles(page, 'project', [b.file])
  await until(page, [b], 'B uploaded', (m) => m.length === 1 && count(m, ...FINISHED_UPLOADING) === 1, 60_000)
  const tabMovedAt = Date.now()
  expect(tabMovedAt - stalledAt, 'B finished well inside the 90 s').toBeLessThan(80_000)
  const aPuts = () => calls.puts.filter((p) => p.uploadId === aUpload)
  const [stalledPart] = stall.partNumbers()
  expect(aPuts().filter((p) => p.partNumber === stalledPart), 'not retried yet').toHaveLength(1)

  // A comes across: its stalled part is aborted and sent again, a whole 10 MB this time.
  await until(page, [a], 'A uploaded', (m) => m.length === 1 && count(m, ...FINISHED_UPLOADING) === 1, 150_000)
  const attempts = aPuts().filter((p) => p.partNumber === stalledPart)
  expect(attempts, 'the stalled part was sent once more').toHaveLength(2)
  expect(attempts[1].status).toBe(200)
  const retriedAfter = attempts[1].at - stalledAt
  testInfo.annotations.push({ type: 'retry after', description: `${(retriedAfter / 1000).toFixed(1)} s after the stall began, B finished at ${((tabMovedAt - stalledAt) / 1000).toFixed(1)} s` })
  // 90 s after the stalled part's last progress (a few seconds after the stall began, while the sockets fill)
  // plus the 2 s backoff. If the tab's progress at 45 s restarted its clock it would be 135 s or later.
  expect(retriedAfter).toBeGreaterThanOrEqual(WATCHDOG_MS)
  expect(retriedAfter).toBeLessThan(125_000)
  await expect.poll(() => assetNames(project.id), { timeout: 60_000 }).toHaveLength(2)
})
