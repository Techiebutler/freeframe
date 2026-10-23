import { expect, test, type Page } from '@playwright/test'
import { primary, secondary, type Account } from '../fixtures/accounts'
import { holdParts } from '../fixtures/faults'
import {
  assetNames, count, FINISHED_UPLOADING, initiatesOf, MB, mineOf, openCleanProject, pngs, recordUploadCalls, removeScenarioFiles,
  summary, until, wrongCopy,
} from '../fixtures/scenario'
import {
  blackholeStorage, dropFiles, openUploads, restoreStorage, rows, startStorage, stopStorage, storageContainer, uploadRow,
} from '../fixtures/stack'

/**
 * Storage itself goes away (SCENARIOS.md: S3, S4): the stack's real MinIO
 * container is stopped, or cut off so that it answers nothing, while files are
 * queued and sending. S1 and S2 stand in for these with `page.route`; here
 * the API and the browser both meet the real outage.
 *
 * What each outage looks like from each side (measured on Docker Desktop for
 * Mac, 2026-10-23; see `blackholeStorage` in fixtures/stack.ts):
 *
 * | outage                       | browser -> host port 19000       | API initiate                          |
 * |------------------------------|----------------------------------|---------------------------------------|
 * | `docker stop`                | refused at once                  | coded 503 `storage_unavailable`, 0.01 s |
 * | `docker network disconnect`  | connects, then no answer (hangs) | coded 503: 0.09 s from a cold API (name not resolved), 10 s in S4 (see below) |
 * | `docker pause`               | connects, then no answer (hangs) | coded 503 after its 10 s read timeout |
 *
 * So `network disconnect` (the row's own mechanism) black-holes the browser's
 * side, and `pause` black-holes both; S4 runs with each. In S4 the API has just
 * started three uploads, so its S3 client holds a pooled connection to MinIO's
 * address, and after a disconnect a request on that connection gets no answer:
 * the initiate then waits out its 10 s read timeout as under `pause` (measured
 * in both: "Waiting for storage" 10.1 to 10.2 s after the turn).
 *
 * These touch a real container, so they run only with `E2E_INFRA=1`, act only
 * on the ffe2e stack's MinIO (`E2E_MINIO_CONTAINER`, default `ffe2e-minio-1`;
 * any name outside `ffe2e-` is refused), and every test puts storage back in
 * `afterEach`, pass or fail, and waits for `/minio/health/live` before the
 * next one.
 */

test.skip(process.env.E2E_INFRA !== '1', 'Stops and black-holes the e2e MinIO container: set E2E_INFRA=1 to run')

test.beforeEach(async () => {
  // A run killed mid-outage leaves storage down; put it back before starting (a no-op when it is fine).
  await restoreStorage()
})
test.afterEach(async () => {
  // Storage first, and whatever else throws: a run must never leave MinIO down.
  try {
    await restoreStorage()
  } finally {
    removeScenarioFiles()
  }
})

/** Rows that are no longer going to upload without somebody doing something. */
const GONE_WRONG = ['failed', 'cancelled', 'elsewhere']

/**
 * Drop `n` 1 MB PNGs with every part held, and wait for the queue to freeze:
 * the first three Uploading (a part PUT each, held before it reaches storage),
 * the rest Queued. The uploads panel is left open.
 */
async function freezeQueue(page: Page, tag: string, n: number) {
  const hold = await holdParts(page)
  const files = await pngs(tag, Array(n).fill(1 * MB))
  await dropFiles(page, 'project', files.map((f) => f.file))
  await openUploads(page)
  await until(page, files, `3 uploading and ${n - 3} queued`, (m) =>
    m.length === n && count(m, 'uploading') === 3 && count(m, 'queued') === n - 3)
  await expect.poll(() => hold.held(), { timeout: 30_000 }).toBe(3)
  return { hold, files }
}

// ─── S3 ────────────────────────────────────────────────────────────────────────

