import { describe, expect, it } from 'vitest'
import { resolveBrandingLogo } from '../branding-logo'

const LOGOS = {
  darkUrl: 'https://assets.test/logo-for-dark-background.png',
  lightUrl: 'https://assets.test/logo-for-light-background.png',
}

describe('resolveBrandingLogo', () => {
  it('prefers a surface-specific logo in either theme', () => {
    expect(
      resolveBrandingLogo({
        theme: 'light',
        ...LOGOS,
        preferredUrl: 'https://assets.test/sign-in-logo.png',
      }),
    ).toBe('https://assets.test/sign-in-logo.png')
  })

  it.each([
    ['dark', LOGOS.darkUrl],
    ['light', LOGOS.lightUrl],
  ] as const)('selects the matching configured logo in the %s theme', (theme, expected) => {
    expect(resolveBrandingLogo({ theme, ...LOGOS })).toBe(expected)
  })

  it('falls back to the other theme logo when the preferred variant is absent', () => {
    expect(
      resolveBrandingLogo({ theme: 'dark', darkUrl: null, lightUrl: LOGOS.lightUrl }),
    ).toBe(LOGOS.lightUrl)
    expect(
      resolveBrandingLogo({ theme: 'light', darkUrl: LOGOS.darkUrl, lightUrl: null }),
    ).toBe(LOGOS.darkUrl)
  })

  it('returns undefined when no logo is configured', () => {
    expect(resolveBrandingLogo({ theme: 'dark', darkUrl: null, lightUrl: null })).toBeUndefined()
  })
})
