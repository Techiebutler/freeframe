import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import ProfilePage from '@/app/(dashboard)/settings/profile/page'
import { api } from '@/lib/api'
import { setTokens } from '@/lib/auth'

vi.mock('@/stores/auth-store', () => ({ useAuthStore: () => ({ user: null }) }))
vi.mock('@/components/settings/profile-avatar-editor', () => ({ ProfileAvatarEditor: () => null }))
vi.mock('@/lib/api', () => ({ api: { patch: vi.fn() } }))
vi.mock('@/lib/auth', () => ({ setTokens: vi.fn() }))

it('installs the new access token even when the refresh token only comes in a cookie', async () => {
  vi.mocked(api.patch).mockResolvedValue({ access_token: 'new-access' })
  render(<ProfilePage />)
  fireEvent.change(screen.getByLabelText('Current Password'), { target: { value: 'old-password' } })
  fireEvent.change(screen.getByLabelText('New Password', { exact: true }), { target: { value: 'new-password' } })
  fireEvent.change(screen.getByLabelText('Confirm New Password'), { target: { value: 'new-password' } })
  fireEvent.submit(screen.getByLabelText('Current Password').closest('form')!)
  expect(await screen.findByText('Password changed successfully.')).toBeInTheDocument()
  expect(setTokens).toHaveBeenCalledWith('new-access', undefined)
})
