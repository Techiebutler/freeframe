/**
 * The `sub` claim of a JWT, or null for no token or anything that does not
 * decode to a payload with a non-empty string `sub`. The signature is not
 * checked: this only names the account the server will act as, it does not
 * vouch for it. Decoding follows `hooks/use-sse.ts` `isExpiringSoon`.
 *
 * Kept free of imports so `auth.ts` can use it: `upload-owner.ts`, which
 * re-exports it, imports `auth.ts`.
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
