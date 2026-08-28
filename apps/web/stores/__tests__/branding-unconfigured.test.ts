/**
 * An instance that has never configured branding must look exactly as before.
 *
 * `primary_color` is nullable with no server default, so a fresh instance returns
 * null. That has to survive as null all the way to BrandingHead, which hands the
 * accent tokens back to the stylesheet. Filling in a default instead was harmless
 * while the colour went to `--ff-primary`, which nothing read; now that it reaches
 * `--accent` it would repaint every un-branded instance on upgrade, with the
 * settings screen still reporting no custom branding and "Reset all branding"
 * round-tripping straight back to the same colour.
 */
import { describe, it, expect, beforeEach } from 'vitest'

import { useBrandingStore, HARDCODED_DEFAULTS } from '../branding-store'
import { makeInstanceBranding } from '@/test/branding-fixtures'

describe('syncBranding with no accent configured', () => {
  beforeEach(() => {
    // Start from the wrong answer, so a no-op would fail rather than pass.
    useBrandingStore.setState({ primaryColor: '#123456' })
  })

  it('leaves primaryColor null instead of substituting a default', () => {
    useBrandingStore.getState().syncBranding(makeInstanceBranding({ primary_color: null }))

    const got = useBrandingStore.getState().primaryColor
    expect(got).toBeNull()
    expect(got).not.toBe(HARDCODED_DEFAULTS.primaryColor)
  })

  it('carries a configured colour through unchanged', () => {
    useBrandingStore.getState().syncBranding(makeInstanceBranding({ primary_color: '#ff0000' }))

    expect(useBrandingStore.getState().primaryColor).toBe('#ff0000')
  })
})
