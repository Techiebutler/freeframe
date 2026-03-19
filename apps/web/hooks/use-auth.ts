'use client'

import { useRouter } from 'next/navigation'
import { useAuthStore } from '@/stores/auth-store'
import { api } from '@/lib/api'
import { setTokens } from '@/lib/auth'
import type { AuthTokens, User } from '@/types'

export interface UseAuthReturn {
  /** Current authenticated user, or null if not logged in */
  user: User | null
  /** Whether the user has a valid session */
  isAuthenticated: boolean
  /** Whether the user has super-admin privileges */
  isSuperAdmin: boolean
  /** Whether a user-fetch is in progress */
  isLoading: boolean
  /** Log in with email + password and redirect to dashboard */
  login: (email: string, password: string) => Promise<void>
  /** Clear tokens and redirect to /login */
  logout: () => void
}

export function useAuth(): UseAuthReturn {
  const router = useRouter()
  const { user, isAuthenticated, isSuperAdmin, isLoading, setUser, logout: storeLogout } = useAuthStore()

  async function login(email: string, password: string): Promise<void> {
    const tokens = await api.post<AuthTokens>('/auth/login', { email, password })
    setTokens(tokens.access_token, tokens.refresh_token)

    // Fetch user profile and populate store
    const me = await api.get<User>('/auth/me')
    setUser(me)

    // Redirect based on role
    if (me.is_superadmin) {
      router.push('/god-mode')
    } else {
      router.push('/')
    }
  }

  function logout(): void {
    storeLogout()
    router.push('/login')
  }

  return {
    user,
    isAuthenticated,
    isSuperAdmin,
    isLoading,
    login,
    logout,
  }
}
