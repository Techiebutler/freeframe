import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_API_URL', '/api')
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

const origin = 'https://review.example.test'
const request = (path: string, cookie: string) => new NextRequest(origin + path, { headers: { cookie } })

it('recognizes the host refresh cookie, not a JS-set access cookie', async () => {
  const { proxy } = await import('../../proxy')
  const session = await proxy(request('/projects', 'ff_setup_done=1; __Host-ff_refresh_token=test'))
  expect(session.headers.get('location')).toBeNull()
  const accessOnly = await proxy(request('/projects', 'ff_setup_done=1; ff_access_token=legacy'))
  expect(accessOnly.headers.get('location')).toBe(`${origin}/login?from=%2Fprojects`)
})

it('accepts either refresh cookie independently of the configured API URL', async () => {
  vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.test')
  const { proxy } = await import('../../proxy')
  for (const cookie of ['__Host-ff_refresh_token', 'ff_refresh_token']) {
    const response = await proxy(request('/projects', `ff_setup_done=1; ${cookie}=test`))
    expect(response.headers.get('location')).toBeNull()
  }
  const accessOnly = await proxy(request('/projects', 'ff_setup_done=1; ff_access_token=legacy'))
  expect(accessOnly.headers.get('location')).toBe(`${origin}/login?from=%2Fprojects`)
})

it('keeps short links public without asking the API about setup', async () => {
  const { proxy } = await import('../../proxy')
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const response = await proxy(request('/s/demo', ''))
  expect(response.headers.get('location')).toBeNull()
  expect(fetch).not.toHaveBeenCalled()
})

it('checks authentication on the first request that caches setup', async () => {
  const { proxy } = await import('../../proxy')
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ needs_setup: false })))
  const response = await proxy(request('/projects', ''))
  expect(response.headers.get('location')).toBe(`${origin}/login?from=%2Fprojects`)
  expect(response.headers.get('set-cookie')).toMatch(/ff_setup_done=1;.*Secure;.*HttpOnly;.*SameSite=lax/i)
})
