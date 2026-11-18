import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { BrowserContext, Page, Request, Route } from '@playwright/test'
import { baseUrl } from './env'

/**
 * Fault injection for the upload path, built on `page.route`.
 *
 * Every helper applies to one page, composes with the others (a request it
 * does not handle is passed down with `route.fallback()`), and lasts until the
 * page closes. The most recently added helper sees a request first.
 *
 * A part PUT is the browser's `PUT` of one chunk to a presigned S3 URL, which
 * always carries `partNumber` and `uploadId` in its query string.
 */

const isPartPut = (r: Request) => r.method() === 'PUT' && /[?&]partNumber=\d+/.test(r.url())
const partUrl = (url: URL) => url.searchParams.has('partNumber') && url.searchParams.has('uploadId')

/** `POST /upload/initiate`, and `POST /assets/{id}/versions` (a new version initiates the same way). */
const isInitiate = (r: Request) =>
  r.method() === 'POST' && /\/(upload\/initiate|assets\/[^/]+\/versions)(\?|$)/.test(r.url())
const initiateUrl = (url: URL) => /\/(upload\/initiate|assets\/[^/]+\/versions)$/.test(url.pathname)

/**
 * Headers that let the page read a response this file made up. The page is on
 * another origin than the API and the bucket, so without them the browser
 * reports a network error instead of the status we are trying to inject.
 */
