import { ApiError } from '@/lib/api'

/**
 * What a failed initiate request means for the queue.
 *
 * - `refusal`: the server will not accept this file (too big, not allowed, a
 *   conflict). Fail this row with `message`; the rest of the queue carries on.
 * - `storage_misconfigured`: the server reached its storage and storage said no.
 *   Retrying will not help until an admin acts. Fail this row with `message`.
 * - `hold`: nothing is wrong with the file. The connection or the storage is
 *   down for now, so the queue waits and tries again. `retryAfterMs` is the
 *   server's own suggested delay, when it gave one.
 * - `account`: another account signed in while this file waited.
 * - `session_ended`: the session ended (for example, signed out in another tab).
 */
export type InitiateOutcome =
  | { kind: 'refusal'; message: string }
  | { kind: 'storage_misconfigured'; message: string }
  | { kind: 'hold'; reason: 'connection' | 'storage'; retryAfterMs?: number }
  | { kind: 'account' }
  | { kind: 'session_ended' }

const STORAGE_REFUSED_MESSAGE =
  'Storage refused the upload. Ask your admin to check the storage settings.'

/** A cancelled request is the caller's own doing, never a failure to classify. */
function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError'
}

/** `retryAfter` is in seconds. Anything that is not a finite, non-negative number reads as absent. */
function holdOutcome(
  reason: 'connection' | 'storage',
  retryAfter: number | undefined,
): InitiateOutcome {
  if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0) {
    return { kind: 'hold', reason, retryAfterMs: retryAfter * 1000 }
  }
  return { kind: 'hold', reason }
}

/**
 * Decides what an initiate failure means.
 *
 * Codes are read before statuses: the same status can mean different things
 * (a coded 500 is a storage that refused, not a server that is down; a coded
 * 503 is a storage hold, an uncoded one a connection hold). An `AbortError` is
 * rethrown. Anything this does not recognise is a connection hold, so the
 * queue waits and retries rather than failing a file that may be fine.
 */
export function classifyInitiateError(err: unknown): InitiateOutcome {
  if (isAbortError(err)) throw err

  if (!(err instanceof ApiError)) return { kind: 'hold', reason: 'connection' }

  switch (err.code) {
    case 'identity_changed':
      return { kind: 'account' }
    case 'session_ended':
      return { kind: 'session_ended' }
    case 'refresh_unavailable':
      return holdOutcome('connection', err.retryAfter)
    case 'storage_error':
      return {
        kind: 'storage_misconfigured',
        message: err.detail.trim() === '' ? STORAGE_REFUSED_MESSAGE : err.detail,
      }
    case 'storage_unavailable':
      return holdOutcome('storage', err.retryAfter)
  }

  const { status } = err
  // 401 (not signed in, unless a code above said otherwise), 408 and 429 are
  // about the moment, not the file. Every other 4xx is the server saying no.
  if (status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429) {
    return { kind: 'refusal', message: err.detail }
  }

  return holdOutcome('connection', err.retryAfter)
}
