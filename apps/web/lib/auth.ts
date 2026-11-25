import { withBasePath } from './base-path'
import { subjectOf } from './jwt-subject'
import { API_URL, usesRefreshCookie, webClientHeaders } from './auth-transport'

const ACCESS_TOKEN_KEY = 'ff_access_token'
const REFRESH_TOKEN_KEY = 'ff_refresh_token'

// Only a notification nonce is shared with other tabs, never a credential.
export const SESSION_NOTICE_KEY = 'ff_session_notice'
let memoryAccess: string | null = null
let sessionGeneration = 0
let bootstrap: Promise<RefreshOutcome> | null = null
let retryCookieRefreshAt = 0

function clearLegacyStorage(): void {
  localStorage.removeItem(ACCESS_TOKEN_KEY)
  localStorage.removeItem(REFRESH_TOKEN_KEY)
  document.cookie = `${ACCESS_TOKEN_KEY}=; path=/; max-age=0`
}

function notice(): string | null {
  return localStorage.getItem(SESSION_NOTICE_KEY)
}

function announceSessionChange(): void {
  localStorage.setItem(SESSION_NOTICE_KEY, String(crypto.getRandomValues(new Uint32Array(4))))
}

// A stale refresh response can update Set-Cookie even if JS drops its access
// token. Serialize cookie-changing requests across tabs where Web Locks are
// supported, and in the current tab on older browsers.
let cookieQueue: Promise<unknown> = Promise.resolve()
export async function withCookieMutation<T>(run: () => Promise<T>): Promise<T> {
  if (navigator.locks) return await navigator.locks.request('ff-auth-cookie', run)
  const next = cookieQueue.then(run)
  cookieQueue = next.catch(() => {})
  return next
}

export function getAccessToken(): string | null {
  if (typeof window === 'undefined') return null
  return usesRefreshCookie() ? memoryAccess : localStorage.getItem(ACCESS_TOKEN_KEY)
}

export function getRefreshToken(): string | null {
  if (typeof window === 'undefined') return null
  return usesRefreshCookie() ? null : localStorage.getItem(REFRESH_TOKEN_KEY)
}

