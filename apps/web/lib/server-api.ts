/**
 * Where the web *server* reaches the API.
 *
 * This is NOT `NEXT_PUBLIC_API_URL`. That one is written for the browser — a
 * public domain, or a LAN address — and inside the web container
 * `localhost:8000` is the web container itself, not the API. `API_INTERNAL_URL`
 * is the server-to-server address (`http://api:8000` under compose). It falls
 * back to the public one so a deployment that has not set it, and any setup
 * where both happen to be the same host, keeps working.
 *
 * Shared by the branding fetch and the short-share-link lookup.
 */
export const INTERNAL_API_URL =
  process.env.API_INTERNAL_URL ||
  process.env.NEXT_PUBLIC_API_URL ||
  'http://localhost:8000'

/** Long enough for a slow container start, short enough not to hold a page. */
export const SERVER_FETCH_TIMEOUT_MS = 3000
