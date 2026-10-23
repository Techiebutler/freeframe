import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as React from 'react'
import { act, render } from '@testing-library/react'
import { BrandingHead } from '../shared/branding-head'
import { type InstanceBranding, useBrandingStore } from '@/stores/branding-store'
import { accentVars, ACCENT_VAR_NAMES } from '@/lib/accent'
import { makeInstanceBranding } from '@/test/branding-fixtures'

/** Match the data flow used after the branding endpoint returns, rather than
 * writing a state combination the production synchronization path cannot make. */
function syncBranding(primaryColor: string | null, overrides: Partial<InstanceBranding> = {}) {
  useBrandingStore.getState().syncBranding(
    makeInstanceBranding({ primary_color: primaryColor, ...overrides }),
  )
}

describe('BrandingHead accent wiring', () => {
  beforeEach(() => {
    vi.spyOn(useBrandingStore.getState(), 'fetchBranding').mockResolvedValue(undefined)
    document.documentElement.removeAttribute('style')
  })

  it('paints the accent token buttons actually read with an opaque muted surface', () => {
    syncBranding('#e2571f')
    render(<BrandingHead />)

    const style = document.documentElement.style
    expect(style.getPropertyValue('--accent')).toBe('#e2571f')
    expect(style.getPropertyValue('--accent-hover')).not.toBe('')
    expect(style.getPropertyValue('--accent-muted')).toBe(
      'color-mix(in srgb, #e2571f 18%, var(--bg-secondary))',
    )
  })

  it('lightens the hover shade for a dark accent and darkens it for a light one', () => {
    syncBranding('#111111')
    const { unmount } = render(<BrandingHead />)
    const dark = document.documentElement.style.getPropertyValue('--accent-hover')
    unmount()

    syncBranding('#ffe066')
    render(<BrandingHead />)
    const light = document.documentElement.style.getPropertyValue('--accent-hover')

    expect(dark).toBe('rgb(55 55 55)')
    expect(light).toBe('rgb(219 193 88)')
  })

  it('removes accent overrides after syncBranding clears the configured color', () => {
    syncBranding('#e2571f')
    const { unmount } = render(<BrandingHead />)
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#e2571f')
    unmount()

    syncBranding(null)
    render(<BrandingHead />)
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('')
    expect(document.documentElement.style.getPropertyValue('--accent-hover')).toBe('')
  })

  it('ignores a value that is not a 6-digit hex rather than writing garbage', () => {
    syncBranding('javascript:alert(1)')
    render(<BrandingHead />)
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('')
  })

  it("loses to a share link's own accent, which must win on its own page", () => {
    syncBranding('#e2571f')
    render(<BrandingHead />)

    const root = document.documentElement
    expect(root.style.getPropertyValue('--accent')).toBe('#e2571f')
    expect(root.style.getPropertyPriority('--accent')).toBe('')
    expect(root.style.getPropertyPriority('--accent-hover')).toBe('')
    expect(root.style.getPropertyPriority('--accent-muted')).toBe('')
  })
})

describe('BrandingHead icons', () => {
  beforeEach(() => {
    vi.spyOn(useBrandingStore.getState(), 'fetchBranding').mockResolvedValue(undefined)
    document.head.querySelectorAll('link').forEach((link) => link.remove())
  })

  it("removes an icon link it doesn't own so the custom one is the only candidate", () => {
    // Any icon link the app didn't create leaves two candidates and the custom
    // favicon usually loses, which reads as "setting one does nothing". No icon
    // files may live under app/ again: Next would emit React-owned links there,
    // and removing one of those is what crashed the router.
    const theirs = document.createElement('link')
    theirs.rel = 'icon'
    theirs.href = '/icon.png?abc123'
    document.head.appendChild(theirs)

    syncBranding(null, { favicon_url: 'https://s3.test/custom-favicon.png' })
    render(<BrandingHead />)

    const icons = Array.from(document.head.querySelectorAll('link[rel="icon"]'))
    expect(icons).toHaveLength(1)
    expect(icons[0].getAttribute('href')).toBe('https://s3.test/custom-favicon.png')
  })

  it('falls back to the default favicon when no custom icon is configured', () => {
    syncBranding(null)
    render(<BrandingHead />)

    const icon = document.head.querySelector('link[rel="icon"]')
    expect(icon?.getAttribute('href')).toBe('/logo-icon.png')
  })

  it('uses the dedicated Apple home-screen icon when no custom icon is configured', () => {
    syncBranding(null)
    render(<BrandingHead />)

    const appleIcon = document.head.querySelector('link[rel="apple-touch-icon"]')
    expect(appleIcon?.getAttribute('href')).toBe('/apple-icon.png')
  })
})


describe('accentVars', () => {
  it('gives a share link the same three tokens instance branding sets', () => {
    const vars = accentVars('#e2571f')
    expect(Object.keys(vars!).sort()).toEqual([...ACCENT_VAR_NAMES].sort())
  })

  it('returns null for anything that is not a 6-digit hex', () => {
    expect(accentVars('rgb(1,2,3)')).toBeNull()
    expect(accentVars('#fff')).toBeNull()
    expect(accentVars(null)).toBeNull()
  })
})

describe('BrandingHead tab title', () => {
  function setServerTitle(text: string) {
    document.head.querySelectorAll('title').forEach((el) => el.remove())
    const el = document.createElement('title')
    el.textContent = text
    document.head.appendChild(el)
  }

  beforeEach(() => {
    vi.spyOn(useBrandingStore.getState(), 'fetchBranding').mockResolvedValue(undefined)
    useBrandingStore.setState({ loaded: false })
  })

  afterEach(() => {
    document.head.querySelectorAll('title').forEach((el) => el.remove())
  })

  it('leaves the sign-in title alone on mount', () => {
    // generateMetadata already rendered "Acme — Auth". A bare "Acme" here was
    // only undone by React re-inserting its own title, which nothing guarantees.
    setServerTitle('Acme — Auth')
    syncBranding(null, { org_name: 'Acme' })
    render(<BrandingHead />)

    expect(document.title).toBe('Acme — Auth')
  })

  it('leaves the server-rendered org title alone on mount, also under StrictMode', () => {
    setServerTitle('Acme')
    syncBranding(null, { org_name: 'Acme' })
    const writes: string[] = []
    new MutationObserver(() => writes.push(document.title)).observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
    })
    render(
      <React.StrictMode>
        <BrandingHead />
      </React.StrictMode>,
    )

    expect(document.title).toBe('Acme')
    expect(writes).toEqual([])
  })

  it('swaps the org suffix of a page title when the instance is renamed', () => {
    setServerTitle('Projects – Acme')
    syncBranding(null, { org_name: 'Acme' })
    render(<BrandingHead />)

    act(() => syncBranding(null, { org_name: 'Globex' }))

    expect(document.title).toBe('Projects – Globex')
  })

  it('sets the new org name when there is no page title', () => {
    setServerTitle('Acme')
    syncBranding(null, { org_name: 'Acme' })
    render(<BrandingHead />)

    act(() => syncBranding(null, { org_name: 'Globex' }))

    expect(document.title).toBe('Globex')
  })

  it('keeps "— Auth" when the name arrives after mount, as when the server had no branding', () => {
    // No server copy: the title was rendered as "FreeFrame — Auth" and the
    // client fetch supplies the real name later.
    setServerTitle('FreeFrame — Auth')
    render(<BrandingHead />)
    expect(document.title).toBe('FreeFrame — Auth')

    act(() => syncBranding(null, { org_name: 'Acme' }))

    expect(document.title).toBe('Acme — Auth')
  })
})