function corsHeaders(request: Request, exposed: string[] = []): Record<string, string> {
  return {
    'access-control-allow-origin': request.headers()['origin'] ?? '*',
    'access-control-expose-headers': ['ETag', ...exposed].join(', '),
    vary: 'Origin',
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Records, in the page, how many bytes each part PUT sends.
 *
 * Playwright shows a request's body to a route handler only when the engine
 * lets it, and WebKit does not for the Blob an XHR sends (no `postData`, no
 * `content-length`). The page always knows, so a patched `XMLHttpRequest.send`
 * keeps the sizes where a handler can ask for them.
 */
async function recordPartSizes(page: Page): Promise<void> {
  const install = () => {
    const w = window as any
    if (w.__e2eSizeProbe) return
    w.__e2eSizeProbe = true
    w.__e2ePartSizes = {} as Record<string, number>
    const open = XMLHttpRequest.prototype.open
    const send = XMLHttpRequest.prototype.send
    ;(XMLHttpRequest.prototype as any).open = function (this: any, method: string, url: string | URL, ...rest: any[]) {
      this.__e2eUrl = String(url)
      return (open as any).call(this, method, url, ...rest)
    }
    XMLHttpRequest.prototype.send = function (this: any, body?: any) {
      try {
        const u = new URL(this.__e2eUrl, location.href)
        const size = typeof body === 'string' ? body.length : body && typeof body.size === 'number' ? body.size : body?.byteLength
        if (u.searchParams.has('partNumber') && typeof size === 'number') {
          w.__e2ePartSizes[`${u.searchParams.get('uploadId')}:${u.searchParams.get('partNumber')}`] = size
        }
      } catch {
        /* never let the probe break an upload */
      }
      return send.call(this, body)
    }
  }
  await page.addInitScript(install) // every later navigation
  await page.evaluate(install).catch(() => {}) // the page that is already open, if any
}

/**
 * Bytes in a part PUT's body, from whichever source this engine offers.
 *
 * Throws when none of them knows the size (or it is zero). `throttleParts`
 * needs it to compute a delay, and a part passed through undelayed would make
 * every scenario built on a throttle pass without a slow transfer ever having
 * happened. A throw inside a route handler fails the running test at once.
 */
export async function partBodyBytes(page: Page, request: Request): Promise<number> {
  const buffered = request.postDataBuffer()
  let bytes = buffered ? buffered.length : 0
  if (!bytes) {
    const declared = Number(request.headers()['content-length'])
    if (Number.isFinite(declared)) bytes = declared
  }
  if (!bytes) {
    const u = new URL(request.url())
    const key = `${u.searchParams.get('uploadId')}:${u.searchParams.get('partNumber')}`
    bytes = await page.evaluate((k) => (window as any).__e2ePartSizes?.[k] ?? 0, key).catch(() => 0)
  }
  if (!(bytes > 0)) {
    throw new Error(
      `throttleParts: cannot determine the size of the body of ${request.method()} ${request.url().split('?')[0]}` +
        ' (no postData, no content-length, and the page recorded none), so it cannot be throttled.' +
        ' Passing it through unthrottled would make the scenario pass without a slow transfer.',
    )
  }
  return bytes
}

/**
 * Delay every part PUT by its body size over `bytesPerSec`, so a transfer takes
 * the time a slow link would. Each PUT is held, then sent: parts run in
 * parallel, so the link modelled is one that is slow per request.
 *
 * A part whose size cannot be determined fails the test (see `partBodyBytes`)
 * rather than going through unthrottled.
 */
export async function throttleParts(page: Page, bytesPerSec: number): Promise<void> {
  await recordPartSizes(page)
  await page.route(partUrl, async (route: Route, request: Request) => {
    if (!isPartPut(request)) return route.fallback()
    const bytes = await partBodyBytes(page, request)
    await sleep((bytes / bytesPerSec) * 1000)
    await route.fallback()
  })
}

/**
 * Answer part PUTs with `status` and an empty body, for the next `times` of
 * them (every one when omitted). The part never reaches the bucket.
 */
export async function failParts(page: Page, status: number, times = Infinity): Promise<void> {
  let left = times
  await page.route(partUrl, async (route: Route, request: Request) => {
    if (!isPartPut(request) || left <= 0) return route.fallback()
    left -= 1
    await route.fulfill({ status, headers: corsHeaders(request), body: '' })
  })
}

/**
 * Narrows a fault to some of the part PUTs: it gets the PUT's URL (the presigned
 * one, whose path ends in the upload's S3 key and whose query carries `uploadId`
 * and `partNumber`) and says whether the fault applies. May be async, so a
 * scenario can wait for the initiate answer that tells it which key is its file's
 * (see `trackUploads`).
 */
export type PartFilter = (url: URL) => boolean | Promise<boolean>

/** Which part PUTs a fault applies to, and for how many of them (every match when `times` is omitted). */
export type PartFaultScope = { only?: PartFilter; times?: number }

/**
 * Never answer a part PUT. The request stays open until the page closes or the
 * page's own code aborts it, which is what a stalled connection looks like.
 *
 * `only` limits it to the PUTs it accepts (one file's, say), and `times` to the
 * first that many of those; every other PUT, and every one after them, goes
 * through untouched. So `{ times: 3 }` hangs three parts once and lets their
 * retries through, which is how a watchdog that aborts and retries is seen to
 * work.
 */
export async function hangParts(page: Page, scope: PartFaultScope = {}): Promise<void> {
  let left = scope.times ?? Infinity
  await page.route(partUrl, async (route: Route, request: Request) => {
    if (!isPartPut(request) || left <= 0) return route.fallback()
    if (scope.only && !(await scope.only(new URL(request.url())))) return route.fallback()
    // Re-checked after the wait: another PUT may have used the last of `times` meanwhile.
    if (left <= 0) return route.fallback()
    left -= 1
    // Deliberately neither fulfilled, continued nor aborted.
  })
}

/**
 * What the page told the API about the uploads it started: for each file (by
 * its original file name) the S3 key, multipart upload id and version id the
 * initiate answered with.
 */
export type UploadTracker = {
  /** Resolves with the ids of the upload started for `fileName`, once the initiate for it is answered. */
  of: (fileName: string) => Promise<{ s3Key: string; uploadId: string; versionId: string | null }>
  /** A `PartFilter` for the PUTs of `fileName`'s upload: the presigned URL's path is that upload's S3 key. */
  partsOf: (fileName: string) => PartFilter
}

/**
 * Watch initiate answers on `page`, so a fault can be aimed at one file's
 * parts. Call it before the file is dropped. A part PUT only happens after the
 * initiate that created its upload was answered, so a filter built with
 * `partsOf` always finds the key it is waiting for.
 */
export function trackUploads(page: Page): UploadTracker {
  type Ids = { s3Key: string; uploadId: string; versionId: string | null }
  const seen = new Map<string, Ids>()
  const waiting = new Map<string, Array<(ids: Ids) => void>>()
  page.on('response', async (response) => {
    const request = response.request()
    if (request.method() !== 'POST' || !/\/(upload\/initiate|assets\/[^/]+\/versions)(\?|$)/.test(response.url())) return
    if (response.status() !== 200) return
    try {
      const fileName = String((request.postDataJSON() as Record<string, unknown>)?.original_filename ?? '')
      const answer = (await response.json()) as { s3_key?: string; upload_id?: string; version_id?: string }
      if (!fileName || !answer.s3_key || !answer.upload_id) return
      const ids = { s3Key: answer.s3_key, uploadId: answer.upload_id, versionId: answer.version_id ?? null }
      seen.set(fileName, ids)
      for (const resolve of waiting.get(fileName) ?? []) resolve(ids)
      waiting.delete(fileName)
    } catch {
      /* a response that is gone (the page closed) is no initiate answer */
    }
  })
  const of = (fileName: string) =>
    new Promise<Ids>((resolve) => {
      const known = seen.get(fileName)
      if (known) resolve(known)
      else waiting.set(fileName, [...(waiting.get(fileName) ?? []), resolve])
    })
  return {
    of,
    partsOf: (fileName) => async (url) => decodeURIComponent(url.pathname).includes((await of(fileName)).s3Key),
  }
}

/**
 * Let a part PUT start for real, then stop it dead after the first stretch of
 * its body: the part makes progress (the browser's upload events fire, a few
 * hundred KB to a few MB of them) and then nothing more happens and no answer
 * comes. This is a connection that dies in the middle of a part, which `hangParts`
 * (nothing is ever sent, so no progress event is ever fired) cannot be.
 *
 * The PUT is sent to a throwaway server on 127.0.0.1 that reads the first
 * `readBytes` and then stops reading. The browser fills the sockets in between
 * and reports progress on the way. The part has to be bigger than they hold
 * (10 MB is, on Chromium and WebKit: 1 to 3 MB are accepted before the stall),
 * or the browser reports it fully sent and then waits for an answer, which is a
 * different case with a different clock.
 *
 * `only` and `times` pick which PUTs, as for `hangParts`; the rest, and every
 * retry after `times` are used up, go to the real bucket. `stalled()` is how
 * many PUTs reached the server, `partNumbers()` which parts they were (in the
 * order they were stalled) and `bytesRead()` how much of them it took.
 * `stop()` closes the server; it also closes with the page.
 */
export async function stallParts(
  page: Page,
  scope: PartFaultScope & { readBytes?: number } = {},
): Promise<{ stalled: () => number; partNumbers: () => number[]; bytesRead: () => number; stop: () => void }> {
  const readBytes = scope.readBytes ?? 256 * 1024
  let stalled = 0
  let read = 0
  const parts: number[] = []
  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': req.headers.origin ?? '*',
        'access-control-allow-methods': 'PUT, OPTIONS',
        'access-control-allow-headers': req.headers['access-control-request-headers'] ?? '*',
        vary: 'Origin',
      })
      res.end()
      return
    }
    stalled += 1
    let mine = 0
    req.on('data', (chunk: Buffer) => {
      mine += chunk.length
      read += chunk.length
      if (mine >= readBytes) req.pause() // stop reading; never answer
    })
    req.on('error', () => {})
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const stop = () => {
    server.closeAllConnections()
    server.close()
  }
  page.on('close', stop)

  let left = scope.times ?? Infinity
  await page.route(partUrl, async (route: Route, request: Request) => {
    if (!isPartPut(request) || left <= 0) return route.fallback()
    if (scope.only && !(await scope.only(new URL(request.url())))) return route.fallback()
    if (left <= 0) return route.fallback()
    left -= 1
    parts.push(Number(new URL(request.url()).searchParams.get('partNumber')))
    // Same path and query (the signature is for the real bucket and does not matter here), another host.
    await route.continue({ url: `http://127.0.0.1:${port}/stalled${new URL(request.url()).search}` })
  })
  return { stalled: () => stalled, partNumbers: () => [...parts], bytesRead: () => read, stop }
}

