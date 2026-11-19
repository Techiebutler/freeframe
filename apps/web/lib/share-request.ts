import { isExpiringSoon } from '@/hooks/use-sse'
import { refreshAccessTokenQuietly } from '@/lib/auth'
import { subjectOf } from '@/lib/jwt-subject'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

const FALLBACK_DETAIL = 'Request failed'

/** The server's own words for a bearer it could not resolve used
 *  for the same case when the client finds out first. */
export const SIGN_IN_EXPIRED = 'Your sign-in has expired. Sign in again or continue as a guest.'

/** A refresh that got no answer worth acting on: nothing to sign in again for. */
export const SERVER_UNREACHABLE = "Couldn't reach the server. Try again."

/** A write refused (or never sent) because the sign-in has lapsed for good. */
export function isSignInExpired(err: unknown): boolean {
  return (err as { status?: unknown } | null | undefined)?.status === 401
}

export interface ShareGuest {
  name: string
  email: string
}

// ─── Who a share request goes out as ────────────────────────────────────────
//
// Module state, so every verdict control on the page, and every version, agrees
// on which sign-ins were refused and which of those the person chose to
// continue as a guest over.

/**
 * Bearers the server refused even after a refresh, by token string. Such a
 * token is never sent again and never refreshed again. Only that token: a new
 * one in storage (signed in again, in this tab or another) is used as normal.
 */
const refusedBearers = new Set<string>()

/**
 * The sign-ins "Continue as guest" was chosen over, by token string. The
 * choice covers only the refused token it was made for: a different one in
 * storage (signed in again, here or in another tab, even if it has since
 * lapsed too) is refreshed and used as normal, never quietly turned into the
 * guest.
 */
const guestChosenOver = new Set<string>()

/**
 * The person chose "Continue as guest" over the refused sign-in `error` was
 * about (the `SIGN_IN_EXPIRED` failure `shareRequest` threw). Only the tokens
 * it names that are known refused are bound: never whatever happens to be in
 * storage when the button is pressed, which another tab may have replaced
 * with a good sign-in meanwhile.
 */
export function continueAsGuest(error: unknown): void {
  const tokens = (error as { refusedTokens?: unknown } | null | undefined)?.refusedTokens
  if (!Array.isArray(tokens)) return
  for (const token of tokens) {
    if (typeof token === 'string' && refusedBearers.has(token)) guestChosenOver.add(token)
  }
}

/** Whether "Continue as guest" covers the sign-in stored now. */
export function hasChosenGuest(): boolean {
  const stored = storedAccessToken()
  return !!stored && guestChosenOver.has(stored)
}

/** For tests: forget refused bearers and guest choices. */
export function resetShareRequestState(): void {
  refusedBearers.clear()
  guestChosenOver.clear()
}

function storedAccessToken(): string | null {
  try {
    return localStorage.getItem('ff_access_token')
  } catch {
    return null
  }
}

