import { withBasePath } from './base-path'
import { subjectOf } from './jwt-subject'

const ACCESS_TOKEN_KEY = 'ff_access_token'
const REFRESH_TOKEN_KEY = 'ff_refresh_token'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

export function getAccessToken(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem(ACCESS_TOKEN_KEY)
}

export function getRefreshToken(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem(REFRESH_TOKEN_KEY)
}

export function setTokens(access: string, refresh: string): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(ACCESS_TOKEN_KEY, access)
  localStorage.setItem(REFRESH_TOKEN_KEY, refresh)
  // Set cookies so the proxy can check auth on server side
  document.cookie = `${ACCESS_TOKEN_KEY}=${access}; path=/; max-age=${60 * 60 * 24 * 7}; SameSite=Lax`
  document.cookie = `${REFRESH_TOKEN_KEY}=${refresh}; path=/; max-age=${60 * 60 * 24 * 7}; SameSite=Lax`
}

/**
 * Set when the session is ended on purpose, so the leave-page warning
 * (`hooks/use-upload-leave-guard.ts`) stays quiet for the navigation to /login
 * that follows. Never cleared in a real page: the next thing that happens to
 * this document is that it goes away. If it does not (the load is aborted, or
 * the page comes back from the back/forward cache), `isLeaveGuardSuppressed`
 * stops honouring it as soon as there is a session again.
 */
let leaveGuardSuppressed = false

/**
 * Whether the browser must not be asked to prompt for the navigation in
 * progress: the session was ended on purpose and has not come back since. The
 * prompt exists for a session worth keeping the page for, and with a token in
 * storage again, signed in on this document or in another tab, there is one.
 */
export function isLeaveGuardSuppressed(): boolean {
  return leaveGuardSuppressed && getAccessToken() === null
}

/** Exported for tests. */
export function resetLeaveGuardSuppression(): void {
  leaveGuardSuppressed = false
}

const sessionEndListeners = new Set<() => void>()

/**
 * Calls `cb` when this tab ends the session (`clearTokens`), after the tokens
 * are gone and before the page starts to leave. A tab is never sent the
 * `storage` event for its own writes, so this is the only way code in this tab
 * hears of it in time. Returns the unsubscribe function.
 */
export function onSessionEnded(cb: () => void): () => void {
  sessionEndListeners.add(cb)
  return () => {
    sessionEndListeners.delete(cb)
  }
}

/**
 * Ends the session in this tab: the tokens go and the page loads /login.
 *
 * Every caller means it. A refresh the server refused, or one with no token to
 * send, ends the session by force, and a Log out has already asked about the
 * uploads it would stop (`components/layout/sidebar.tsx`). Either way the
 * tokens are gone before the page leaves, so the browser's "Leave site?"
 * prompt has nothing to offer: "Stay" would leave a tab with no session that
 * signs itself out again on the next request. The flag is set before the
 * navigation, every time.
 *
 * `onSessionEnded` listeners run once the tokens are gone and before the
 * navigation: the upload store saves the files it holds only in memory. A
 * listener that throws does not keep the page from leaving.
 */
export function clearTokens(): void {
  if (typeof window === 'undefined') return
  endSession()
  window.location.href = withBasePath('/login')
}

/**
 * Ends the session as `clearTokens` does, then opens /login with `from` set,
 * so a sign-in made there can come back to `from` (an app path, without the
 * basePath; the login page checks it with `safeInternalPath`).
 *
 * For a page that is not behind a login, like a share link, whose visitor
 * chose to sign in again: their dead tokens must go first, or /login would see
 * a token in storage and send them straight back.
 */
export function signInAgain(from: string): void {
  if (typeof window === 'undefined') return
  endSession()
  window.location.href = withBasePath(`/login?from=${encodeURIComponent(from)}`)
}