/**
 * Hold every part PUT until `release()` is called, then let all of them (the
 * held ones and every later one) through untouched.
 *
 * What `hangParts` is when it is never released, and a way to freeze a queue in
 * a known state: the files that started sit in "Uploading" with their parts on
 * hold, the rest wait, and the scenario can act, then let the run go on.
 * `held()` is how many part PUTs have reached the hold so far. `only` limits the
 * hold to the PUTs it accepts (one file's, say). The hold ends
 * with the page: do not keep one for longer than the app's part watchdog (90 s
 * with the whole tab silent), or the app aborts the held parts and retries them
 * itself.
 */
export async function holdParts(
  page: Page,
  scope: Pick<PartFaultScope, 'only'> = {},
): Promise<{ release: () => void; held: () => number }> {
  let open = false
  let held = 0
  let waiting: Array<() => void> = []
  await page.route(partUrl, async (route: Route, request: Request) => {
    if (!isPartPut(request)) return route.fallback()
    if (scope.only && !(await scope.only(new URL(request.url())))) return route.fallback()
    if (!open) {
      held += 1
      await new Promise<void>((resolve) => waiting.push(resolve))
    }
    // The page may have given up on this request while it was held (a Cancel
    // aborts it), and a request that is gone cannot be continued.
    await route.fallback().catch(() => {})
  })
  return {
    release: () => {
      open = true
      const go = waiting
      waiting = []
      for (const resolve of go) resolve()
    },
    held: () => held,
  }
}

