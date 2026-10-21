import type { Page, Request, Route } from '@playwright/test'

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

/** Bytes in a part PUT's body, from whichever source this engine offers. */
async function bodyBytes(page: Page, request: Request): Promise<number> {
  const buffered = request.postDataBuffer()
  if (buffered) return buffered.length
  const declared = Number(request.headers()['content-length'])
  if (Number.isFinite(declared) && declared > 0) return declared
  const u = new URL(request.url())
  const key = `${u.searchParams.get('uploadId')}:${u.searchParams.get('partNumber')}`
  return page.evaluate((k) => (window as any).__e2ePartSizes?.[k] ?? 0, key).catch(() => 0)
}

/**
 * Delay every part PUT by its body size over `bytesPerSec`, so a transfer takes
 * the time a slow link would. Each PUT is held, then sent: parts run in
 * parallel, so the link modelled is one that is slow per request.
 */
export async function throttleParts(page: Page, bytesPerSec: number): Promise<void> {
  await recordPartSizes(page)
  await page.route(partUrl, async (route: Route, request: Request) => {
    if (!isPartPut(request)) return route.fallback()
    const bytes = await bodyBytes(page, request)
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
 * Never answer a part PUT. The request stays open until the page closes or the
 * page's own code aborts it, which is what a stalled connection looks like.
 */
export async function hangParts(page: Page): Promise<void> {
  await page.route(partUrl, async (route: Route, request: Request) => {
    if (!isPartPut(request)) return route.fallback()
    // Deliberately neither fulfilled, continued nor aborted.
  })
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
