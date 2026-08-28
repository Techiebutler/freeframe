import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render } from '@testing-library/react'
import { BrandingHead } from '../shared/branding-head'
import { useBrandingStore } from '@/stores/branding-store'
import { accentVars, ACCENT_VAR_NAMES } from '@/lib/accent'

/**
 * The instance primary color has to land on --accent to mean anything: every
 * accent-painted surface (primary buttons, the share-page download button, the
 * post-comment button, focus rings) resolves through that token. It previously
 * only set a bespoke --ff-primary that nothing read, so the control validated
 * and persisted a color that changed nothing on screen.
 */
function setBranding(primaryColor: string | null) {
  useBrandingStore.setState({
    primaryColor,
    faviconUrl: null,
    appleIconUrl: null,
    orgName: 'Acme',
    loaded: true,
    loading: false,
  })
}

describe('BrandingHead accent wiring', () => {
  beforeEach(() => {
    vi.spyOn(useBrandingStore.getState(), 'fetchBranding').mockResolvedValue(undefined)
    document.documentElement.removeAttribute('style')
  })

  it('paints the accent token buttons actually read', () => {
    setBranding('#e2571f')
    render(<BrandingHead />)

    const style = document.documentElement.style
    expect(style.getPropertyValue('--accent')).toBe('#e2571f')
    expect(style.getPropertyValue('--accent-hover')).not.toBe('')
    expect(style.getPropertyValue('--accent-muted')).toContain('0.18')
  })

  it('lightens the hover shade for a dark accent and darkens it for a light one', () => {
    setBranding('#111111')
    const { unmount } = render(<BrandingHead />)
    const dark = document.documentElement.style.getPropertyValue('--accent-hover')
    unmount()

    setBranding('#ffe066')
    render(<BrandingHead />)
    const light = document.documentElement.style.getPropertyValue('--accent-hover')

    // A near-black accent moves toward white; a pale yellow moves toward black.
    expect(dark).toBe('rgb(55 55 55)')
    expect(light).toBe('rgb(219 193 88)')
  })

  it('hands the accent back to the stylesheet when the color is cleared', () => {
    setBranding('#e2571f')
    const { unmount } = render(<BrandingHead />)
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#e2571f')
    unmount()

    setBranding(null)
    render(<BrandingHead />)
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('')
    expect(document.documentElement.style.getPropertyValue('--accent-hover')).toBe('')
  })

  it('ignores a value that is not a 6-digit hex rather than writing garbage', () => {
    setBranding('javascript:alert(1)')
    render(<BrandingHead />)
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('')
  })

  it("loses to a share link's own accent, which must win on its own page", () => {
    // The share viewer injects `:root { --accent: … !important }`. An author
    // stylesheet declaration marked !important outranks a non-important inline
    // style, so instance branding must not be setting these !important or a
    // per-link accent would silently stop working.
    setBranding('#e2571f')
    render(<BrandingHead />)

    const root = document.documentElement
    expect(root.style.getPropertyValue('--accent')).toBe('#e2571f')
    expect(root.style.getPropertyPriority('--accent')).toBe('')
    expect(root.style.getPropertyPriority('--accent-hover')).toBe('')
    expect(root.style.getPropertyPriority('--accent-muted')).toBe('')
  })
})

describe('BrandingHead favicon', () => {
  beforeEach(() => {
    vi.spyOn(useBrandingStore.getState(), 'fetchBranding').mockResolvedValue(undefined)
    document.head.querySelectorAll('link').forEach((l) => l.remove())
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

    useBrandingStore.setState({
      primaryColor: null,
      faviconUrl: 'https://s3.test/custom-favicon.png',
      appleIconUrl: null,
      orgName: 'Acme',
      loaded: true,
      loading: false,
    })
    render(<BrandingHead />)

    const icons = Array.from(document.head.querySelectorAll('link[rel="icon"]'))
    expect(icons).toHaveLength(1)
    expect(icons[0].getAttribute('href')).toBe('https://s3.test/custom-favicon.png')
  })

  it('falls back to the real mark when no favicon is set, rather than none', () => {
    useBrandingStore.setState({
      primaryColor: null,
      faviconUrl: null,
      appleIconUrl: null,
      orgName: 'Acme',
      loaded: true,
      loading: false,
    })
    render(<BrandingHead />)

    const icon = document.head.querySelector('link[rel="icon"]')
    expect(icon?.getAttribute('href')).toBe('/logo-icon.png')
  })
})

describe('accentVars', () => {
  it('gives a share link the same three tokens instance branding sets', () => {
    // Both call sites derive from one helper, so a link overriding the accent
    // also overrides the hover and muted shades. Overriding --accent alone left
    // a repainted button whose hover state was still the instance's colour.
    const vars = accentVars('#e2571f')
    expect(Object.keys(vars!).sort()).toEqual([...ACCENT_VAR_NAMES].sort())
  })

  it('returns null for anything that is not a 6-digit hex', () => {
    expect(accentVars('rgb(1,2,3)')).toBeNull()
    expect(accentVars('#fff')).toBeNull()
    expect(accentVars(null)).toBeNull()
  })
})