/**
 * Answer the next `times` initiate calls (every one when omitted) with `reply`
 * instead of asking the API. `body` is sent as JSON.
 */
export async function failInitiate(
  page: Page,
  reply: { status: number; body: unknown; headers?: Record<string, string> },
  times = Infinity,
): Promise<void> {
  let left = times
  await page.route(initiateUrl, async (route: Route, request: Request) => {
    if (!isInitiate(request) || left <= 0) return route.fallback()
    left -= 1
    const extra = reply.headers ?? {}
    await route.fulfill({
      status: reply.status,
      headers: {
        'content-type': 'application/json',
        ...corsHeaders(request, Object.keys(extra)),
        ...extra,
      },
      body: JSON.stringify(reply.body),
    })
  })
}

/**
 * Count the requests the page starts whose URL matches `pattern`. Counts as
 * they begin, so a request still in flight, or answered by another helper in
 * this file, is counted too. Does not touch the traffic.
 */
export function countRequests(page: Page, pattern: RegExp): { count: () => number } {
  let n = 0
  page.on('request', (request) => {
    if (pattern.test(request.url())) n += 1
  })
  return { count: () => n }
}

/**
 * Take the browser's network away and give it back: every request to the API and
 * to the bucket fails the way a dropped connection does, and files on disk stay
 * readable.
 *
 * Chromium and Firefox use `context.setOffline`. In Playwright's WebKit that
 * switch fails more than the network: a file-backed `Blob` cannot be read while
 * it is on (`file.slice(0, 1).arrayBuffer()` rejects with `NotReadableError`;
 * measured, WebKit 26.4 / Playwright 1.59), which no browser does when the wifi
 * goes, and which the app rightly reads as a file that changed. So WebKit gets
 * the same outage from a route that aborts, as "internet disconnected", every
 * http(s) request to an origin other than the app's.
 *
 * `down()` and `up()` may be called any number of times.
 */
export function networkSwitch(context: BrowserContext, browserName: string): { down: () => Promise<void>; up: () => Promise<void> } {
  const appOrigin = new URL(baseUrl()).origin
  const isOtherOrigin = (url: URL) => /^https?:$/.test(url.protocol) && url.origin !== appOrigin
  const cut = (route: Route) => route.abort('internetdisconnected')
  let routed = false
  return {
    down: async () => {
      if (browserName !== 'webkit') return context.setOffline(true)
      if (routed) return
      routed = true
      await context.route(isOtherOrigin, cut)
    },
    up: async () => {
      if (browserName !== 'webkit') return context.setOffline(false)
      if (!routed) return
      routed = false
      await context.unroute(isOtherOrigin, cut)
    },
  }
}