export function setTokens(access: string, refresh?: string): void {
  if (typeof window === 'undefined') return
  if (usesRefreshCookie()) {
    sessionGeneration++
    memoryAccess = access
    retryCookieRefreshAt = 0
    bootstrap = Promise.resolve({ token: access })
    clearLegacyStorage()
    announceSessionChange()
    return
  }
  if (!refresh) return
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
export function clearTokens(): void | Promise<boolean> {
  if (typeof window === 'undefined') return
  return leaveForLogin('/login')
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
  leaveForLogin(`/login?from=${encodeURIComponent(from)}`)
}

function leaveForLogin(path: string): void | Promise<boolean> {
  if (!usesRefreshCookie()) {
    endSession()
    window.location.href = withBasePath(path)
    return
  }
  // Clear the HttpOnly cookie before navigating. If the request does not
  // succeed, keep the current session and let the user try logging out again.
  return withCookieMutation(async () => {
    const response = await fetch(`${API_URL}/auth/logout`, {
      method: 'POST', credentials: 'same-origin', headers: webClientHeaders(),
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    endSession()
    announceSessionChange()
    window.location.href = withBasePath(path)
    return true
  }).catch(() => {
    window.alert('Could not end your session. Please try again.')
    return false
  })
}

/** Everything `clearTokens` does short of leaving the page. */
function endSession(): void {
  leaveGuardSuppressed = true
  sessionGeneration++
  memoryAccess = null
  retryCookieRefreshAt = 0
  bootstrap = null
  clearLegacyStorage()
  if (!usesRefreshCookie()) document.cookie = `${REFRESH_TOKEN_KEY}=; path=/; max-age=0`
  notifySessionEnded()
}

function notifySessionEnded(): void {
  sessionEndListeners.forEach((cb) => {
    try {
      cb()
    } catch (err) {
      console.warn('A listener failed as the session ended', err)
    }
  })
}

// An auth change in another tab invalidates this document's in-memory bearer
// and any pending refresh result. Do not adopt another account's bearer.
if (typeof window !== 'undefined' && usesRefreshCookie()) {
  window.addEventListener('storage', (event) => {
    if (event.key === SESSION_NOTICE_KEY) endSession()
  })
}

/** A single, quiet cookie refresh on entry, shared by all consumers. */
export function bootstrapSession(): Promise<RefreshOutcome> {
  const token = getAccessToken()
  if (token) return Promise.resolve({ token })
  if (!usesRefreshCookie()) return Promise.resolve({ failed: 'refused' })
  return bootstrap ??= refreshAccessTokenQuietly()
}

export async function ensureAccessToken(): Promise<string | null> {
  const result = await bootstrapSession()
  return 'token' in result ? result.token : null
}

// Deduplicate concurrent refresh calls — when access token expires, multiple
// API calls may simultaneously get 401 and try to refresh. Only one should run.
let _refreshPromise: Promise<string | null> | null = null

export async function refreshAccessToken(): Promise<string | null> {
  if (_refreshPromise) return _refreshPromise

  if (usesRefreshCookie()) {
    const generation = sessionGeneration
    const marker = notice()
    const hadSession = memoryAccess !== null
    const outcome = await refreshAccessTokenQuietly()
    if ('token' in outcome) return outcome.token
    if (outcome.failed === 'refused' && hadSession && generation === sessionGeneration && marker === notice()) {
      // A refused cookie cannot bootstrap a new login. Keep the local-only
      // navigation independent of the network (the server has refused it).
      endSession()
      window.location.href = withBasePath('/login')
    }
    return null
  }
  _refreshPromise = _doRefresh(true).then((outcome) => ('token' in outcome ? outcome.token : null))
  try {
    return await _refreshPromise
  } finally {
    _refreshPromise = null
  }
}

/**
 * How a refresh ended. `refused`: the server will not refresh this session (401
 * or 403, no refresh token, or another tab ended it meanwhile). `transient`: no
 * answer worth acting on (no network, a 5xx, a proxy error); try again later.
 */
export type RefreshOutcome = { token: string } | { failed: 'refused' | 'transient' }

let _quietRefreshPromise: Promise<RefreshOutcome> | null = null

/**
 * `refreshAccessToken` for a page that must not be left: it never clears the
 * tokens and never navigates, whatever the answer. It says how it ended, so the
 * caller can tell "sign in again" (refused) from "try again" (transient). A
 * share page uses it, where /login would lose the review on screen.
 *
 * Its own dedup, so a page-leaving refresh never joins a quiet one (or the
 * other way round) and inherits the wrong handling of a refusal.
 */
export async function refreshAccessTokenQuietly(): Promise<RefreshOutcome> {
  if (_quietRefreshPromise) return _quietRefreshPromise

  _quietRefreshPromise = usesRefreshCookie() ? refreshCookie() : _doRefresh(false)
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
function sessionMovedOn(sentToken: string | null): RefreshOutcome {
  const access = getAccessToken()
  const sub = subjectOf(access)
  return sub !== null && sub === subjectOf(sentToken) && access
    ? { token: access }
    : { failed: 'refused' }
}

function refreshCookie(): Promise<RefreshOutcome> {
  if (Date.now() < retryCookieRefreshAt) return Promise.resolve({ failed: 'transient' })
  const generation = sessionGeneration
  const marker = notice()
  const sentAccess = memoryAccess
  const movedOn = () => generation !== sessionGeneration || marker !== notice()
  const movedOutcome = (): RefreshOutcome => sessionMovedOn(sentAccess)
  return withCookieMutation<RefreshOutcome>(async () => {
    if (movedOn()) return movedOutcome()
    // One-way transition on the first run after upgrading, including clients
    // that have a saved refresh token but no old JS-set cookie.
    const legacy = localStorage.getItem(REFRESH_TOKEN_KEY)
    const transient = (): RefreshOutcome => {
      retryCookieRefreshAt = Date.now() + 5000
      return { failed: 'transient' }
    }
    try {
      const response = await fetch(`${API_URL}/auth/refresh`, {
        method: 'POST', credentials: 'same-origin',
        headers: { ...webClientHeaders(), ...(legacy ? { 'Content-Type': 'application/json' } : {}) },
        signal: AbortSignal.timeout(10000),
        ...(legacy ? { body: JSON.stringify({ refresh_token: legacy }) } : {}),
      })
      if (movedOn()) return movedOutcome()
      if (response.status === 401 || response.status === 403) {
        clearLegacyStorage()
        return { failed: 'refused' }
      }
      if (!response.ok) return transient()
      const data = await response.json()
      if (movedOn()) return movedOutcome()
      if (typeof data.access_token !== 'string' || !data.access_token) return transient()
      // Cookie changes can arrive before the tab's storage notification. A
      // refresh of an existing bearer must not silently switch its account.
      const sentSubject = subjectOf(sentAccess)
      if (sentSubject && subjectOf(data.access_token) !== sentSubject) return { failed: 'refused' }
      memoryAccess = data.access_token
      clearLegacyStorage()
      return { token: data.access_token }
    } catch {
      return movedOn() ? movedOutcome() : transient()
    }
  })
}

/** `endsSession`: whether a refusal (or nothing to send) ends the session. */
async function _doRefresh(endsSession: boolean): Promise<RefreshOutcome> {
  const refreshToken = getRefreshToken()
  if (!refreshToken) {
    if (endsSession) clearTokens()
    return { failed: 'refused' }
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
      if (response.status === 401 || response.status === 403) {
        if (endsSession) clearTokens()
        return { failed: 'refused' }
      }
      return { failed: 'transient' }
    }

    const data = await response.json()
    if (getRefreshToken() !== refreshToken) return sessionMovedOn(refreshToken)
    const newAccessToken: string = data.access_token
    const newRefreshToken: string = data.refresh_token ?? refreshToken

    setTokens(newAccessToken, newRefreshToken)
    return { token: newAccessToken }
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
    return { failed: 'transient' }
  }
}
