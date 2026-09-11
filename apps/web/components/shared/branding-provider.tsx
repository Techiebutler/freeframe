'use client'

import * as React from 'react'
import {
  useBrandingStore,
  brandingValuesFromApi,
  HARDCODED_DEFAULTS,
  type BrandingValues,
  type InstanceBranding,
} from '@/stores/branding-store'

/**
 * Carries the server's copy of instance branding through the render.
 *
 * Branding was only ever fetched from the browser after mount, so every first
 * paint used the built-in defaults: a client opening a white-labelled instance
 * saw the FreeFrame wordmark and name, then their own brand once the round trip
 * landed. On a deployment far from the viewer that gap is long enough to read.
 *
 * The obvious fix -- have the server write the values into the zustand store
 * before rendering -- does not work, for two independent reasons, both measured
 * rather than assumed:
 *
 *  1. A server component and a client component do not share the module. The
 *     store imported by `app/layout.tsx` and the store imported by a `'use
 *     client'` component are different instances in the same process, so
 *     seeding one leaves the other untouched.
 *  2. Even seeding from inside a client component does not help. React caches
 *     the value `useSyncExternalStore` reads for the whole server render, to
 *     guarantee a consistent tree. A component that seeded the store mid-render
 *     saw `getState()` return the new value while every `useBrandingStore()`
 *     call in the same pass still returned the old one.
 *
 * Context is what actually flows through an SSR render, so the server value
 * travels this way and the store keeps doing what it already did on the client.
 */
const ServerBrandingContext = React.createContext<BrandingValues | null>(null)

export function BrandingProvider({
  initial,
  children,
}: {
  initial: InstanceBranding | null
  children: React.ReactNode
}) {
  const value = React.useMemo(
    () => (initial ? brandingValuesFromApi(initial) : null),
    [initial],
  )

  // Hand the same values to the store once we are on the client. From here on
  // the store is the live copy -- the settings screen writes to it after an
  // edit, and a client-side navigation re-reads it -- and `loaded` going true
  // also stops every consumer's `if (!loaded) fetchBranding()` from issuing a
  // request the server already made. That saved round trip is worth the most on
  // exactly the slow links this whole change is about.
  React.useEffect(() => {
    if (initial) useBrandingStore.getState().syncBranding(initial)
  }, [initial])

  return (
    <ServerBrandingContext.Provider value={value}>
      {children}
    </ServerBrandingContext.Provider>
  )
}

/**
 * Instance branding for anything that paints it.
 *
 * Prefers the store once it holds real data, and falls back to the server's
 * copy until then, which is what makes the server-rendered HTML carry the right
 * brand. Consumers that only display branding should use this; the settings
 * screen, which edits it, still talks to the store directly.
 */
export function useBranding(): BrandingValues {
  const server = React.useContext(ServerBrandingContext)
  const store = useBrandingStore()

  if (store.loaded) return store
  return server ?? { ...HARDCODED_DEFAULTS }
}

/**
 * Fetches branding from the browser, but only when the server did not supply
 * it.
 *
 * Every surface that shows branding used to carry its own
 * `if (!loaded) fetchBranding()`, which now would put a request in front of a
 * page that was already served with the answer. When the server did supply it
 * this is a no-op; the request is still made when it did not, which is what
 * keeps a deployment whose web server cannot reach the API working exactly as
 * it did before.
 */
export function useEnsureBranding(): void {
  const server = React.useContext(ServerBrandingContext)
  const loaded = useBrandingStore((s) => s.loaded)
  const fetchBranding = useBrandingStore((s) => s.fetchBranding)

  React.useEffect(() => {
    if (server) return
    if (!loaded) fetchBranding()
  }, [server, loaded, fetchBranding])
}
