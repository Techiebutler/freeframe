import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { HARDCODED_DEFAULTS, useBrandingStore } from '@/stores/branding-store'

vi.mock('@/hooks/use-resolved-theme', () => ({ useResolvedTheme: () => 'light' }))

import { AuthBrandingHeader } from '../auth-branding-header'

const BROKEN_LOGO = 'https://assets.test/broken-logo.png'
const FRESH_LOGO = 'https://assets.test/fresh-logo.png'

function setBranding(overrides: Partial<ReturnType<typeof useBrandingStore.getState>> = {}) {
  useBrandingStore.setState({
    ...HARDCODED_DEFAULTS,
    brandingFetchedAt: null,
    loaded: true,
    loading: false,
    ...overrides,
  })
}

describe('AuthBrandingHeader logo fallback', () => {
  beforeEach(() => {
    setBranding({ orgName: 'Example Studio' })
  })

  it('renders one themed full fallback when no custom logo exists', () => {
    const { container } = render(<AuthBrandingHeader />)

    const logo = screen.getByRole('img', { name: 'FreeFrame' })
    expect(container.querySelectorAll('img')).toHaveLength(1)
    expect(logo).toHaveAttribute('src', '/logo-full-dark.svg')
    expect(logo).toHaveClass('themed-default-logo', 'h-12')
  })

  it('replaces a failed custom logo with the themed fallback', () => {
    setBranding({ orgName: 'Example Studio', loginLogoUrl: BROKEN_LOGO })
    const { container } = render(<AuthBrandingHeader />)

    fireEvent.error(screen.getByRole('img', { name: 'Example Studio' }))

    expect(container.querySelectorAll('img')).toHaveLength(1)
    expect(screen.getByRole('img', { name: 'FreeFrame' })).toHaveAttribute(
      'src',
      '/logo-full-dark.svg',
    )
  })

  it('retries a previously failed URL after branding changes away and back', () => {
    setBranding({ orgName: 'Example Studio', loginLogoUrl: BROKEN_LOGO })
    render(<AuthBrandingHeader />)
    fireEvent.error(screen.getByRole('img', { name: 'Example Studio' }))

    act(() => useBrandingStore.setState({ loginLogoUrl: FRESH_LOGO }))
    expect(screen.getByRole('img', { name: 'Example Studio' })).toHaveAttribute(
      'src',
      FRESH_LOGO,
    )

    act(() => useBrandingStore.setState({ loginLogoUrl: BROKEN_LOGO }))
    expect(screen.getByRole('img', { name: 'Example Studio' })).toHaveAttribute(
      'src',
      BROKEN_LOGO,
    )
  })

  it('tries a new custom URL after a previous URL failed', () => {
    setBranding({ orgName: 'Example Studio', loginLogoUrl: BROKEN_LOGO })
    render(<AuthBrandingHeader />)
    fireEvent.error(screen.getByRole('img', { name: 'Example Studio' }))

    act(() => useBrandingStore.setState({ loginLogoUrl: FRESH_LOGO }))

    expect(screen.getByRole('img', { name: 'Example Studio' })).toHaveAttribute(
      'src',
      FRESH_LOGO,
    )
    expect(screen.queryByRole('img', { name: 'FreeFrame' })).not.toBeInTheDocument()
  })
})