test('S3: storage stopped for 60 s mid-queue: queued files hold (one through its turn), the sending ones recover or end Interrupted', async ({ page }, testInfo) => {
  test.setTimeout(10 * 60_000)
  const account = await primary()
  const { project } = await openCleanProject(page, 'S3', account)
  const calls = recordUploadCalls(page)
  const { hold, files } = await freezeQueue(page, 's3', 5)
  // The first is cancelled 15 s into the outage, so the fourth's turn comes while storage is down.
  const [cancelled, ...rest] = files
  const sending = files.slice(1, 3)
  const queued = files.slice(3)

  // Storage goes, and the three parts on their way are let go into the outage.
  stopStorage()
  const downAt = Date.now()
  hold.release()

  const wrong: string[] = []
  const seen = new Set<string>()
  let cancelledAt = 0
  while (Date.now() - downAt < 60_000) {
    if (!cancelledAt && Date.now() - downAt >= 15_000) {
      const row = uploadRow(page, cancelled.name)
      await row.hover()
      await row.locator('button[title="Cancel upload"]').click()
      cancelledAt = Date.now()
    }
    const all = mineOf(await rows(page), files)
    expect(all, 'every row stays').toHaveLength(5)
    const mine = mineOf(all, rest)
    wrong.push(...mine.filter((r) => GONE_WRONG.includes(r.status)).map((r) => summary([r])))
    wrong.push(...wrongCopy(mine))
    // A sending file is sending (its part retry ladder) or Interrupted; a queued one waits, or tries (Starting).
    wrong.push(...mineOf(mine, sending).filter((r) => !['uploading', 'interrupted'].includes(r.status)).map((r) => `sending ${summary([r])}`))
    wrong.push(...mineOf(mine, queued).filter((r) => !['queued', 'starting'].includes(r.status)).map((r) => `queued ${summary([r])}`))
    for (const r of mine) seen.add(`${r.name === queued[0].name ? 'fourth ' : ''}${r.status}/${r.kind}`)
    await page.waitForTimeout(500)
  }
  expect(wrong, 'during the 60 s outage').toEqual([])
  expect(mineOf(await rows(page), [cancelled])[0]?.status).toBe('cancelled')
  // The fourth file's turn came with storage down: it asked, was told storage is unavailable, and held.
  expect(seen, 'the fourth file held for storage at its turn').toContain('fourth queued/waiting-for-storage')
  expect(initiatesOf(calls, [queued[0]]).map((c) => c.status)).toContain(503)
  // Nothing reached storage: no part answered, no queued file created, and the fifth waited its turn.
  expect(calls.puts.filter((p) => p.status === 200), 'parts answered during the outage').toEqual([])
  expect(initiatesOf(calls, queued).filter((c) => c.status === 200), 'queued files created during the outage').toEqual([])
  expect(initiatesOf(calls, [queued[1]]), 'the fifth file asked during the outage').toEqual([])

  await startStorage()
  const backAt = Date.now()

  // The queued two upload; each of the two still sending either recovers or ends Interrupted, as long as that
  // takes (the part ladder's rungs are 2, 4, 8 ... 128 s, about 254 s in all).
  const end = await until(page, rest, 'the queued two uploaded and the sending two settled', (m) =>
    m.length === 4 &&
    mineOf(m, queued).every((r) => FINISHED_UPLOADING.includes(r.status)) &&
    mineOf(m, sending).every((r) => FINISHED_UPLOADING.includes(r.status) || r.status === 'interrupted'),
    5 * 60_000)
  const recovered = mineOf(end, sending).filter((r) => FINISHED_UPLOADING.includes(r.status)).length
  testInfo.annotations.push({
    type: 'outcome',
    description: `row states seen during the outage: ${[...seen].sort().join(', ')}; of the two still sending, ${recovered} recovered and ${2 - recovered} ended Interrupted; settled ${((Date.now() - backAt) / 1000).toFixed(1)} s after storage was back; the fourth asked ${initiatesOf(calls, [queued[0]]).map((c) => c.status ?? c.failed).join(', ')}; ${summary(end)}`,
  })
  console.log(`S3: ${testInfo.annotations.at(-1)!.description}`)
  expect(end.filter((r) => GONE_WRONG.includes(r.status))).toEqual([])
  // The cancel is the only abort: an outage is not a reason to throw an upload away.
  expect(calls.aborts.map((a) => a.uploadId)).toEqual([initiatesOf(calls, [cancelled])[0].uploadId])
  expect(initiatesOf(calls, queued).filter((c) => c.status === 200), 'each queued file created once').toHaveLength(2)
  await expect.poll(async () => (await assetNames(project.id, account)).length, { timeout: 60_000 })
    .toBe(end.filter((r) => FINISHED_UPLOADING.includes(r.status)).length)
})

// ─── S4 ────────────────────────────────────────────────────────────────────────

