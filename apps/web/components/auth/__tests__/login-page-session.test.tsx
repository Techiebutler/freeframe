// @vitest-environment jsdom
// @vitest-environment-options { "url": "http://localhost:3000/login?from=/projects" }
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const router = vi.hoisted(() => ({ replace: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => router }))
vi.mock('../login-form', () => ({ LoginForm: () => null }))
vi.mock('@/components/shared/powered-by-badge', () => ({ PoweredByBadge: () => null }))

function seedBodySession() {
  localStorage.setItem('ff_access_token', 'stored-access')
  localStorage.setItem('ff_refresh_token', 'stored-refresh')
}

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  localStorage.clear()
  router.replace.mockReset()
  for (const name of ['ff_access_token', 'ff_refresh_token']) {
    document.cookie = `${name}=; path=/; max-age=0`
  }
})

it('keeps HTTP localhost in body mode even in a secure context', async () => {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_API_URL', '/api')
  vi.stubGlobal('isSecureContext', true)
  const { usesRefreshCookie, webClientHeaders } = await import('@/lib/auth-transport')
  expect(usesRefreshCookie()).toBe(false)
  expect(webClientHeaders()).toEqual({})
})

it('restores the body-mode refresh cookie before redirecting a stored session', async () => {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_API_URL', '/api')
  seedBodySession()
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  router.replace.mockImplementation(() => {
    expect(document.cookie).toContain('ff_refresh_token=stored-refresh')
  })
  const { default: LoginPage } = await import('@/app/(auth)/login/page')
  render(<LoginPage />)
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/projects'))
  expect(document.cookie).toContain('ff_refresh_token=stored-refresh')
  expect(fetch).not.toHaveBeenCalled()
})
