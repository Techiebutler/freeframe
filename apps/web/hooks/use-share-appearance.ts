'use client'

import * as React from 'react'
import { accentVars } from '@/lib/accent'

const ACCENT_STYLE_ID = 'ff-share-accent'

/**
 * Apply a share link's own theme and accent for as long as its page is open.
 *
 * Both share surfaces need this: the folder grid and the single-asset viewer.
 * Only the folder grid ever had it, so a single-asset link silently ignored the
 * theme and accent colour an admin had set on it, and rendered with the
 * instance's instead. Keeping it in one hook is what stops the two drifting
 * apart again.
 *
 * The accent is injected as a stylesheet rule marked !important so it outranks
 * the instance-level accent, which BrandingHead sets as an inline style on the
 * same element: a link's own appearance has to win on its own page.
 */
export function useShareAppearance(accentColor: string | null | undefined, isDark: boolean) {
  React.useEffect(() => {
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light')
    return () => {
      // Hand the viewer back their own theme on the way out.
      try {
        const stored = JSON.parse(localStorage.getItem('ff-theme') || '{}')
        const userTheme = stored?.state?.theme || 'dark'
        const resolved =
          userTheme === 'system'
            ? window.matchMedia('(prefers-color-scheme: dark)').matches
              ? 'dark'
              : 'light'
            : userTheme
        document.documentElement.setAttribute('data-theme', resolved)
      } catch {
        document.documentElement.setAttribute('data-theme', 'dark')
      }
    }
  }, [isDark])

  React.useEffect(() => {
    // Nothing configured means nothing to override. Injecting a fallback here
    // would repaint every share link that never set an accent, which is a
    // visible change to links that already exist rather than a feature.
    const vars = accentColor ? accentVars(accentColor) : null
    if (!vars) {
      document.getElementById(ACCENT_STYLE_ID)?.remove()
      return
    }

    let el = document.getElementById(ACCENT_STYLE_ID) as HTMLStyleElement | null
    if (!el) {
      el = document.createElement('style')
      el.id = ACCENT_STYLE_ID
      document.head.appendChild(el)
    }
    // All three tokens, not just --accent: overriding the base colour alone
    // left the hover and muted shades on the instance's colour, so a button
    // repainted but its hover state did not.
    el.textContent = `:root { ${Object.entries(vars)
      .map(([k, v]) => `${k}: ${v} !important;`)
      .join(' ')} }`
    return () => {
      document.getElementById(ACCENT_STYLE_ID)?.remove()
    }
  }, [accentColor])
}
