/**
 * The root layout renders the favicon and apple-touch-icon links on the server.
 *
 * `GET /instance/branding` answers with a path into the API
 * (`/instance/branding/logo/<slot>?v=<id>`), so the layout has to prefix it
 * with the public API base. Left as-is, the browser would resolve it against
 * the web app's own origin and load a 404 as the tab icon until BrandingHead
 * corrected it after hydration.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { InstanceBranding } from '@/stores/branding-store'

const getServerBranding = vi.fn<() => Promise<InstanceBranding | null>>()
vi.mock('@/lib/branding-server', () => ({
  getServerBranding: () => getServerBranding(),
}))
vi.mock('next/font/google', () => ({
  DM_Sans: () => ({ variable: 'font-dm-sans', className: 'font-dm-sans' }),
}))

import RootLayout from '../layout'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

async function iconHrefs() {
  const html = renderToStaticMarkup(await RootLayout({ children: null }))
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const href = (rel: string) => doc.querySelector(`link[rel="${rel}"]`)?.getAttribute('href')
  return {
    icon: href('icon'),
    shortcut: href('shortcut icon'),
    apple: href('apple-touch-icon'),
  }
}

beforeEach(() => {
  getServerBranding.mockReset()
})

describe('root layout icon links', () => {
  it('points a configured favicon and apple icon at the API', async () => {
    getServerBranding.mockResolvedValue({
      favicon_url: '/instance/branding/logo/favicon?v=x',
      apple_icon_url: '/instance/branding/logo/apple-icon?v=y',
    } as InstanceBranding)

    const hrefs = await iconHrefs()

    expect(hrefs.icon).toBe(`${API_URL}/instance/branding/logo/favicon?v=x`)
    expect(hrefs.shortcut).toBe(`${API_URL}/instance/branding/logo/favicon?v=x`)
    expect(hrefs.apple).toBe(`${API_URL}/instance/branding/logo/apple-icon?v=y`)
  })

  it('falls back to the bundled icons when branding is unavailable', async () => {
    getServerBranding.mockResolvedValue(null)

    const hrefs = await iconHrefs()

    expect(hrefs.icon).toBe('/logo-icon.png')
    expect(hrefs.shortcut).toBe('/logo-icon.png')
    expect(hrefs.apple).toBe('/apple-icon.png')
  })
})
