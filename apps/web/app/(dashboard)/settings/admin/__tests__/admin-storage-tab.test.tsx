import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

// The Storage panel sits where the other instance-wide admin surfaces sit: a
// sub-tab of the Admin dashboard, reachable by deep link like the others.

vi.mock('swr', () => ({
  default: () => ({ data: [], isLoading: false }),
  mutate: vi.fn(),
}))
vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), patch: vi.fn(), post: vi.fn(), delete: vi.fn() },
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }))
vi.mock('@/components/settings/instance-settings-tab', () => ({ InstanceSettingsTab: () => null }))
vi.mock('@/components/settings/branding-tab', () => ({ BrandingTab: () => null }))
vi.mock('@/components/settings/storage-tab', () => ({
  StorageTab: () => <div data-testid="storage-tab" />,
}))

import AdminPage from '../page'
import { useAuthStore } from '@/stores/auth-store'

describe('the Admin dashboard Storage tab', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/settings/admin')
    useAuthStore.setState({
      user: { id: 'me', name: 'Me', email: 'me@example.com', is_superadmin: true } as never,
      isSuperAdmin: true,
    })
  })

  it('offers the Storage tab, on click and by deep link', () => {
    render(<AdminPage />)
    expect(screen.queryByTestId('storage-tab')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Storage' }))
    expect(screen.getByTestId('storage-tab')).toBeInTheDocument()

    window.history.replaceState({}, '', '/settings/admin?tab=storage')
    render(<AdminPage />)
    expect(screen.getAllByTestId('storage-tab').length).toBeGreaterThan(0)
  })

  it('offers it to no one else, and ignores a tab name it does not have', () => {
    window.history.replaceState({}, '', '/settings/admin?tab=nonsense')
    render(<AdminPage />)
    // Falls back to Users rather than rendering a blank panel.
    expect(screen.getByText(/Manage platform users/i)).toBeInTheDocument()

    useAuthStore.setState({ isSuperAdmin: false })
    render(<AdminPage />)
    expect(screen.queryByRole('button', { name: 'Storage' })).not.toBeInTheDocument()
  })
})
