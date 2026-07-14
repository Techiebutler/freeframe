import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'

// Controllable auth + router state (hoisted so the vi.mock factories can close over it).
const h = vi.hoisted(() => ({
  replace: vi.fn(),
  auth: { user: null as { id: string } | null, isSuperAdmin: false },
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: h.replace }),
}))
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: () => h.auth,
}))

import SettingsPage from '../page'

describe('SettingsPage index redirect', () => {
  beforeEach(() => {
    h.replace.mockClear()
    h.auth = { user: null, isSuperAdmin: false }
  })

  it('does not redirect until the user has loaded (avoids bouncing an admin during pre-load)', () => {
    h.auth = { user: null, isSuperAdmin: false }
    render(<SettingsPage />)
    expect(h.replace).not.toHaveBeenCalled()
  })

  it('sends a superadmin to the admin dashboard', () => {
    h.auth = { user: { id: 'u1' }, isSuperAdmin: true }
    render(<SettingsPage />)
    expect(h.replace).toHaveBeenCalledWith('/settings/admin')
  })

  it('sends a normal user to appearance — they cannot open /settings/admin', () => {
    h.auth = { user: { id: 'u2' }, isSuperAdmin: false }
    render(<SettingsPage />)
    expect(h.replace).toHaveBeenCalledWith('/settings/appearance')
  })
})
