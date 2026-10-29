import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({
  redirect: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND')
  }),
  headers: vi.fn(),
}))

vi.mock('next/navigation', () => ({ redirect: h.redirect, notFound: h.notFound }))
vi.mock('next/headers', () => ({ headers: h.headers }))

import ShortCodePage from '../[code]/page'
import { ShareErrorState } from '@/components/share/share-error-state'
import { INTERNAL_API_URL } from '@/lib/server-api'

function responseWith(status: number, location: string | null = null) {
  return {
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'location' ? location : null) },
  } as unknown as Response
}

function visitorHeaders(ip = '203.0.113.9') {
  const map = new Map<string, string>([['x-real-ip', ip]])
  return { get: (name: string) => map.get(name.toLowerCase()) ?? null }
}

function render(code = 'AbC12345') {
  return ShortCodePage({ params: Promise.resolve({ code }) })
}

describe('ShortCodePage (/s/[code])', () => {
  beforeEach(() => {
    h.redirect.mockClear()
    h.notFound.mockClear()
    h.headers.mockReset()
    h.headers.mockResolvedValue(visitorHeaders())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('sends the visitor on to the share page a known code resolves to', async () => {
    const fetchMock = vi.fn().mockResolvedValue(responseWith(302, '/share/tok123'))
    vi.stubGlobal('fetch', fetchMock)

    await render()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(h.redirect).toHaveBeenCalledWith('/share/tok123')
  })

  it('forwards the visitor address so the API limit is per visitor, not per web server', async () => {
    const fetchMock = vi.fn().mockResolvedValue(responseWith(302, '/share/tok123'))
    vi.stubGlobal('fetch', fetchMock)

    await render()

    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe(`${INTERNAL_API_URL}/resolve/AbC12345`)
    expect(options.headers).toEqual({ 'x-real-ip': '203.0.113.9' })
    expect(options.signal).toBeInstanceOf(AbortSignal)
    expect(options.cache).toBe('no-store')
    expect(options.redirect).toBe('manual')
  })

  it('falls back to the first x-forwarded-for address when x-real-ip is missing', async () => {
    h.headers.mockResolvedValue({
      get: (name: string) =>
        name.toLowerCase() === 'x-forwarded-for' ? '198.51.100.7, 10.0.0.1' : null,
    })
    const fetchMock = vi.fn().mockResolvedValue(responseWith(302, '/share/tok123'))
    vi.stubGlobal('fetch', fetchMock)

    await render()

    expect(fetchMock.mock.calls[0][1].headers).toEqual({ 'x-real-ip': '198.51.100.7' })
  })

  it('answers a real 404 for an unknown code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(responseWith(404)))

    await expect(render('zzzzzzzz')).rejects.toThrow('NEXT_NOT_FOUND')

    expect(h.notFound).toHaveBeenCalled()
    expect(h.redirect).not.toHaveBeenCalled()
  })

  it('shows the retry screen, not "Link not found", when the API is rate limited', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(responseWith(429)))

    const result = await render()

    expect(errorSpy).toHaveBeenCalled()
    expect(h.notFound).not.toHaveBeenCalled()
    expect(h.redirect).not.toHaveBeenCalled()
    expect((result as { type: unknown }).type).toBe(ShareErrorState)
    expect((result as { props: { unavailable?: boolean } }).props.unavailable).toBe(true)
  })

  it('shows the retry screen when the API is unreachable', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')))

    const result = await render()

    expect(errorSpy).toHaveBeenCalled()
    expect((result as { type: unknown }).type).toBe(ShareErrorState)
    expect((result as { props: { unavailable?: boolean } }).props.unavailable).toBe(true)
  })

  it('treats a 302 without a Location as a temporary failure', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(responseWith(302, null)))

    const result = await render()

    expect(errorSpy).toHaveBeenCalled()
    expect((result as { props: { unavailable?: boolean } }).props.unavailable).toBe(true)
  })

  it('does not call the API for a path that cannot be a code', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(render('not-a-code!!')).rejects.toThrow('NEXT_NOT_FOUND')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(h.notFound).toHaveBeenCalled()
  })
})
