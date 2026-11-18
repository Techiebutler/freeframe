'use client'

import { useCallback, useSyncExternalStore } from 'react'

/** Layout switch: bottom sheet below, inline comment column above. */
export const MEDIA_MD = '(min-width: 768px)'
/** Transport row: collapsed to 4 buttons + timecode below, full row above. */
export const MEDIA_SM = '(min-width: 640px)'

/**
 * One MediaQueryList per query string, shared by every caller. Without this,
 * each mount allocates a fresh list and React re-subscribes on every render
 * whose `subscribe` identity changed.
 */
const mediaQueryLists = new Map<string, MediaQueryList>()

function getMediaQueryList(query: string): MediaQueryList | null {
  // Missing matchMedia (jsdom without the stub, ancient browser) is not an
  // error: fall through to `false`, which means "compact" for every min-width
  // query this app uses, and never subscribe.
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null
  let mql = mediaQueryLists.get(query)
  if (!mql) {
    mql = window.matchMedia(query)
    mediaQueryLists.set(query, mql)
  }
  return mql
}

/**
 * The server snapshot is `false` DELIBERATELY. Every caller passes a
 * min-width query, so `false` means "compact" and any pre-hydration render
 * produces the narrow layout.
 *
 * This inverts the `sharePanelDefaultOpen` helper it replaces, which returned
 * `true` when `window` was undefined — it opened the 360px panel on the
 * server. Inverting is the safe direction: the narrow layout is merely
 * non-ideal on a desktop, whereas the wide layout on a phone is the bug this
 * work exists to fix.
 *
 * Module-level so its identity is stable across renders; an inline arrow here
 * would make useSyncExternalStore re-read on every render.
 */
function getServerSnapshot(): boolean {
  return false
}

/**
 * SSR-safe reactive breakpoint. Pass one of MEDIA_MD / MEDIA_SM so the
 * TypeScript guard and the matching Tailwind `md:` / `sm:` class can never
 * disagree — apps/web/tailwind.config.ts declares no `screens` override, so
 * both are Tailwind's defaults.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const mql = getMediaQueryList(query)
      if (!mql) return () => {}
      mql.addEventListener('change', onStoreChange)
      return () => mql.removeEventListener('change', onStoreChange)
    },
    [query],
  )

  const getSnapshot = useCallback(() => getMediaQueryList(query)?.matches ?? false, [query])

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
