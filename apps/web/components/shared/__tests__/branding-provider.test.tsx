/**
 * Branding has to be right in the first byte, not a round trip later.
 *
 * It used to be fetched only from the browser after mount, so a white-labelled
 * instance served the FreeFrame wordmark, the FreeFrame name and
 * `<title>FreeFrame</title>` first and swapped in the real brand once the
 * request landed. A viewer far from the deployment had time to read it.
 *
 * Two approaches were tried and measured before this one. Seeding the zustand
 * store from the server layout does nothing, because a server component and a
 * client component get different instances of the same module. Seeding it from
 * inside a client component does not work either: React caches what
 * `useSyncExternalStore` reads for the whole server pass, so the seeding
 * component saw `getState()` return the new value while every
 * `useBrandingStore()` in the same render still returned the old one. Context
 * is what flows through an SSR render, so that is what carries it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as React from 'react'
import { render, screen, waitFor, act } from '@testing-library/react'
import { renderToString } from 'react-dom/server'

import { BrandingProvider, useBranding, useEnsureBranding } from '../branding-provider'
import { useBrandingStore, HARDCODED_DEFAULTS, type InstanceBranding } from '@/stores/branding-store'

const SERVER_BRANDING = {
  id: 'b1',
  org_name: 'Northwind Studios',
  logo_light_key: null, logo_dark_key: null, favicon_key: null,
  apple_icon_key: null, login_logo_key: null,
  logo_light_url: 'https://cdn.example/light.png',
  logo_dark_url: 'https://cdn.example/dark.png',
  favicon_url: 'https://cdn.example/fav.png',
  apple_icon_url: null,
  login_logo_url: 'https://cdn.example/login.png',
  primary_color: '#ed7d21',
  powered_by_freeframe: false,
  created_at: '', updated_at: '',
} as InstanceBranding

function Probe() {
  const b = useBranding()
  return (
    <div>
      <span data-testid="name">{b.orgName}</span>
      <span data-testid="light">{String(b.orgLogoLight)}</span>
      <span data-testid="accent">{String(b.primaryColor)}</span>
      <span data-testid="powered">{String(b.poweredByFreeframe)}</span>
    </div>
  )
}

beforeEach(() => {
  useBrandingStore.setState({ ...HARDCODED_DEFAULTS, loaded: false, loading: false, brandingFetchedAt: null })
  vi.restoreAllMocks()
})

/**
 * `renderToString` is the honest test for this, and a browser render is not.
 *
 * The provider also seeds the store from an effect, and in jsdom that effect
 * has run by the time any assertion reads the DOM -- so a render-and-query test
 * passes whether or not the server value is ever used, which is exactly what a
 * first draft of this file did. Effects do not run during server rendering, so
 * this is both the real path and the only one where the behaviour is visible.
 */
describe('what the server actually emits', () => {
  it('has the instance brand in the markup, with no store involved', () => {
    const html = renderToString(
      <BrandingProvider initial={SERVER_BRANDING}>
        <Probe />
      </BrandingProvider>,
    )

    expect(html).toContain('Northwind Studios')
    expect(html).toContain('https://cdn.example/light.png')
    expect(html).toContain('#ed7d21')
    expect(html).not.toContain('FreeFrame')
  })

  it('carries powered_by_freeframe false through, rather than defaulting it on', () => {
    // An instance that turned the credit off must not show it for the first
    // frame of every page load.
    const html = renderToString(
      <BrandingProvider initial={SERVER_BRANDING}>
        <Probe />
      </BrandingProvider>,
    )

    expect(html).toContain('>false<')
  })

  it('falls back to the built-in defaults when the server could not supply it', () => {
    // The API is unreachable during `next build`, and may be during a request.
    // That has to degrade to the old behaviour, not to a blank brand.
    const html = renderToString(
      <BrandingProvider initial={null}>
        <Probe />
      </BrandingProvider>,
    )

    expect(html).toContain('FreeFrame')
  })

  it('still works for a component rendered outside any provider', () => {
    render(<Probe />)

    expect(screen.getByTestId('name').textContent).toBe('FreeFrame')
  })

  it('yields to the store once it holds real data, so an edit is not reverted', () => {
    // The settings screen syncs the store from its own PUT response. If the
    // server copy kept winning, saving a new name would appear to do nothing
    // until the page was reloaded.
    render(
      <BrandingProvider initial={SERVER_BRANDING}>
        <Probe />
      </BrandingProvider>,
    )
    expect(screen.getByTestId('name').textContent).toBe('Northwind Studios')

    act(() => {
      useBrandingStore.getState().syncBranding({ ...SERVER_BRANDING, org_name: 'Renamed Ltd' })
    })

    expect(screen.getByTestId('name').textContent).toBe('Renamed Ltd')
  })

  it('seeds the store so a later consumer sees the same values', async () => {
    render(
      <BrandingProvider initial={SERVER_BRANDING}>
        <Probe />
      </BrandingProvider>,
    )

    await waitFor(() => expect(useBrandingStore.getState().loaded).toBe(true))
    expect(useBrandingStore.getState().orgName).toBe('Northwind Studios')
  })
})

describe('the client fetch fallback', () => {
  function FetchProbe() {
    useEnsureBranding()
    return null
  }

  it('does not fetch when the server already supplied branding', async () => {
    // Otherwise every page load would put a request in front of a page that was
    // served with the answer -- worst on exactly the slow links this is for.
    const fetchBranding = vi.fn()
    useBrandingStore.setState({ fetchBranding })

    render(
      <BrandingProvider initial={SERVER_BRANDING}>
        <FetchProbe />
      </BrandingProvider>,
    )

    await new Promise((r) => setTimeout(r, 10))
    expect(fetchBranding).not.toHaveBeenCalled()
  })

  it('does fetch when the server could not supply it', async () => {
    // A deployment whose web server cannot reach the API keeps working exactly
    // as it did before this change.
    const fetchBranding = vi.fn()
    useBrandingStore.setState({ fetchBranding })

    render(
      <BrandingProvider initial={null}>
        <FetchProbe />
      </BrandingProvider>,
    )

    await waitFor(() => expect(fetchBranding).toHaveBeenCalled())
  })
})
