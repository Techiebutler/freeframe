import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('@/lib/api', () => ({ api: { put: vi.fn(), post: vi.fn() } }))

import { BrandingTab } from '../branding-tab'
import { useAuthStore } from '@/stores/auth-store'
import { useBrandingStore, HARDCODED_DEFAULTS } from '@/stores/branding-store'
import type { User } from '@/types'

const admin = { id: 'me', name: 'Me', email: 'me@example.com', is_superadmin: true } as User

/** The store as it holds an instance nobody has branded: the API's null accent stays null. */
function unbranded() {
  useBrandingStore.setState({ ...HARDCODED_DEFAULTS, primaryColor: null, loaded: true })
}

describe('BrandingTab: Reset all branding', () => {
  beforeEach(() => {
    useAuthStore.setState({ user: admin, isSuperAdmin: true })
    unbranded()
  })

  it('stays hidden on an instance with no branding configured', () => {
    // A null accent used to compare unequal to the hardcoded default colour, so
    // the section showed on every instance, including straight after a reset.
    render(<BrandingTab />)
    expect(screen.queryByText(/reset all branding/i)).not.toBeInTheDocument()
  })

  it('stays hidden when only the default sign-in method changed', () => {
    useBrandingStore.setState({ defaultLoginMode: 'password' })
    render(<BrandingTab />)
    expect(screen.queryByText(/reset all branding/i)).not.toBeInTheDocument()
  })

  it('appears once an accent colour is set', () => {
    useBrandingStore.setState({ primaryColor: '#ed7d21' })
    render(<BrandingTab />)
    expect(screen.getByText(/reset all branding/i)).toBeInTheDocument()
  })
})