/** Everything `clearTokens` does short of leaving the page. */
function endSession(): void {
  leaveGuardSuppressed = true
  localStorage.removeItem(ACCESS_TOKEN_KEY)
  localStorage.removeItem(REFRESH_TOKEN_KEY)
  // Clear auth cookies
  document.cookie = `${ACCESS_TOKEN_KEY}=; path=/; max-age=0`
  document.cookie = `${REFRESH_TOKEN_KEY}=; path=/; max-age=0`
  sessionEndListeners.forEach((cb) => {
    try {
      cb()
    } catch (err) {
      console.warn('A listener failed as the session ended', err)
    }
  })
}

// Deduplicate concurrent refresh calls — when access token expires, multiple
// API calls may simultaneously get 401 and try to refresh. Only one should run.
let _refreshPromise: Promise<string | null> | null = null

export async function refreshAccessToken(): Promise<string | null> {
  if (_refreshPromise) return _refreshPromise

  _refreshPromise = _doRefresh(true)
  try {
    return await _refreshPromise
  } finally {
    _refreshPromise = null
  }
}

let _quietRefreshPromise: Promise<string | null> | null = null

/**
 * `refreshAccessToken` for a page that must not be left: it never clears the
 * tokens and never navigates, whatever the answer. A refused refresh, no
 * refresh token, or no network is just null, and the caller decides what to
 * ask. A share page uses it, where /login would lose the review on screen.
 *
 * Its own dedup, so a page-leaving refresh never joins a quiet one (or the
 * other way round) and inherits the wrong handling of a refusal.
 */
export async function refreshAccessTokenQuietly(): Promise<string | null> {
  if (_quietRefreshPromise) return _quietRefreshPromise

  _quietRefreshPromise = _doRefresh(false)
  try {
    return await _quietRefreshPromise
  } finally {
    _quietRefreshPromise = null
  }
}

/**
 * What a refresh answers once the session in storage is no longer the one whose
 * refresh token it sent. localStorage is shared by every tab, so another tab
 * may have signed in, signed out or refreshed while the request was out, and
 * writing this answer over it, or clearing it on a refusal, would replace or
 * end that session in every tab. Nothing is written. If storage now holds the
 * same account, another tab refreshed it or signed it in again, and its access
 * token is the answer; otherwise null, "could not refresh".
 */
function sessionMovedOn(sentRefreshToken: string): string | null {
  const access = getAccessToken()
  const sub = subjectOf(access)
  return sub !== null && sub === subjectOf(sentRefreshToken) ? access : null
}

/** `endsSession`: whether a refusal (or nothing to send) ends the session. */
async function _doRefresh(endsSession: boolean): Promise<string | null> {
  const refreshToken = getRefreshToken()
  if (!refreshToken) {
    if (endsSession) clearTokens()
    return null
  }

  try {
    const response = await fetch(`${API_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    })

    if (!response.ok) {
      if (getRefreshToken() !== refreshToken) return sessionMovedOn(refreshToken)
      // Only a refusal ends the session. 401 or 403 is the server saying this
      // refresh token is no longer valid, which is what signing out is for.
      // Anything else -- a 502 from a proxy mid-deploy, a 500, a rate limit --
      // is the server being briefly unavailable, and signing the user out for
      // it loses whatever they had open.
      if (endsSession && (response.status === 401 || response.status === 403)) {
        clearTokens()
      }
      return null
    }

    const data = await response.json()
    if (getRefreshToken() !== refreshToken) return sessionMovedOn(refreshToken)
    const newAccessToken: string = data.access_token
    const newRefreshToken: string = data.refresh_token ?? refreshToken

    setTokens(newAccessToken, newRefreshToken)
    return newAccessToken
  } catch {
    // `fetch` rejects only on a transport failure; an HTTP error status
    // resolves and is handled above. So reaching here means the request never
    // got an answer: no network, DNS, a dropped connection. Clearing tokens
    // here signed people out for going through a tunnel, and took the page
    // they were on with it, since `clearTokens` navigates to /login.
    //
    // Callers treat null as "could not refresh" and let the original failure
    // surface, so keeping the tokens costs nothing and the session survives
    // until the network comes back.
    return null
  }
}
