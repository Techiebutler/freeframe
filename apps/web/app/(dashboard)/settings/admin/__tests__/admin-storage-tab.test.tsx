import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

// The four panel surfaces sit where the other instance-wide admin surfaces sit:
// sub-tabs of the Admin dashboard, each reachable by deep link like the others.

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
vi.mock('@/components/settings/admin-tabs', () => ({
  AdminProjectsTab: () => <div data-testid="projects-tab" />,
  AdminInternalTab: () => <div data-testid="internal-tab" />,
  AdminExternalTab: () => <div data-testid="external-tab" />,
}))

import AdminPage from '../page'
import { useAuthStore } from '@/stores/auth-store'

/** label, the stub it renders, and the ?tab= slug that deep-links to it. */
const TABS = [
  ['Storage', 'storage-tab', 'storage'],
  ['Projects', 'projects-tab', 'projects'],
  ['Internal shared', 'internal-tab', 'internal'],
  ['External shared', 'external-tab', 'external'],
] as const

describe('the Admin dashboard panel tabs', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/settings/admin')
    useAuthStore.setState({
      user: { id: 'me', name: 'Me', email: 'me@example.com', is_superadmin: true } as never,
      isSuperAdmin: true,
    })
  })

  it.each(TABS)('offers the %s tab, on click and by deep link', (label, testId, slug) => {
    render(<AdminPage />)
    expect(screen.queryByTestId(testId)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: label }))
    expect(screen.getByTestId(testId)).toBeInTheDocument()

    window.history.replaceState({}, '', `/settings/admin?tab=${slug}`)
    render(<AdminPage />)
    expect(screen.getAllByTestId(testId).length).toBeGreaterThan(0)
  })

  it('offers none of them to a non-admin, and ignores a tab name it does not have', () => {
    window.history.replaceState({}, '', '/settings/admin?tab=nonsense')
    render(<AdminPage />)
    // Falls back to Users rather than rendering a blank panel.
    expect(screen.getByText(/Manage platform users/i)).toBeInTheDocument()

    useAuthStore.setState({ isSuperAdmin: false })
    render(<AdminPage />)
    for (const [label] of TABS) {
      expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument()
    }
  })
})
