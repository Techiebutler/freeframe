import { getAccessToken } from './auth'

/**
 * Who an upload belongs to.
 *
 * The access token's `sub` claim is the signed-in user's id, and it is the only
 * client-side record of which account a tab is acting as. Tokens live in
 * localStorage, shared by every tab, so the account can change underneath a
 * running upload when another tab signs out or signs in as someone else.
 */

const ACCESS_TOKEN_KEY = 'ff_access_token'

/**
 * The `sub` claim of a JWT, or null for no token or anything that does not
 * decode to a payload with a non-empty string `sub`. The signature is not
 * checked: this only names the account the server will act as, it does not
 * vouch for it. Decoding follows `hooks/use-sse.ts` `isExpiringSoon`.
 */
export function subjectOf(token: string | null): string | null {
  if (!token) return null
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const payload = JSON.parse(atob(part)) as { sub?: unknown } | null
    const sub = payload?.sub
    return typeof sub === 'string' && sub !== '' ? sub : null
  } catch {
    return null
  }
}

/** The account this tab is acting as right now, or null when signed out. */
export function currentSubject(): string | null {
  return subjectOf(getAccessToken())
}

/**
 * Calls `cb(next, prev)` when another tab changes which account is signed in,
 * including signing out (`next` is null). A refreshed token for the same
 * account is not a change and does not fire.
 *
 * `storage` events reach only the other tabs, never the one that wrote, so a
 * refresh or sign-in in this tab is not reported here. A `null` key is another
 * tab calling `localStorage.clear()`. Returns the unsubscribe function.
 */
export function watchSubject(
  cb: (next: string | null, prev: string | null) => void,
): () => void {
  if (typeof window === 'undefined') return () => {}
  let prev = currentSubject()
  const onStorage = (e: StorageEvent) => {
    if (e.key !== ACCESS_TOKEN_KEY && e.key !== null) return
    const next = subjectOf(e.key === null ? getAccessToken() : e.newValue)
    if (next === prev) return
    const was = prev
    prev = next
    cb(next, was)
  }
  window.addEventListener('storage', onStorage)
  return () => window.removeEventListener('storage', onStorage)
}
