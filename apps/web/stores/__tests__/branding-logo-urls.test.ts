/**
 * Instance logos are stable API paths, so the persisted store can keep them.
 *
 * They used to be S3 links signed for an hour, so the store dropped every
 * persisted logo URL 45 minutes after the last sync, and a returning viewer got
 * the instance's name beside the default FreeFrame mark until a refetch landed.
 * The API now answers with `/instance/branding/logo/<slot>?v=<id>`, a path that
 * redirects to a freshly signed link on every request, so nothing expires.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { makeInstanceBranding } from '@/test/branding-fixtures'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'
const LIGHT_PATH = '/instance/branding/logo/logo-light?v=3f6b0c1e'
const TWO_HOURS_MS = 2 * 60 * 60 * 1000

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('logoUrlFromApi', () => {
  it('points an API path at the API', async () => {
    const { logoUrlFromApi } = await import('@/lib/branding-logo')

    expect(logoUrlFromApi(LIGHT_PATH)).toBe(`${API_URL}${LIGHT_PATH}`)
  })

  it('keeps a relative API base relative, for an instance served behind one proxy', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', '/api')
    vi.resetModules()
    const { logoUrlFromApi } = await import('@/lib/branding-logo')

    expect(logoUrlFromApi(LIGHT_PATH)).toBe(`/api${LIGHT_PATH}`)
  })

  it('leaves an absolute URL and an empty slot alone', async () => {
    const { logoUrlFromApi } = await import('@/lib/branding-logo')

    expect(logoUrlFromApi('https://cdn.example/light.png')).toBe('https://cdn.example/light.png')
    expect(logoUrlFromApi('//cdn.example/light.png')).toBe('//cdn.example/light.png')
    expect(logoUrlFromApi(null)).toBeNull()
    expect(logoUrlFromApi(undefined)).toBeNull()
  })
})

describe('brandingValuesFromApi', () => {
  it('turns every logo path into a URL the browser can load', async () => {
    const { brandingValuesFromApi } = await import('../branding-store')

    const values = brandingValuesFromApi(
      makeInstanceBranding({
        logo_light_url: LIGHT_PATH,
        logo_dark_url: '/instance/branding/logo/logo-dark?v=1',
        favicon_url: '/instance/branding/logo/favicon?v=2',
        apple_icon_url: '/instance/branding/logo/apple-icon?v=3',
        login_logo_url: '/instance/branding/logo/login-logo?v=4',
      }),
    )

    expect(values.orgLogoLight).toBe(`${API_URL}${LIGHT_PATH}`)
    expect(values.orgLogoDark).toBe(`${API_URL}/instance/branding/logo/logo-dark?v=1`)
    expect(values.faviconUrl).toBe(`${API_URL}/instance/branding/logo/favicon?v=2`)
    expect(values.appleIconUrl).toBe(`${API_URL}/instance/branding/logo/apple-icon?v=3`)
    expect(values.loginLogoUrl).toBe(`${API_URL}/instance/branding/logo/login-logo?v=4`)
  })
})

describe('persisted branding', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  async function rehydrateFrom(state: Record<string, unknown>, version?: number) {
    const { useBrandingStore } = await import('../branding-store')
    window.localStorage.setItem(
      'ff-branding',
      JSON.stringify({ state, version: version ?? useBrandingStore.persist.getOptions().version }),
    )
    await useBrandingStore.persist.rehydrate()
    return useBrandingStore.getState()
  }

  it('keeps the logos however long ago they were synced', async () => {
    const logo = `${API_URL}${LIGHT_PATH}`
    const state = await rehydrateFrom({
      orgName: 'Acme',
      orgLogoLight: logo,
      orgLogoDark: logo,
      faviconUrl: logo,
      appleIconUrl: logo,
      loginLogoUrl: logo,
      brandingFetchedAt: Date.now() - TWO_HOURS_MS,
    })

    expect(state.orgName).toBe('Acme')
    expect(state.orgLogoLight).toBe(logo)
    expect(state.orgLogoDark).toBe(logo)
    expect(state.faviconUrl).toBe(logo)
    expect(state.appleIconUrl).toBe(logo)
    expect(state.loginLogoUrl).toBe(logo)
  })

  it('discards a copy saved while logos were signed links', async () => {
    const state = await rehydrateFrom(
      {
        orgName: 'Acme',
        orgLogoLight: 'https://s3.example/branding/logo-light/k?X-Amz-Signature=abc',
        brandingFetchedAt: Date.now(),
      },
      6,
    )

    expect(state.orgLogoLight).toBeNull()
  })
})
