import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type Theme = 'dark' | 'light' | 'system'

interface ThemeState {
  theme: Theme
  /** Apply theme locally only (no server save) — used by initializer */
  applyTheme: (theme: Theme) => void
  /** Set theme + save to server — used by settings page */
  setTheme: (theme: Theme) => void
  /** Sync from server preferences (on login) — only if server has a value */
  syncFromServer: (preferences: Record<string, unknown>) => void
}

function resolveTheme(theme: Theme): 'dark' | 'light' {
  if (theme === 'system') {
    if (typeof window !== 'undefined') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    }
    return 'dark'
  }
  return theme
}

function applyToDOM(theme: Theme) {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute('data-theme', resolveTheme(theme))
}

async function saveToServer(theme: Theme) {
  try {
    const token = typeof window !== 'undefined' ? localStorage.getItem('ff_access_token') : null
    if (!token) return
    const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'
    await fetch(`${API_URL}/auth/me/preferences`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ theme }),
    })
  } catch {}
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      theme: 'dark',

      applyTheme: (theme) => {
        applyToDOM(theme)
        set({ theme })
      },

      setTheme: (theme) => {
        applyToDOM(theme)
        set({ theme })
        saveToServer(theme)
      },

      syncFromServer: (preferences) => {
        const serverTheme = preferences?.theme as Theme | undefined
        if (serverTheme && ['dark', 'light', 'system'].includes(serverTheme)) {
          applyToDOM(serverTheme)
          set({ theme: serverTheme })
        }
      },
    }),
    {
      name: 'ff-theme',
      onRehydrateStorage: () => (state) => {
        // Apply theme as soon as localStorage is loaded (before React renders)
        if (state) applyToDOM(state.theme)
      },
    },
  ),
)
