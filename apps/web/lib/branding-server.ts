import * as React from 'react'
import type { InstanceBranding } from '@/stores/branding-store'

/**
 * Instance branding, read on the server so the first byte already carries it.
 *
 * Branding used to be fetched only from the browser, after mount. Until that
 * round trip landed the whole app rendered the built-in defaults, so a client
 * opening a white-labelled instance saw the FreeFrame wordmark, the FreeFrame
 * name and `<title>FreeFrame</title>` first and their own brand a moment later.
 * On a deployment far from the viewer that moment is long enough to read.
 *
 * The URL here is NOT `NEXT_PUBLIC_API_URL`. That one is written for the
 * browser -- a public domain, or a LAN address -- and inside the web container
 * `localhost:8000` is the web container itself, not the API. `API_INTERNAL_URL`
 * is the server-to-server address (`http://api:8000` under compose). It falls
 * back to the public one so a deployment that has not set it, and any setup
 * where both happen to be the same host, keeps working.
 */
const INTERNAL_API_URL =
  process.env.API_INTERNAL_URL ||
  process.env.NEXT_PUBLIC_API_URL ||
  'http://localhost:8000'

/** Long enough for a slow container start, short enough not to hold a page. */
const TIMEOUT_MS = 3000

/**
 * The uncached fetch. Exported for tests: `cache` memoises for the life of the
 * call, which would make the first result the only one a test could ever see.
 */
export async function fetchServerBranding(): Promise<InstanceBranding | null> {
    try {
      const res = await fetch(`${INTERNAL_API_URL}/instance/branding`, {
        // Revalidated rather than uncached: this is one row that changes when an
        // admin edits it, and re-fetching it on every render of every page would
        // put a round trip in front of each one. An admin's own view updates
        // immediately, since the settings screen syncs the store from its own
        // PUT response; everyone else picks the change up within the window.
        next: { revalidate: 60 },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) return null
      return (await res.json()) as InstanceBranding
    } catch {
      // Never throw. This runs during `next build`, where there is no API to
      // answer, and inside a layout, where throwing would replace the whole page
      // with an error. Returning null means the client fetches branding the way
      // it always did, so the worst case is the behaviour we had before.
      return null
    }
}

/**
 * `cache` dedupes this within a single render pass, so `generateMetadata` and
 * the layout body share one request rather than issuing two.
 *
 * It only exists under React's server condition -- outside it, including under
 * the test runner, importing it gives `undefined` and calling it throws. The
 * fallback is the plain function: correct everywhere, just without the
 * deduplication, which nothing outside a server render needs.
 */
const memoize = (React as { cache?: <T>(fn: T) => T }).cache
export const getServerBranding = memoize
  ? memoize(fetchServerBranding)
  : fetchServerBranding
