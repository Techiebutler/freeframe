import { expect, test } from '@playwright/test'
import { holdParts, networkSwitch } from '../fixtures/faults'
import {
  assetNames, count, FINISHED_UPLOADING, initiatesOf, MB, mineOf, openProject, pngs, recordUploadCalls, removeScenarioFiles,
  summary, until, wrongCopy,
} from '../fixtures/scenario'
import { dropFiles, openUploads, rows } from '../fixtures/stack'

/**
 * The browser loses its network (SCENARIOS.md: N1, N2): every request to the API
 * and the bucket fails the way a dropped connection does (`networkSwitch`:
 * `context.setOffline`, and in WebKit, where that switch also makes files
 * unreadable, a route that aborts them).
 *
 * A file that is waiting to start holds (the queue's "Waiting for connection")
 * and tries again with a growing pause; a file that is sending retries each
 * part on its own ladder (2 s, 4 s, 8 s ... about 254 s in all). Neither may
 * fail a row for being offline for half a minute.
 */

test.afterEach(() => removeScenarioFiles())

/** Rows that are no longer going to upload without somebody doing something. */
const GONE_WRONG = ['failed', 'interrupted', 'cancelled', 'elsewhere']

test('N1: files dropped while offline wait for the connection, none fails, and all upload after it returns', async ({ context, page, browserName }, testInfo) => {
  test.setTimeout(5 * 60_000)
  const network = networkSwitch(context, browserName)
  const { project } = await openProject(page, 'N1')
  const calls = recordUploadCalls(page)
  const files = await pngs('n1', Array(5).fill(1 * MB))

  await network.down()
  const offlineAt = Date.now()
  await dropFiles(page, 'project', files.map((f) => f.file))
  await openUploads(page)

  // The queue says what it is waiting for, in the design's words.
  const waiting = await until(
    page, files, 'a row Waiting for connection',
    (m) => m.length === 5 && m.some((r) => r.kind === 'waiting-for-connection'), 30_000,
  )
  expect(waiting.filter((r) => r.kind === 'waiting-for-connection').map((r) => r.detail)).toContain('Waiting for connection')

  // For 30 s offline: nothing fails, nothing is created, every row is either waiting for the connection,
  // waiting its turn, or (during a try) Starting.
  const kinds = new Set<string>()
  const wrong: string[] = []
  while (Date.now() - offlineAt < 30_000) {
    const mine = mineOf(await rows(page), files)
    expect(mine, 'every row stays').toHaveLength(5)
    wrong.push(...mine.filter((r) => GONE_WRONG.includes(r.status)).map((r) => summary([r])))
    wrong.push(...wrongCopy(mine))
    for (const r of mine) kinds.add(`${r.status}/${r.kind}`)
    expect(count(mine, 'uploading', ...FINISHED_UPLOADING), summary(mine)).toBe(0)
    await page.waitForTimeout(500)
  }
  expect(wrong, 'while offline').toEqual([])
  expect([...kinds].filter((k) => !/^queued\/(waiting-for-connection|waiting-to-start)$|^starting\/starting$/.test(k)), 'row states seen while offline').toEqual([])
  expect(kinds.has('queued/waiting-for-connection')).toBe(true)
  // Nothing got through: no asset exists yet.
  expect(await assetNames(project.id)).toEqual([])
  // The file holding the queue (the probe: whichever of the first three failed first) asked again while
  // offline, with growing pauses: held, not given up on. No initiate was answered.
  const asked = files.map((f) => initiatesOf(calls, [f]).length)
  expect(Math.max(...asked), `initiates per file while offline: ${asked.join(', ')}`).toBeGreaterThanOrEqual(2)
  expect(calls.initiates.filter((c) => c.status === 200)).toEqual([])

  await network.up()
  const backAt = Date.now()
  const done = await until(page, files, 'all five uploaded', (m) => m.length === 5 && count(m, ...FINISHED_UPLOADING) === 5, 150_000)
  testInfo.annotations.push({ type: 'recovered', description: `all five uploaded ${((Date.now() - backAt) / 1000).toFixed(1)} s after reconnecting; the probe asked ${Math.max(...asked)} times while offline` })
  expect(done.filter((r) => GONE_WRONG.includes(r.status))).toEqual([])

  // Each file was created once, when the connection allowed it, and they started in the order they were
  // dropped: the three that asked together when the drop landed failed together, in whatever order the
  // network gave up on them, and still went first, in drop order, ahead of the two that never asked.
  const answered = calls.initiates.filter((c) => c.status === 200)
  expect(answered.map((c) => c.file), 'files created, in the order they were asked for').toEqual(files.map((f) => f.fileName))
  await expect.poll(() => assetNames(project.id), { timeout: 60_000 }).toHaveLength(5)
})