/**
 * Storage black-holed with three files sending (parts held) and two queued;
 * then the first file is cancelled, so the fourth's turn comes, and it must say
 * "Waiting for storage" within 20 s. Then storage comes back and the rest upload.
 */
async function blackHoleScenario(page: Page, how: 'disconnect' | 'pause', account: Account, testInfo: import('@playwright/test').TestInfo) {
  const { project } = await openCleanProject(page, `S4 ${how}`, account)
  const calls = recordUploadCalls(page)
  const { hold, files } = await freezeQueue(page, `s4${how[0]}`, 5)
  const [cancelled, , , next, last] = files

  blackholeStorage(how)
  const row = uploadRow(page, cancelled.name)
  await row.hover()
  await row.locator('button[title="Cancel upload"]').click()
  const turnAt = Date.now()

  // The next file's turn: it asks, storage cannot be reached, and the row says so.
  const waiting = await until(page, [next], 'the next file Waiting for storage', (m) =>
    m.length === 1 && m[0].kind === 'waiting-for-storage', 30_000)
  const after = Date.now() - turnAt
  const firstAsk = initiatesOf(calls, [next])[0]
  const note = `${how}: shown ${(after / 1000).toFixed(1)} s after the next file's turn came; its initiate was sent at +${firstAsk ? (Math.max(0, firstAsk.at - turnAt) / 1000).toFixed(1) : '?'} s and answered ${firstAsk?.status ?? firstAsk?.failed}`
  testInfo.annotations.push({ type: 'waiting for storage', description: note })
  console.log(`S4 ${note}`)
  expect(waiting[0].detail).toBe('Waiting for storage')
  expect(waiting[0].status).toBe('queued')
  expect(after, 'ms from the next file\'s turn to "Waiting for storage"').toBeLessThanOrEqual(20_000)
  const asked = initiatesOf(calls, [next])
  expect(asked.length).toBeGreaterThanOrEqual(1)
  expect(asked[0].status, 'the API\'s answer to its initiate').toBe(503)

  // Held, not failed: for 10 s more nothing fails, the last file waits its turn, the two still sending stay put.
  const wrong: string[] = []
  const heldUntil = Date.now() + 10_000
  while (Date.now() < heldUntil) {
    const mine = mineOf(await rows(page), files.slice(1))
    wrong.push(...mine.filter((r) => GONE_WRONG.includes(r.status) || r.status === 'interrupted').map((r) => summary([r])))
    wrong.push(...wrongCopy(mine))
    wrong.push(...mineOf(mine, [last]).filter((r) => r.status !== 'queued').map((r) => `last ${summary([r])}`))
    await page.waitForTimeout(500)
  }
  expect(wrong, 'while storage is a black hole').toEqual([])
  expect(initiatesOf(calls, [last]), 'the last file waits for a place').toEqual([])

  // Storage back, parts let go: everything but the cancelled file uploads, each created once.
  await restoreStorage()
  hold.release()
  const done = await until(page, files.slice(1), 'the other four uploaded', (m) =>
    m.length === 4 && count(m, ...FINISHED_UPLOADING) === 4, 3 * 60_000)
  expect(done.filter((r) => GONE_WRONG.includes(r.status))).toEqual([])
  const nextAsks = initiatesOf(calls, [next])
  expect(nextAsks.filter((c) => c.status === 200), 'the next file created once').toHaveLength(1)
  testInfo.annotations.push({ type: 'retries', description: `the next file asked ${nextAsks.length} times: ${nextAsks.map((c) => c.status ?? c.failed).join(', ')}` })
  await expect.poll(async () => (await assetNames(project.id, account)).sort(), { timeout: 60_000 })
    .toEqual(files.slice(1).map((f) => f.name).sort())
}

test('S4: storage cut off (docker network disconnect): "Waiting for storage" within 20 s of the next file\'s turn', async ({ page }, testInfo) => {
  test.setTimeout(6 * 60_000)
  expect(storageContainer()).toMatch(/^ffe2e-/)
  await blackHoleScenario(page, 'disconnect', await secondary(), testInfo)
})

test('S4b: storage frozen (docker pause, the API waits out its timeout): "Waiting for storage" within 20 s', async ({ page }, testInfo) => {
  test.setTimeout(6 * 60_000)
  await blackHoleScenario(page, 'pause', await secondary(), testInfo)
})