/** The stored access token, when it is unexpired and not known to be refused. */
function usableAccessToken(): string | null {
  const token = storedAccessToken()
  return token && !isExpiringSoon(token) && !refusedBearers.has(token) ? token : null
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
 * Who a read would go as right now, for a cache key: `bearer:<account>`, the
 * guest's email, `lapsed` (a sign-in that is not usable: read as nobody), or
 * `nobody`. The account is part of it, so a switch to another account in
 * another tab is a different caller, read again before anything is decided.
 */
export function shareCallerKey(guest: ShareGuest | null | undefined): string {
  const usable = usableAccessToken()
  // A token with no readable subject is keyed by itself: still one account.
  if (usable) return `bearer:${subjectOf(usable) ?? usable}`
  if (storedAccessToken() && !hasChosenGuest()) return 'lapsed'
  return guest ? `guest:${guest.email}` : 'nobody'
}

type Caller =
  | { kind: 'bearer'; token: string }
  | { kind: 'guest' }
  /** A lapsed sign-in reading: no bearer, and not the guest either. */
  | { kind: 'nobody' }
  /** `refused` names the tokens refused, for "Continue as guest" to bind. */
  | { kind: 'failed'; why: 'refused'; tokens: string[] }
  | { kind: 'failed'; why: 'transient' }

/**
 * Who this request goes as. A lapsed sign-in is never turned into a guest
 * behind the person's back, so a team member's verdict is never counted (or
 * shown) as a guest's:
 * - No token stored: the guest.
 * - A usable token: it.
 * - "Continue as guest" chosen over this very token: the guest.
 * - Otherwise one quiet refresh. A new token is used. A refused one marks the
 *   stale token refused, so it is not refreshed again. Then a read goes as
 *   nobody, and a write fails.
 */
async function resolveCaller(): Promise<Caller> {
  const stored = storedAccessToken()
  if (!stored) return { kind: 'guest' }
  const usable = usableAccessToken()
  if (usable) return { kind: 'bearer', token: usable }
  if (hasChosenGuest()) return { kind: 'guest' }
  if (refusedBearers.has(stored)) return { kind: 'failed', why: 'refused', tokens: [stored] }

  const outcome = await refreshAccessTokenQuietly()
  if ('token' in outcome && !refusedBearers.has(outcome.token)) return { kind: 'bearer', token: outcome.token }
  if ('token' in outcome || outcome.failed === 'refused') {
    // The token this page held, not whatever storage holds now: another tab
    // may have signed in as someone else while the refresh was out.
    refusedBearers.add(stored)
    return { kind: 'failed', why: 'refused', tokens: [stored] }
  }
  return { kind: 'failed', why: 'transient' }
}

/** A refused sign-in, naming the refused tokens for `continueAsGuest`. */
function refused(tokens: string[]): Error {
  return Object.assign(new Error(SIGN_IN_EXPIRED), { status: 401, detail: SIGN_IN_EXPIRED, refusedTokens: tokens })
}

/** No answer worth acting on: try again, nothing to sign in again for. */
export function unreachable(): Error {
  return Object.assign(new Error(SERVER_UNREACHABLE), { detail: SERVER_UNREACHABLE })
}

/**
 * One call to a share-link route, `/share/{token}{path}`.
 *
 * The bearer goes only when it is usable (`resolveCaller`). Only the guest
 * sends the guest's fields: name and email in the body of a PUT, the email
 * alone in the query of a GET or DELETE. A failure throws the server's string
 * `detail` (as `message` and `detail`), or "Request failed".
 *
 * - A write whose sign-in has lapsed and will not refresh sends nothing. It
 *   throws `SIGN_IN_EXPIRED` (status 401) when the refresh was refused, so the
 *   caller can offer "Sign in" or "Continue as guest". It throws
 *   `SERVER_UNREACHABLE` when the refresh got no answer.
 * - A write the server answers 401 for a bearer (expired by the server's
 *   clock, a deactivated user, a rotated secret) refreshes once and retries
 *   once. If that does not work, that bearer is remembered as refused.
 * - A read never asks. With a lapsed sign-in that will not refresh, it goes as
 *   nobody: neither the bearer nor the guest's email, so nothing reads as theirs.
 */
export async function shareRequest<T>(
  token: string,
  path: string,
  init: {
    method: 'GET' | 'PUT' | 'DELETE'
    body?: object
    shareSession?: string | null
    guest?: ShareGuest | null
  },
): Promise<T> {
  const isRead = init.method === 'GET'
  const caller = await resolveCaller()
  if (caller.kind === 'failed' && !isRead) throw caller.why === 'refused' ? refused(caller.tokens) : unreachable()

  const send = (bearer: string | null) => {
    const guest = caller.kind === 'guest' ? init.guest ?? null : null

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
    return fetch(url.toString(), { method: init.method, headers, body })
  }

  const bearer = caller.kind === 'bearer' ? caller.token : null
  let res = await send(bearer)

  if (res.status === 401 && bearer && !isRead) {
    // The server's clock, not ours, says when a token has expired, and a token
    // can be refused before then. /auth/refresh does not look at the access
    // token, so one refresh and one retry recovers the first; anything else
    // marks this bearer refused, and "Continue as guest" can then drop it.
    const outcome = await refreshAccessTokenQuietly()
    if ('token' in outcome && outcome.token !== bearer && !refusedBearers.has(outcome.token)) {
      res = await send(outcome.token)
      if (res.status === 401) {
        refusedBearers.add(bearer)
        refusedBearers.add(outcome.token)
        throw refused([bearer, outcome.token])
      }
    } else if ('failed' in outcome && outcome.failed === 'transient') {
      throw unreachable()
    } else {
      refusedBearers.add(bearer)
      throw refused([bearer])
    }
  }

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

/**
 * Before a write: if the stored sign-in has lapsed, refresh it now, so the
 * caller the write goes as is settled before it is compared with whoever the
 * list on screen was read as (`shareCallerKey`). Never asks and never throws.
 */
export async function prepareShareWrite(): Promise<void> {
  const stored = storedAccessToken()
  if (!stored || usableAccessToken() || hasChosenGuest() || refusedBearers.has(stored)) return
  await resolveCaller()
}