test('N2: offline for 20 s in the middle of the parts, the sending files recover and the queued ones never fail', async ({ context, page, browserName }, testInfo) => {
  test.setTimeout(5 * 60_000)
  const network = networkSwitch(context, browserName)
  const { project } = await openProject(page, 'N2')
  const calls = recordUploadCalls(page)
  const hold = await holdParts(page)
  const files = await pngs('n2', Array(5).fill(3 * MB))

  // Three are sending, with a part PUT each on its way; two wait behind them.
  await dropFiles(page, 'project', files.map((f) => f.file))
  await openUploads(page)
  await until(page, files, '3 uploading and 2 queued', (m) => m.length === 5 && count(m, 'uploading') === 3 && count(m, 'queued') === 2)
  await expect.poll(() => hold.held(), { timeout: 30_000 }).toBe(3)

  // The network goes while the parts are out; they are let go into it.
  await network.down()
  const offlineAt = Date.now()
  hold.release()

  const wrong: string[] = []
  while (Date.now() - offlineAt < 20_000) {
    const mine = mineOf(await rows(page), files)
    expect(mine, 'every row stays').toHaveLength(5)
    wrong.push(...mine.filter((r) => GONE_WRONG.includes(r.status)).map((r) => summary([r])))
    wrong.push(...wrongCopy(mine))
    // The queued two do not start (the places are taken) and so have nothing to fail at.
    expect(count(mine, 'queued'), summary(mine)).toBe(2)
    expect(count(mine, 'uploading'), summary(mine)).toBe(3)
    await page.waitForTimeout(500)
  }
  expect(wrong, 'while offline').toEqual([])
  // The parts did not get through while the network was down.
  expect(calls.puts.filter((p) => p.status === 200)).toEqual([])

  await network.up()
  const backAt = Date.now()
  const done = await until(page, files, 'all five uploaded', (m) => m.length === 5 && count(m, ...FINISHED_UPLOADING) === 5, 150_000)
  testInfo.annotations.push({ type: 'recovered', description: `all five uploaded ${((Date.now() - backAt) / 1000).toFixed(1)} s after reconnecting` })
  expect(done.filter((r) => GONE_WRONG.includes(r.status))).toEqual([])

  // Each of the first three sent its part again (the part ladder), and the retry was answered.
  const first = calls.puts.slice(0, 3)
  for (const put of first) {
    const attempts = calls.puts.filter((p) => p.uploadId === put.uploadId && p.partNumber === put.partNumber)
    expect(attempts.length, `PUTs of ${put.uploadId}`).toBeGreaterThanOrEqual(2)
    expect(attempts[0].status).not.toBe(200)
    expect(attempts[attempts.length - 1].status).toBe(200)
  }
  // The queue waited and then ran: every file was created once, and the two behind started only once the
  // connection was back (a place came free), not while the parts of the others were failing.
  expect(initiatesOf(calls, files).map((c) => c.file).sort()).toEqual(files.map((f) => f.fileName).sort())
  expect(initiatesOf(calls, files.slice(3)).every((c) => c.at >= backAt)).toBe(true)
  expect(calls.aborts).toEqual([])
  await expect.poll(() => assetNames(project.id), { timeout: 60_000 }).toHaveLength(5)
})
