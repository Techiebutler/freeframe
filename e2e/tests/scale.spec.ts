import { expect, test, type Page } from '@playwright/test'
import { secondary } from '../fixtures/accounts'
import {
  assetNames, count, FINISHED_UPLOADING, initiatesOf, mineOf, openCleanProject, pngs, recordUploadCalls, removeScenarioFiles, summary,
} from '../fixtures/scenario'
import { apiUrl, dropFiles, openUploads, rows } from '../fixtures/stack'

/**
 * A large drop (SCENARIOS.md: Q2): 300 files of 200 KB, dropped with the
 * uploads panel open. Every file uploads, and the page stays responsive while
 * it does: in Chromium no main-thread long task of the run (drop to the last
 * row Ready) lasts more than 200 ms, as a `PerformanceObserver` of type
 * `longtask` sees it. WebKit has no long-task entries, so there it asserts
 * completion only.
 *
 * Signed in as `secondary`: the panel also lists the account's earlier uploads
 * from the server, and primary has thousands from the other specs, while
 * secondary has few, so the 300 rows are this drop's. It also keeps this
 * test's reads off primary's share of the API's per-account read limit.
 *
 * It also records every request the page makes to the API, and fails on any
 * that was refused: a 429 (the per-account limit of 600 reads a minute) has no
 * CORS header, so Chromium reports it as a failed request, `net::ERR_FAILED`.
 * And the grid has to catch up: its last read of the project's assets returns
 * all 300. Before APP-BUG-3's fix this drop read the API over 2 000 times in
 * 25 s and was refused for the rest of the minute; before APP-BUG-4's, every
 * status move re-rendered the whole project page and long tasks reached
 * 200 to 270 ms (SCENARIOS.md, Phase 6).
 *
 * The test reads the panel once a second, not every 250 ms like the others:
 * reading 300 rows is the test's own work on the page's main thread, and it
 * should not be what the long-task check measures.
 */

const KB = 1024
const FILES = 300
const FILE_BYTES = 200 * KB
/** The longest main-thread task the run may have, in ms (SCENARIOS.md Q2). */
const LONG_TASK_BOUND_MS = 200

test.afterEach(() => removeScenarioFiles())

/** Rows that are no longer going to upload without somebody doing something. */
const GONE_WRONG = ['failed', 'interrupted', 'cancelled', 'elsewhere']

/**
 * Every long task the page's main thread runs, from its first document on,
 * kept on `window.__e2eLongTasks` with its start (on the page's
 * `performance.now()` clock) and duration. Installed before any page loads.
 * Engines without `longtask` entries (WebKit) record nothing and say so on
 * `window.__e2eLongTaskSupported`.
 */
async function observeLongTasks(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as any
    w.__e2eLongTasks = []
    w.__e2eLongTaskSupported = (PerformanceObserver.supportedEntryTypes ?? []).includes('longtask')
    if (!w.__e2eLongTaskSupported) return
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__e2eLongTasks.push({ start: e.startTime, duration: e.duration })
    }).observe({ type: 'longtask', buffered: true })
    // What ran in the long frames (Long Animation Frames, Chromium): for naming the culprit when the check fails.
    w.__e2eLongFrames = []
    if (!(PerformanceObserver.supportedEntryTypes ?? []).includes('long-animation-frame')) return
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as any[]) {
        if (e.duration < 150) continue
        w.__e2eLongFrames.push({
          start: e.startTime,
          duration: e.duration,
          render: e.renderStart ? e.startTime + e.duration - e.renderStart : 0,
          scripts: (e.scripts ?? []).map((x: any) => ({
            duration: Math.round(x.duration),
            what: `${x.invokerType}:${x.invoker} ${x.sourceFunctionName || ''} ${String(x.sourceURL || '').split('/').slice(-1)[0]}`.trim(),
          })),
        })
      }
    }).observe({ type: 'long-animation-frame', buffered: true })
  })
}

type LongTask = { start: number; duration: number }
type LongFrame = LongTask & { render: number; scripts: Array<{ duration: number; what: string }> }
const longTasks = (page: Page) =>
  page.evaluate(() => ({
    supported: (window as any).__e2eLongTaskSupported as boolean,
    tasks: ((window as any).__e2eLongTasks ?? []) as LongTask[],
    frames: ((window as any).__e2eLongFrames ?? []) as LongFrame[],
  }))
const pageNow = (page: Page) => page.evaluate(() => performance.now())

/**
 * Every request the page sends to the API, by method and path (ids folded to
 * `:id`), with its time, and how many came back 429 (the per-account limit).
 * Uploads (`/upload/...`) are exempt from that limit; everything else counts,
 * reads against 600 a minute.
 */
