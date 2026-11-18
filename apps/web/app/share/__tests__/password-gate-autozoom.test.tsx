/**
 * The password gate's input takes focus the moment the gate renders
 * (`autoFocus`), so on iOS Safari a font-size under 16px zoomed the page before
 * a guest had touched anything. Same guard as the review inputs in #324: 16px
 * on a touch device, the original size only under `(hover: hover)` — never a
 * viewport-width breakpoint, which a landscape phone is wider than.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'

// Branding falls back to its defaults without a provider; only the fetch it
// would otherwise start is stubbed out.
vi.mock('@/components/shared/branding-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/shared/branding-provider')>()),
  useEnsureBranding: () => {},
}))

import SharePage from '../[token]/page'

describe('the share-link password gate', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ requires_password: true }),
    })) as unknown as typeof fetch)
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener() {}, removeEventListener() {},
      addListener() {}, removeListener() {}, dispatchEvent: () => false,
    }))
  })

  afterEach(() => { vi.unstubAllGlobals() })

  it('sizes its autofocused input at the 16px iOS zoom threshold, compact only under a hover query', async () => {
    // Route params arrive as a promise in Next 16; one that already carries
    // `status` and `value` is unwrapped synchronously by `use()`.
    const routeParams = { token: 't' }
    render(
      <SharePage
        params={Object.assign(Promise.resolve(routeParams), {
          status: 'fulfilled' as const,
          value: routeParams,
        })}
      />,
    )

    const input = await screen.findByPlaceholderText('Enter password…')
    const classes = input.className.split(/\s+/)
    expect(classes).toContain('text-[16px]')
    expect(classes).toContain('[@media(hover:hover)]:text-sm')
    expect(classes).not.toContain('text-sm')
    expect(input.className).not.toMatch(/\bmd:text-/)
  })
})
