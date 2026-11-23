// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_API_URL', '/api')
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

it('keeps tokens out of browser-readable storage on the same origin', async () => {
  const auth = await import('../auth')
  auth.setTokens('access', 'refresh-that-must-not-be-stored')
  expect(auth.getAccessToken()).toBe('access')
  expect(localStorage.getItem('ff_access_token')).toBeNull()
  expect(localStorage.getItem('ff_refresh_token')).toBeNull()
  expect(document.cookie).not.toMatch(/ff_(access|refresh)_token=/)
})

it('shares a single cookie bootstrap among consumers', async () => {
  const auth = await import('../auth')
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ access_token: 'new-access' })))
  vi.stubGlobal('fetch', fetch)
  expect(await Promise.all([auth.bootstrapSession(), auth.bootstrapSession()])).toEqual([
    { token: 'new-access' }, { token: 'new-access' },
  ])
  expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/auth/refresh', {
    method: 'POST', headers: { 'X-FF-Client': 'web' }, credentials: 'same-origin',
  })
  expect(auth.getAccessToken()).toBe('new-access')
})

it('migrates a legacy body token and removes both storage entries on success', async () => {
  localStorage.setItem('ff_access_token', 'legacy-access')
  localStorage.setItem('ff_refresh_token', 'legacy-refresh')
  const auth = await import('../auth')
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ access_token: 'new-access' })))
  vi.stubGlobal('fetch', fetch)
  expect(await auth.refreshAccessTokenQuietly()).toEqual({ token: 'new-access' })
  expect(fetch.mock.calls[0][1].body).toBe(JSON.stringify({ refresh_token: 'legacy-refresh' }))
  expect(localStorage.getItem('ff_access_token')).toBeNull()
  expect(localStorage.getItem('ff_refresh_token')).toBeNull()
})

it('does not install a late refresh into a new local session', async () => {
  const auth = await import('../auth')
  let respond!: (response: Response) => void
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { respond = resolve })))
  auth.setTokens('first-access', 'legacy-first')
  const pending = auth.refreshAccessTokenQuietly()
  await Promise.resolve()
  auth.setTokens('second-access', 'legacy-second')
  respond(new Response(JSON.stringify({ access_token: 'late-access' })))
  expect(await pending).toEqual({ failed: 'refused' })
  expect(auth.getAccessToken()).toBe('second-access')
})

it('does not switch accounts if the shared cookie answers for a different subject', async () => {
  const auth = await import('../auth')
  const jwt = (sub: string) => `e30.${btoa(JSON.stringify({ sub }))}.sig`
  const alice = jwt('alice')
  auth.setTokens(alice)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ access_token: jwt('bob') })))
  expect(await auth.refreshAccessTokenQuietly()).toEqual({ failed: 'refused' })
  expect(auth.getAccessToken()).toBe(alice)
})

it('does not retry failed cookie refreshes during the transient cooldown', async () => {
  const auth = await import('../auth')
  vi.useFakeTimers()
  const fetch = vi.fn().mockRejectedValue(new TypeError('network'))
  vi.stubGlobal('fetch', fetch)
  auth.setTokens('held-access', 'legacy-refresh')
  expect(await auth.refreshAccessTokenQuietly()).toEqual({ failed: 'transient' })
  expect(await auth.refreshAccessTokenQuietly()).toEqual({ failed: 'transient' })
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(auth.getAccessToken()).toBe('held-access')
  vi.advanceTimersByTime(5000)
  expect(await auth.refreshAccessTokenQuietly()).toEqual({ failed: 'transient' })
  expect(fetch).toHaveBeenCalledTimes(2)
})

it('opts in on same-origin API requests', async () => {
  const { api } = await import('../api')
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetch)
  await api.post('/auth/login', { email: 'reviewer@example.com', password: 'fixture' })
  expect(fetch.mock.calls[0][1].headers).toMatchObject({ 'X-FF-Client': 'web' })
})

it('does not opt a separate API origin into the cookie flow', async () => {
  vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.test')
  const { api } = await import('../api')
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetch)
  await api.post('/auth/login', { email: 'reviewer@example.com', password: 'fixture' })
  expect(fetch.mock.calls[0][1].headers).not.toHaveProperty('X-FF-Client')
})

it('asks the API to clear the HttpOnly cookie before discarding the local session', async () => {
  const auth = await import('../auth')
  let respond!: (response: Response) => void
  const fetch = vi.fn(() => new Promise<Response>(resolve => { respond = resolve }))
  vi.stubGlobal('fetch', fetch)
  auth.setTokens('access')
  const pending = auth.clearTokens()
  await Promise.resolve()
  expect(auth.getAccessToken()).toBe('access')
  expect(fetch).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({
    method: 'POST', credentials: 'same-origin', headers: { 'X-FF-Client': 'web' },
  }))
  respond(new Response(null, { status: 204 }))
  await pending
  expect(auth.getAccessToken()).toBeNull()
})
