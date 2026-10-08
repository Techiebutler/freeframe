import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import type { User } from '@/types'

function makeUser(overrides: Partial<User>): User {
  return {
    id: 'u',
    email: 'u@example.com',
    name: 'U',
    avatar_url: null,
    status: 'active',
    is_superadmin: false,
    email_verified: true,
    preferences: {},
    created_at: '2026-01-01T00:00:00Z',
    deleted_at: null,
    ...overrides,
  }
}

const h = vi.hoisted(() => ({ users: [] as unknown[], mutate: vi.fn() }))
vi.mock('swr', () => ({
  default: () => ({ data: h.users, isLoading: false }),
  mutate: (...a: unknown[]) => h.mutate(...a),
}))
const apiDelete = vi.fn()
vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn(),
    patch: vi.fn(),
    post: vi.fn(),
    delete: (...a: unknown[]) => apiDelete(...a),
  },
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }))
vi.mock('@/components/settings/instance-settings-tab', () => ({ InstanceSettingsTab: () => null }))
vi.mock('@/components/settings/branding-tab', () => ({ BrandingTab: () => null }))

import AdminPage from '../page'
import { useAuthStore } from '@/stores/auth-store'

const me = makeUser({ id: 'me', name: 'Me Admin', email: 'me@example.com', is_superadmin: true })
const active = makeUser({ id: 'active', name: 'Active Person', email: 'active@example.com' })
const gone = makeUser({ id: 'gone', name: 'Gone Person', email: 'gone@example.com', status: 'deactivated' })

function rowFor(name: string) {
  return screen.getByText(name).closest('tr') as HTMLElement
}

describe('Admin users: Delete', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.users = [me, active, gone]
    useAuthStore.setState({ user: me, isSuperAdmin: true })
  })

  it('offers Delete only on deactivated rows, never on your own', () => {
    render(<AdminPage />)

    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(1)
    expect(within(rowFor('Gone Person')).getByRole('button', { name: 'Delete' })).toBeInTheDocument()
    expect(within(rowFor('Active Person')).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
    expect(within(rowFor('Me Admin')).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
  })

  it('keeps the dialog open and shows the error when the delete fails', async () => {
    apiDelete.mockRejectedValue(new Error('Deactivate this user before deleting them'))
    render(<AdminPage />)

    fireEvent.click(within(rowFor('Gone Person')).getByRole('button', { name: 'Delete' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() =>
      expect(within(dialog).getByText('Deactivate this user before deleting them')).toBeInTheDocument(),
    )
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(h.mutate).not.toHaveBeenCalled()
  })

  it('deletes the user and refreshes the list', async () => {
    apiDelete.mockResolvedValue(undefined)
    render(<AdminPage />)

    fireEvent.click(within(rowFor('Gone Person')).getByRole('button', { name: 'Delete' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(apiDelete).toHaveBeenCalledWith('/users/gone'))
    await waitFor(() => expect(h.mutate).toHaveBeenCalledWith('/admin/users'))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})
