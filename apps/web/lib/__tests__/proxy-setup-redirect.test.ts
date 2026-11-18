/**
 * The proxy sends a fresh install to /setup by asking the API whether setup is
 * needed. That call runs on the server, so it has to use the address of the API
 * from inside the web container (API_INTERNAL_URL). NEXT_PUBLIC_API_URL is the
 * browser's address and is the relative path `/api` in the production image,
 * which a server-side fetch cannot resolve; the check then failed quietly and
 * the redirect never happened.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('proxy setup redirect', () => {
  it('asks the internal API address and redirects to /setup when setup is needed', async () => {
    vi.stubEnv('API_INTERNAL_URL', 'http://api:8000')
    vi.stubEnv('NEXT_PUBLIC_API_URL', '/api')
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ needs_setup: true }),
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.resetModules()
    const { proxy } = await import('../../proxy')

    const res = await proxy(new NextRequest('http://localhost:3000/projects'))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('http://api:8000/setup/status')
    expect(res.status).toBe(307)
    expect(new URL(res.headers.get('location')!).pathname).toBe('/setup')
  })

  it('gives up on a slow API after 2 seconds and lets the request through', async () => {
    // A migrating or overloaded API must not hold navigation: the check is
    // abandoned after 2 seconds, as if the API were unreachable.
    vi.stubEnv('API_INTERNAL_URL', 'http://api:8000')
    const timer = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timer.signal)
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation timed out.', 'TimeoutError')),
          )
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    vi.resetModules()
    const { proxy } = await import('../../proxy')

    const pending = proxy(new NextRequest('http://localhost:3000/projects'))
    expect(timeout).toHaveBeenCalledWith(2000)
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(timer.signal)
    timer.abort()
    const res = await pending

    // Through to the normal auth check: no tokens, so the login page.
    expect(res.status).toBe(307)
    const location = new URL(res.headers.get('location')!)
    expect(location.pathname).toBe('/login')
    expect(location.searchParams.get('from')).toBe('/projects')
    expect(res.cookies.get('ff_setup_done')).toBeUndefined()
  })
})
