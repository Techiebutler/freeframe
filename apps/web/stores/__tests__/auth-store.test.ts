import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useAuthStore } from '../auth-store'
import type { User } from '@/types'

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn(),
  },
}))

vi.mock('@/lib/auth', () => ({
  clearTokens: vi.fn(),
}))

import { api } from '@/lib/api'
import { clearTokens } from '@/lib/auth'

const mockUser: User = {
  id: 'user-1',
  email: 'test@example.com',
  name: 'Test User',
  avatar_url: null,
  avatar_color: null,
  status: 'active',
  is_superadmin: false,
  email_verified: true,
  preferences: {},
  created_at: '2024-01-01T00:00:00Z',
  deleted_at: null,
}

describe('Auth store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset store state before each test
    useAuthStore.setState({
      user: null,
      isAuthenticated: false,
      isSuperAdmin: false,
      isLoading: false,
    })
  })

  it('has correct initial state', () => {
    const state = useAuthStore.getState()
    expect(state.user).toBeNull()
    expect(state.isAuthenticated).toBe(false)
    expect(state.isSuperAdmin).toBe(false)
    expect(state.isLoading).toBe(false)
  })

  it('setUser updates state correctly', () => {
    useAuthStore.getState().setUser(mockUser)
    const state = useAuthStore.getState()
    expect(state.user).toEqual(mockUser)
    expect(state.isAuthenticated).toBe(true)
    expect(state.isSuperAdmin).toBe(false)
  })

  it('setUser sets isSuperAdmin when user is super admin', () => {
    const adminUser = { ...mockUser, is_superadmin: true }
    useAuthStore.getState().setUser(adminUser)
    expect(useAuthStore.getState().isSuperAdmin).toBe(true)
  })

  it('logout clears state and calls clearTokens', () => {
    useAuthStore.setState({ user: mockUser, isAuthenticated: true, isSuperAdmin: false })
    useAuthStore.getState().logout()

    const state = useAuthStore.getState()
    expect(state.user).toBeNull()
    expect(state.isAuthenticated).toBe(false)
    expect(state.isSuperAdmin).toBe(false)
    expect(clearTokens).toHaveBeenCalledOnce()
  })

  it('fetchUser calls API and updates state on success', async () => {
    vi.mocked(api.get).mockResolvedValue(mockUser)

    await useAuthStore.getState().fetchUser()

    const state = useAuthStore.getState()
    expect(api.get).toHaveBeenCalledWith('/auth/me')
    expect(state.user).toEqual(mockUser)
    expect(state.isAuthenticated).toBe(true)
    expect(state.isLoading).toBe(false)
  })

  it('fetchUser clears state on API error', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('Unauthorized'))
    useAuthStore.setState({ user: mockUser, isAuthenticated: true })

    await useAuthStore.getState().fetchUser()

    const state = useAuthStore.getState()
    expect(state.user).toBeNull()
    expect(state.isAuthenticated).toBe(false)
    expect(state.isLoading).toBe(false)
  })
})
