import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

const put = vi.fn()
vi.mock('@/lib/api', () => ({ api: { put: (...a: unknown[]) => put(...a), post: vi.fn() } }))

import { BrandingTab } from '../branding-tab'
import { useAuthStore } from '@/stores/auth-store'
import { useBrandingStore, HARDCODED_DEFAULTS } from '@/stores/branding-store'
import { makeInstanceBranding } from '@/test/branding-fixtures'
import type { User } from '@/types'

const admin = { id: 'me', name: 'Me', email: 'me@example.com', is_superadmin: true } as User

/** The store as it holds an instance nobody has branded: the API's null accent stays null. */
function unbranded() {
  useBrandingStore.setState({ ...HARDCODED_DEFAULTS, loaded: true })
}

describe('BrandingTab: Reset all branding', () => {
  beforeEach(() => {
    put.mockReset()
    useAuthStore.setState({ user: admin, isSuperAdmin: true })
    unbranded()
  })

  it('stays hidden on an instance with no branding configured', () => {
    // A null accent used to compare unequal to the hardcoded default colour, so
    // the section showed on every instance, including straight after a reset.
    render(<BrandingTab />)
    expect(screen.queryByText(/reset all branding/i)).not.toBeInTheDocument()
  })

  it('stays hidden before branding loads and when the fetch fails', () => {
    // Both leave the store on its defaults; those must read as "no branding" too.
    useBrandingStore.setState({ ...HARDCODED_DEFAULTS, loaded: false, fetchBranding: vi.fn() })
    const { unmount } = render(<BrandingTab />)
    expect(screen.queryByText(/reset all branding/i)).not.toBeInTheDocument()
    unmount()

    useBrandingStore.setState({ loaded: true })
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

  it('leaves the default sign-in method alone', async () => {
    // The sign-in method shares the branding row but lives on Instance Settings,
    // so a reset from this tab that wiped it would go unnoticed.
    useBrandingStore.setState({ primaryColor: '#ed7d21', defaultLoginMode: 'password' })
    put.mockResolvedValue(makeInstanceBranding({ org_name: 'FreeFrame', default_login_mode: 'password' }))
    render(<BrandingTab />)

    fireEvent.click(screen.getByText(/reset all branding/i))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reset' }))

    await waitFor(() => expect(put).toHaveBeenCalledTimes(1))
    const [url, body] = put.mock.calls[0]
    expect(url).toBe('/instance/branding')
    expect(body).not.toHaveProperty('default_login_mode')
    await waitFor(() => expect(useBrandingStore.getState().primaryColor).toBeNull())
    expect(useBrandingStore.getState().defaultLoginMode).toBe('password')
  })
})
