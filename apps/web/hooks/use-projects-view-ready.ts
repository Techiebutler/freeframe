'use client'

import * as React from 'react'
import { useAuthStore } from '@/stores/auth-store'
import { PROJECTS_VIEW_STORAGE_KEY, useProjectsViewStore } from '@/stores/projects-view-store'

// Layout effects run before the browser paints, so the settings they apply are
// in place for the first frame. useLayoutEffect warns on the server.
const useIsomorphicLayoutEffect =
  typeof window !== 'undefined' ? React.useLayoutEffect : React.useEffect

/**
 * Loads the Projects page appearance and reports whether it is known yet.
 *
 * The server renders without the user's settings, so anything drawn before
 * this returns true is drawn at the defaults and visibly jumps (medium cards
 * snapping to small, say). The settings are known once this browser's cached
 * copy has been read, or — with nothing cached — once the user's account has
 * loaded (or failed to, which leaves the defaults). The account's value
 * replaces the cached one when it arrives.
 */
export function useProjectsViewReady(): boolean {
  const preferences = useAuthStore((s) => s.user?.preferences)
  const syncFromServer = useProjectsViewStore((s) => s.syncFromServer)
  // Not "not loading and no user": the dashboard layout starts the fetch in
  // an effect, which runs after this page's own, so at mount that also
  // describes a fetch that hasn't started. A fetch that had already failed
  // before the page mounted (a 5xx, a network error) used to leave it blank.
  const userSettled = useAuthStore((s) => s.userFetched)
  const [cache, setCache] = React.useState<'unread' | 'found' | 'missing'>('unread')

  useIsomorphicLayoutEffect(() => {
    let found = false
    try {
      found = window.localStorage.getItem(PROJECTS_VIEW_STORAGE_KEY) !== null
    } catch {
      // Storage blocked: fall back to waiting for the account.
    }
    // Read only now, not when the store is created, so the first client
    // render matches the server's HTML.
    useProjectsViewStore.persist.rehydrate()
    setCache(found ? 'found' : 'missing')
  }, [])

  useIsomorphicLayoutEffect(() => {
    if (preferences) syncFromServer(preferences)
  }, [preferences, syncFromServer])

  return cache === 'found' || (cache === 'missing' && (preferences !== undefined || userSettled))
}