function recordApiTraffic(page: Page, projectId: string) {
  const api = apiUrl()
  const calls: Array<{ method: string; path: string; at: number }> = []
  /** Requests that got no usable answer, by status or error text. A 429 has no CORS header, so Chromium reports it as a failed request. */
  const refused = new Map<string, number>()
  let aborted = 0
  const note = (what: string) => refused.set(what, (refused.get(what) ?? 0) + 1)
  /** Each read of the grid (the project's root assets) that settled, in order: its status or error, and how many assets it returned. */
  const gridReads: Array<{ at: number; outcome: string; assets: number | null }> = []
  const isGridRead = (url: string) => url.startsWith(`${api}/projects/${projectId}/assets?`)
  page.on('request', (r) => {
    if (!r.url().startsWith(api)) return
    const path = new URL(r.url()).pathname.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ':id')
    calls.push({ method: r.method(), path, at: Date.now() })
  })
  page.on('response', async (r) => {
    if (!r.url().startsWith(api)) return
    if (r.status() >= 400) note(String(r.status()))
    if (r.request().method() !== 'GET' || !isGridRead(r.url())) return
    const at = Date.now()
    const body = r.status() === 200 ? await r.json().catch(() => null) : null
    gridReads.push({ at, outcome: String(r.status()), assets: Array.isArray(body) ? body.length : null })
  })
  page.on('requestfailed', (r) => {
    if (!r.url().startsWith(api)) return
    const error = r.failure()?.errorText ?? 'failed'
    // The page's own cancellations (an event stream it closes, a read SWR replaces) are not refusals.
    if (/ERR_ABORTED|cancelled/i.test(error)) { aborted += 1; return }
    note(error)
    if (r.method() === 'GET' && isGridRead(r.url())) gridReads.push({ at: Date.now(), outcome: error, assets: null })
  })
  return {
    calls,
    gridReads,
    /** Requests the page itself cancelled. */
    aborted: () => aborted,
    /** "429 x n; net::ERR_FAILED x m", or "" when every request was answered. */
    refused: () => [...refused.entries()].map(([k, v]) => `${k} x ${v}`).join('; '),
    /** The most rate-limited reads (GETs outside `/upload/`) in any 60 s window. */
    peakReadsPerMinute: () => {
      const reads = calls.filter((c) => c.method === 'GET' && !c.path.startsWith('/upload/')).map((c) => c.at)
      let peak = 0
      for (let i = 0, j = 0; i < reads.length; i += 1) {
        while (reads[i] - reads[j] >= 60_000) j += 1
        peak = Math.max(peak, i - j + 1)
      }
      return peak
    },
    /** The busiest request kinds, "GET /path x n". */
    top: (n: number) => {
      const by = new Map<string, number>()
      for (const c of calls) by.set(`${c.method} ${c.path}`, (by.get(`${c.method} ${c.path}`) ?? 0) + 1)
      return [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} x ${v}`)
    },
  }
}

test('Q2: 300 files of 200 KB dropped with the panel open all upload, with no main-thread task over 200 ms', async ({ page, browserName }, testInfo) => {
  test.setTimeout(20 * 60_000)
  await observeLongTasks(page)
  const account = await secondary()
  const { project } = await openCleanProject(page, 'Q2', account)
  const files = await pngs('q2', Array(FILES).fill(FILE_BYTES))
  await openUploads(page)

  const calls = recordUploadCalls(page)
  const traffic = recordApiTraffic(page, project.id)
  const startedAt = Date.now()
  const runStart = await pageNow(page)
  await dropFiles(page, 'project', files.map((f) => f.file))

  // Once a second until every row is Ready: never more than three files moving, and none gone wrong.
  let peakMoving = 0
  let allUploadedAt = 0
  const wrong: string[] = []
  const deadline = Date.now() + 15 * 60_000
  for (;;) {
    const mine = mineOf(await rows(page), files)
    const moving = count(mine, 'starting', 'uploading')
    peakMoving = Math.max(peakMoving, moving)
    wrong.push(...mine.filter((r) => GONE_WRONG.includes(r.status)).map((r) => summary([r])))
    if (!allUploadedAt && mine.length === FILES && count(mine, ...FINISHED_UPLOADING) === FILES) allUploadedAt = Date.now()
    if (mine.length === FILES && count(mine, 'complete') === FILES) break
    if (Date.now() > deadline) {
      const by = [...new Set(mine.map((r) => r.status))].map((s) => `${s} ${count(mine, s)}`).join(', ')
      throw new Error(`Q2 did not finish in 15 min: ${mine.length} rows (${by}); API refused: ${traffic.refused() || 'none'}`)
    }
    await page.waitForTimeout(1_000)
  }
  const runEnd = await pageNow(page)
  const doneAt = Date.now()
  // The grid catches up: its last read of the project's assets, once reads settle, returned all of them.
  // Nothing refetches it on its own after the last row is Ready, so a last read that was refused leaves it short.
  const lastGridRead = async () => {
    await page.waitForTimeout(1_000)
    const last = traffic.gridReads[traffic.gridReads.length - 1]
    return last ? `${last.outcome}/${last.assets}` : 'none'
  }
  const gridSettled = await expect.poll(lastGridRead, { timeout: 30_000 }).toBe(`200/${FILES}`).then(() => '', (e) => String(e).split('\n')[0])

  // What the run cost the API, for the record (and for the read limit; see the README's Traps).
  const reads = traffic.calls.filter((c) => c.method === 'GET' && !c.path.startsWith('/upload/')).length
  testInfo.annotations.push(
    { type: 'timing', description: `${FILES} uploaded in ${((allUploadedAt - startedAt) / 1000).toFixed(1)} s, all Ready in ${((doneAt - startedAt) / 1000).toFixed(1)} s; at most ${peakMoving} rows Starting or Uploading at a sample` },
    { type: 'api', description: `${traffic.calls.length} API requests, ${reads} rate-limited reads (peak ${traffic.peakReadsPerMinute()} in a 60 s window, limit 600), refused: ${traffic.refused() || 'none'}, cancelled by the page: ${traffic.aborted()}; busiest: ${traffic.top(6).join('; ')}` },
  )

  for (const a of testInfo.annotations) console.log(`Q2 ${browserName} ${a.type}: ${a.description}`)
  console.log(`Q2 ${browserName} grid reads: ${traffic.gridReads.length}, last 5: ${traffic.gridReads.slice(-5).map((g) => `${g.outcome}${g.assets === null ? '' : `/${g.assets}`} at +${((g.at - startedAt) / 1000).toFixed(1)} s`).join(', ')}`)

  expect(gridSettled, `the grid's last read of the project's assets returned all ${FILES}`).toBe('')
  expect(traffic.refused(), 'API requests refused or failed during the run (a 429 is the per-account read limit)').toBe('')
  expect(wrong, 'rows that failed, were interrupted, cancelled or shown as elsewhere during the run').toEqual([])
  expect(peakMoving, 'rows Starting or Uploading at once').toBeLessThanOrEqual(3)
  // Each file was created once.
  expect(initiatesOf(calls, files).filter((c) => c.status === 200)).toHaveLength(FILES)
  await expect.poll(async () => (await assetNames(project.id, account)).length, { timeout: 60_000 }).toBe(FILES)

  // The page stayed responsive: no long task of the run over the bound.
  const { supported, tasks, frames } = await longTasks(page)
  if (browserName === 'chromium') expect(supported, 'Chromium reports long tasks').toBe(true)
  if (!supported) {
    testInfo.annotations.push({ type: 'long tasks', description: `not reported by ${browserName}; completion only` })
    return
  }
  const during = tasks.filter((t) => t.start + t.duration >= runStart && t.start <= runEnd)
  const worst = [...during].sort((a, b) => b.duration - a.duration)
  testInfo.annotations.push({
    type: 'long tasks',
    description: `${during.length} over 50 ms during the ${((runEnd - runStart) / 1000).toFixed(1)} s run; longest ${worst.slice(0, 5).map((t) => `${Math.round(t.duration)} ms at +${((t.start - runStart) / 1000).toFixed(1)} s`).join(', ') || 'none'}`,
  })
  for (const f of frames.filter((f) => f.start + f.duration >= runStart && f.start <= runEnd && f.duration > LONG_TASK_BOUND_MS)) {
    const scripts = f.scripts.sort((a, b) => b.duration - a.duration).slice(0, 4).map((x) => `${x.duration} ms ${x.what}`).join(' | ')
    testInfo.annotations.push({ type: 'long frame', description: `${Math.round(f.duration)} ms at +${((f.start - runStart) / 1000).toFixed(1)} s (render ${Math.round(f.render)} ms): ${scripts}` })
    console.log(`Q2 ${browserName} long frame: ${Math.round(f.duration)} ms at +${((f.start - runStart) / 1000).toFixed(1)} s (render/layout ${Math.round(f.render)} ms): ${scripts}`)
  }
  console.log(`Q2 ${browserName} long tasks: ${testInfo.annotations.find((a) => a.type === 'long tasks')?.description}`)
  expect(worst.filter((t) => t.duration > LONG_TASK_BOUND_MS).map((t) => `${Math.round(t.duration)} ms at +${((t.start - runStart) / 1000).toFixed(1)} s`), `main-thread tasks over ${LONG_TASK_BOUND_MS} ms`).toEqual([])
})
