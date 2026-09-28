import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({
  redirect: vi.fn(),
}))

vi.mock('next/navigation', () => ({ redirect: h.redirect }))

import ShortCodePage from '../[code]/page'
import { ShareErrorState } from '@/components/share/share-error-state'

function responseWithLocation(location: string | null) {
  return {
    status: location ? 302 : 404,
    headers: { get: (name: string) => (name.toLowerCase() === 'location' ? location : null) },
  } as unknown as Response
}

describe('ShortCodePage (/s/[code])', () => {
  beforeEach(() => {
    h.redirect.mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('sends the visitor on to the share page a known code resolves to', async () => {
    const fetchMock = vi.fn().mockResolvedValue(responseWithLocation('/share/tok123'))
    vi.stubGlobal('fetch', fetchMock)

    await ShortCodePage({ params: { code: 'AbC12345' } })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(h.redirect).toHaveBeenCalledWith('/share/tok123')
  })

  it('shows the share page not-found state for an unknown code (not /login)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(responseWithLocation(null)))

    const result = await ShortCodePage({ params: { code: 'zzzzzzzz' } })

    expect(h.redirect).not.toHaveBeenCalled()
    expect((result as { type: unknown }).type).toBe(ShareErrorState)
  })

  it('logs and shows not-found when the API lookup fails', async () => {
    const error = new Error('connection refused')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await ShortCodePage({ params: { code: 'AbC12345' } })

    expect(errorSpy).toHaveBeenCalled()
    expect(h.redirect).not.toHaveBeenCalled()
    expect((result as { type: unknown }).type).toBe(ShareErrorState)
  })

  it('does not call the API for a path that cannot be a code', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await ShortCodePage({ params: { code: 'not-a-code!!' } })

    expect(fetchMock).not.toHaveBeenCalled()
    expect((result as { type: unknown }).type).toBe(ShareErrorState)
  })
})
