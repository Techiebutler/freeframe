'use client'

import { useEffect, useState } from 'react'
import { resolveTheme, useThemeStore } from '@/stores/theme-store'

/**
 * The theme actually being rendered: the stored preference with 'system' resolved
 * against the OS setting. The first render mirrors the server, where 'system' can't
 * be resolved and falls back to dark; the effect corrects it right after mount.
 */
export function useResolvedTheme(): 'dark' | 'light' {
  const theme = useThemeStore((s) => s.theme)
  const [resolved, setResolved] = useState<'dark' | 'light'>(
    theme === 'light' ? 'light' : 'dark',
  )

  useEffect(() => {
    setResolved(resolveTheme(theme))
  }, [theme])

  return resolved
}
