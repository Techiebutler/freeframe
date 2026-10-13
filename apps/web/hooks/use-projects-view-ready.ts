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
  const userLoading = useAuthStore((s) => s.isLoading)
  const [cache, setCache] = React.useState<'unread' | 'found' | 'missing'>('unread')

  // isLoading starts false before the first fetch, so "not loading" alone
  // doesn't mean the fetch is over: it must have been seen loading first.
  const sawUserLoading = React.useRef(userLoading)
  const [userSettled, setUserSettled] = React.useState(false)
  React.useEffect(() => {
    if (userLoading) sawUserLoading.current = true
    else if (sawUserLoading.current) setUserSettled(true)
  }, [userLoading])

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
