import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import type { User } from '@/types'

function makeUser(overrides: Partial<User>): User {
  return {
    id: 'u',
    email: 'u@example.com',
    name: 'U',
    avatar_url: null,
    avatar_color: null,
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
const invited = makeUser({
  id: 'invited',
  name: 'wrong.address',
  email: 'wrong.address@example.com',
  status: 'pending_invite',
  email_verified: false,
  invite_token: 'tok',
})
// Signed in with an email code back when a code still let a pending invitee in.
const signedIn = makeUser({
  id: 'signed-in',
  name: 'Code Signer',
  email: 'code.signer@example.com',
  status: 'pending_invite',
  email_verified: true,
  invite_token: 'tok2',
})

function rowFor(name: string) {
  return screen.getByText(name).closest('tr') as HTMLElement
}

describe('Admin users: Delete', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.users = [me, active, gone]
    useAuthStore.setState({ user: me, isSuperAdmin: true })
  })

  it('offers Delete only on deactivated rows', () => {
    render(<AdminPage />)

    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(1)
    expect(within(rowFor('Gone Person')).getByRole('button', { name: 'Delete' })).toBeInTheDocument()
    expect(within(rowFor('Active Person')).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
  })

  it('never offers Delete on your own row, even when it is deactivated', () => {
    h.users = [{ ...me, status: 'deactivated' }, active, gone]
    render(<AdminPage />)

    expect(within(rowFor('Me Admin')).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
    expect(within(rowFor('Gone Person')).getByRole('button', { name: 'Delete' })).toBeInTheDocument()
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

describe('Admin users: Revoke invite', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.users = [me, active, gone, invited]
    useAuthStore.setState({ user: me, isSuperAdmin: true })
  })

  it('offers Revoke Invite only on pending rows', () => {
    render(<AdminPage />)

    expect(screen.getAllByRole('button', { name: 'Revoke Invite' })).toHaveLength(1)
    expect(within(rowFor('wrong.address')).getByRole('button', { name: 'Revoke Invite' })).toBeInTheDocument()
    expect(within(rowFor('wrong.address')).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
  })

  it('offers Deactivate, not Revoke Invite, on a pending row whose owner already signed in', () => {
    h.users = [me, invited, signedIn]
    render(<AdminPage />)

    expect(within(rowFor('Code Signer')).queryByRole('button', { name: 'Revoke Invite' })).not.toBeInTheDocument()
    expect(within(rowFor('Code Signer')).getByRole('button', { name: 'Deactivate' })).toBeInTheDocument()
    expect(within(rowFor('wrong.address')).queryByRole('button', { name: 'Deactivate' })).not.toBeInTheDocument()
  })

  it('revokes the invite by deleting the pending user', async () => {
    apiDelete.mockResolvedValue(undefined)
    render(<AdminPage />)

    fireEvent.click(within(rowFor('wrong.address')).getByRole('button', { name: 'Revoke Invite' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Revoke the invite for wrong.address@example.com?')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke Invite' }))

    await waitFor(() => expect(apiDelete).toHaveBeenCalledWith('/users/invited'))
    await waitFor(() => expect(h.mutate).toHaveBeenCalledWith('/admin/users'))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})
