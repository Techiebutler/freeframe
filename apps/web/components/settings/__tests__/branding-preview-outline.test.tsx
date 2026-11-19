import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

import { BrandingPreview } from '../branding-preview'
import { useBrandingStore, HARDCODED_DEFAULTS } from '@/stores/branding-store'

// The preview draws mock screens (the app shell, the sign-in page, an email)
// inside the Branding settings page. They are a picture, so their headings and
// links must not join the page's own outline.
describe('BrandingPreview: the mock screens stay out of the page outline', () => {
  beforeEach(() => {
    useBrandingStore.setState({ ...HARDCODED_DEFAULTS, orgName: 'Studio North', loaded: true })
  })

  it('exposes no heading from the sign-in mock, while its text is still drawn', () => {
    render(<BrandingPreview />)
    fireEvent.click(screen.getByRole('button', { name: /sign-in/i }))
    expect(screen.getAllByText('Studio North').length).toBeGreaterThan(0)
    expect(screen.queryByRole('heading', { name: 'Studio North' })).toBeNull()
  })
})
