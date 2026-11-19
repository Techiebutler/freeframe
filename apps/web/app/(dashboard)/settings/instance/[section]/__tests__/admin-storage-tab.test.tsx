import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

// The Storage panel sits where the other instance-wide admin surfaces sit: a
// page of Settings → Instance, reached by its own address.

const nav = vi.hoisted(() => ({ section: 'users', replace: vi.fn() }))

vi.mock('swr', () => ({
  default: () => ({ data: [], isLoading: false }),
  mutate: vi.fn(),
}))
vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), patch: vi.fn(), post: vi.fn(), delete: vi.fn() },
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: nav.replace }),
  useParams: () => ({ section: nav.section }),
}))
vi.mock('@/components/settings/instance-settings-tab', () => ({ InstanceSettingsTab: () => null }))
vi.mock('@/components/settings/branding-tab', () => ({ BrandingTab: () => null }))
vi.mock('@/components/settings/storage-tab', () => ({
  StorageTab: () => <div data-testid="storage-tab" />,
}))

import AdminPage from '../page'
import { useAuthStore } from '@/stores/auth-store'

describe('the Instance Storage page', () => {
  beforeEach(() => {
    nav.section = 'users'
    nav.replace.mockClear()
    useAuthStore.setState({
      user: { id: 'me', name: 'Me', email: 'me@example.com', is_superadmin: true } as never,
      isSuperAdmin: true,
    })
  })

  it('shows Storage on /settings/instance/storage, and not on Users', () => {
    const { unmount } = render(<AdminPage />)
    expect(screen.queryByTestId('storage-tab')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'Users' })).toBeInTheDocument()
    unmount()

    nav.section = 'storage'
    render(<AdminPage />)
    expect(screen.getByTestId('storage-tab')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Storage' })).toBeInTheDocument()
  })

  it('sends a page name it does not have to Users, and shows it to no one else', () => {
    nav.section = 'nonsense'
    const { container, unmount } = render(<AdminPage />)
    expect(nav.replace).toHaveBeenCalledWith('/settings/instance/users')
    // Nothing is drawn meanwhile, rather than a blank panel under a wrong title.
    expect(container).toBeEmptyDOMElement()
    unmount()

    nav.section = 'storage'
    useAuthStore.setState({ isSuperAdmin: false })
    render(<AdminPage />)
    expect(screen.queryByTestId('storage-tab')).not.toBeInTheDocument()
  })
})
