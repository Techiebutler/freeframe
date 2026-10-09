import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import type { User } from '@/types'

vi.mock('swr', () => ({
  default: () => ({ data: [], isLoading: false }),
  mutate: vi.fn(),
}))
const post = vi.fn()
vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn(),
    patch: vi.fn(),
    post: (...a: unknown[]) => post(...a),
    delete: vi.fn(),
  },
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }))
vi.mock('@/components/settings/instance-settings-tab', () => ({ InstanceSettingsTab: () => null }))
vi.mock('@/components/settings/branding-tab', () => ({ BrandingTab: () => null }))

import AdminPage from '../page'
import { useAuthStore } from '@/stores/auth-store'

const me = {
  id: 'me',
  email: 'me@example.com',
  name: 'Me Admin',
  status: 'active',
  is_superadmin: true,
} as User

describe('Admin users: Bulk Invite', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAuthStore.setState({ user: me, isSuperAdmin: true })
  })

  it("reports a deleted user's email separately and keeps the dialog open", async () => {
    // The API's messages for each case; the dialog sorts by them.
    post.mockImplementation((_url: string, body: { email: string }) => {
      if (body.email === 'taken@example.com') return Promise.reject(new Error('Email already registered'))
      if (body.email === 'former@example.com')
        return Promise.reject(new Error("This email belonged to a deleted user and can't be invited again"))
      return Promise.resolve({})
    })
    render(<AdminPage />)

    fireEvent.click(screen.getByRole('button', { name: /bulk invite/i }))
    const dialog = screen.getByRole('dialog')
    const textarea = within(dialog).getByRole('textbox')
    const emails = 'new@example.com\ntaken@example.com\nformer@example.com'
    fireEvent.change(textarea, { target: { value: emails } })
    fireEvent.click(within(dialog).getByRole('button', { name: /send invites/i }))

    await waitFor(() =>
      expect(
        within(dialog).getByText('1 invite(s) sent, 1 already registered, 1 belonged to a deleted user'),
      ).toBeInTheDocument(),
    )
    expect(
      within(dialog).getByText("Can't invite former@example.com: the email belonged to a deleted user"),
    ).toBeInTheDocument()
    expect(within(dialog).queryByText(/failed to invite/i)).not.toBeInTheDocument()
    // Not cleared or closed: the admin still has to deal with the deleted address.
    expect(textarea).toHaveValue(emails)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})
