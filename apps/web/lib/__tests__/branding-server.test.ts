/**
 * The server-side branding read must never throw.
 *
 * It runs in two places that cannot tolerate an exception: inside the root
 * layout, where throwing replaces the whole page with an error, and during
 * `next build`, where there is usually no API listening at all. Every failure
 * has to come back as `null`, which puts the app back on the behaviour it had
 * before this existed -- the browser fetches branding after mount.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchServerBranding } from '../branding-server'

const OK_BODY = {
  id: 'b1',
  org_name: 'Northwind Studios',
  primary_color: '#ed7d21',
  powered_by_freeframe: false,
}

beforeEach(() => vi.restoreAllMocks())
afterEach(() => vi.unstubAllGlobals())

describe('reading branding on the server', () => {
  it('returns the row when the API answers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => OK_BODY })))

    await expect(fetchServerBranding()).resolves.toMatchObject({
      org_name: 'Northwind Studios',
      powered_by_freeframe: false,
    })
  })

  it('returns null rather than throwing when the API refuses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })))

    await expect(fetchServerBranding()).resolves.toBeNull()
  })

  it('returns null when the API cannot be reached at all', async () => {
    // `next build` with nothing listening, or a web container that cannot see
    // the API. Neither may fail the build or the request.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))

    await expect(fetchServerBranding()).resolves.toBeNull()
  })

  it('returns null when the request times out', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('timeout', 'TimeoutError') }))

    await expect(fetchServerBranding()).resolves.toBeNull()
  })

  it('returns null when the body is not JSON', async () => {
    // A proxy answering 200 with an HTML error page is the realistic shape here.
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => { throw new SyntaxError('Unexpected token <') },
    })))

    await expect(fetchServerBranding()).resolves.toBeNull()
  })

  it('asks the API for the branding route, with a timeout attached', async () => {
    // The timeout is what stops a hung API holding every page render open.
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => OK_BODY }))
    vi.stubGlobal('fetch', fetchMock)

    await fetchServerBranding()

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toMatch(/\/instance\/branding$/)
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })
})
