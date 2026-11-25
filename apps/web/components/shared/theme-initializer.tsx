'use client'

import { useEffect } from 'react'
import { useThemeStore } from '@/stores/theme-store'
import { useAuthStore } from '@/stores/auth-store'

export function ThemeInitializer() {
  const theme = useThemeStore((s) => s.theme)
  const applyTheme = useThemeStore((s) => s.applyTheme)
  const syncFromServer = useThemeStore((s) => s.syncFromServer)
  const user = useAuthStore((s) => s.user)

  // Apply saved theme on mount (local only, no server save). Read from the store,
  // not from the render: while it hydrates, a component is given the store's
  // initial state, and applying that would save dark over the stored choice.
  useEffect(() => {
    applyTheme(useThemeStore.getState().theme)
  }, [applyTheme])

  // Sync from server when user loads (server wins if it has a value)
  useEffect(() => {
    if (user?.preferences) {
      syncFromServer(user.preferences)
    }
  }, [user?.preferences, syncFromServer])

  // Listen for system theme changes when in 'system' mode
  useEffect(() => {
    if (theme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => applyTheme('system')
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [theme, applyTheme])

  return null
}
