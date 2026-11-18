import { isExpiringSoon } from '@/hooks/use-sse'
import { refreshAccessTokenQuietly } from '@/lib/auth'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

const FALLBACK_DETAIL = 'Request failed'

/** The server's own words for a bearer it could not resolve (ruling R8), used
 *  for the same case when the client finds out first. */
export const SIGN_IN_EXPIRED = 'Your sign-in has expired. Sign in again or continue as a guest.'

/** A write refused (or never sent) because the sign-in has lapsed. */
export function isSignInExpired(err: unknown): boolean {
  return (err as { status?: unknown } | null | undefined)?.status === 401
}

export interface ShareGuest {
  name: string
  email: string
}

function storedAccessToken(): string | null {
  try {
    return localStorage.getItem('ff_access_token')
  } catch {
    return null
  }
}

/** The stored access token, when there is one and it has not run out. */
function usableAccessToken(): string | null {
  const token = storedAccessToken()
  return token && !isExpiringSoon(token) ? token : null
}

/**
 * Whether anyone has signed in on this browser, lapsed or not. Someone who has
 * is not asked for a guest name before a verdict: their write refreshes the
 * sign-in or asks them what to do (`shareRequest`).
 */
export function hasStoredToken(): boolean {
  return !!storedAccessToken()
}

/**
 * Whether a share request will go out as the signed-in user. The one rule for
 * both "do I send the bearer?" and "do I need to ask who this is?", so the two
 * cannot disagree: a lapsed login is not a sign-in, and a guest identity left
 * in storage must never stand in for a login that is still good.
 */
export function hasUsableToken(): boolean {
  return usableAccessToken() !== null
}

/**
 * One call to a share-link route, `/share/{token}{path}`.
 *
 * The bearer goes only when it is present and unexpired. Only without it do
 * the guest's fields go: name and email in the body of a PUT, the email alone
 * in the query of a GET or DELETE. A failure throws the server's string
 * `detail` (as `message` and `detail`), or "Request failed".
 *
 * A lapsed sign-in is never turned into a guest behind the person's back (a
 * team member's verdict must not be counted as a guest's):
 * - A write (PUT, DELETE) first refreshes the sign-in, quietly, without
 *   leaving the page. If that works it goes with the new bearer. If not,
 *   nothing is sent and it throws `SIGN_IN_EXPIRED` with status 401, and the
 *   caller asks them to sign in again or continue as a guest.
 * - `asGuest` is that explicit choice: with no usable bearer, go as the guest
 *   without trying to refresh. A usable bearer still wins.
 * - A read goes as the guest, with no refresh and no question.
 */
export async function shareRequest<T>(
  token: string,
  path: string,
  init: {
    method: 'GET' | 'PUT' | 'DELETE'
    body?: object
    shareSession?: string | null
    guest?: ShareGuest | null
    /** They chose "Continue as guest" over signing in again. */
    asGuest?: boolean
  },
): Promise<T> {
  let bearer = usableAccessToken()
  if (!bearer && hasStoredToken() && init.method !== 'GET' && !init.asGuest) {
    bearer = await refreshAccessTokenQuietly()
    if (!bearer) {
      throw Object.assign(new Error(SIGN_IN_EXPIRED), { status: 401, detail: SIGN_IN_EXPIRED })
    }
  }
  const guest = bearer ? null : init.guest ?? null

  const url = new URL(`${API_URL}/share/${encodeURIComponent(token)}${path}`)
  if (init.shareSession) url.searchParams.set('share_session', init.shareSession)
  if (guest && init.method !== 'PUT') url.searchParams.set('guest_email', guest.email)

  const headers: Record<string, string> = {}
  if (bearer) headers.Authorization = `Bearer ${bearer}`

  let body: string | undefined
  if (init.method === 'PUT') {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify({
      ...(init.body ?? {}),
      ...(guest ? { guest_name: guest.name, guest_email: guest.email } : {}),
    })
  }

  const res = await fetch(url.toString(), { method: init.method, headers, body })

  if (!res.ok) {
    let detail: string | null = null
    try {
      const data = await res.json()
      if (typeof data?.detail === 'string' && data.detail) detail = data.detail
    } catch {
      // No JSON body, as from a proxy: the fallback says it.
    }
    // `detail` only when the server gave one, so a caller can tell its words
    // from ours, as with `ApiError`.
    throw Object.assign(new Error(detail ?? FALLBACK_DETAIL), detail ? { status: res.status, detail } : { status: res.status })
  }

  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}
