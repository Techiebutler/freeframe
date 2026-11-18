import { getAccessToken, refreshAccessToken } from './auth'
import { subjectOf } from './upload-owner'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

export class ApiError extends Error {
  status: number
  detail: string
  /** Machine-readable reason from a coded detail, e.g. `storage_unavailable`. */
  code?: string
  /** Seconds the server asked the client to wait before trying again. */
  retryAfter?: number

  constructor(status: number, detail: string, opts?: { code?: string; retryAfter?: number }) {
    super(detail)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
    this.code = opts?.code
    this.retryAfter = opts?.retryAfter
  }
}

/** Whole seconds from a `Retry-After` header; an HTTP-date or junk reads as absent. */
function retryAfterFromHeader(response: Response): number | undefined {
  const raw = response.headers.get('Retry-After')
  if (typeof raw !== 'string' || !/^\s*\d+\s*$/.test(raw)) return undefined
  return parseInt(raw, 10)
}

/**
 * Builds the `ApiError` for a non-OK response.
 *
 * A dict detail carrying a string `code` and `message` (the upload endpoints
 * answer this way) becomes `detail = message` plus `code`, so callers can show
 * the sentence and branch on the code. Any other dict detail is stringified,
 * as it always was. `retryAfter` comes from the body's `retry_after`, else the
 * `Retry-After` header.
 *
 * `joinValidationMessages` selects what an array (FastAPI 422) detail becomes:
 * its messages joined, or, for the form-upload path, its JSON as before.
 */
async function toApiError(
  response: Response,
  { joinValidationMessages }: { joinValidationMessages: boolean },
): Promise<ApiError> {
  let detail = response.statusText
  let code: string | undefined
  let retryAfter: number | undefined
  try {
    const errorBody = await response.json()
    const raw = errorBody?.detail
    if (raw) {
      if (typeof raw === 'string') {
        detail = raw
      } else if (Array.isArray(raw) && joinValidationMessages) {
        // FastAPI validation errors: [{loc: [...], msg: "...", type: "..."}]
        detail = raw
          .map((e: { msg?: string; loc?: string[] }) => e.msg || 'Validation error')
          .join('; ')
      } else if (typeof raw.code === 'string' && typeof raw.message === 'string') {
        detail = raw.message
        code = raw.code
      } else {
        detail = JSON.stringify(raw)
      }
      const hint = raw.retry_after
      if (typeof hint === 'number' && Number.isFinite(hint) && hint >= 0) retryAfter = hint
    }
  } catch {
    // ignore parse errors; use statusText as fallback
  }
  return new ApiError(response.status, detail, {
    code,
    retryAfter: retryAfter ?? retryAfterFromHeader(response),
  })
}

interface RequestOptions {
  headers?: Record<string, string>
  /**
   * The account (token `sub`) this request must be sent as. Tokens are shared
   * by every tab, so another tab can sign in as someone else at any moment; a
   * pinned request is never sent, nor resent after a refresh, under another
   * account. It throws a 401 `ApiError` instead, with `code`:
   * - `identity_changed`: another account's token is present;
   * - `session_ended`: no token is left (signed out, or the refresh refused);
   * - `refresh_unavailable`: a 401 whose refresh got no answer (network, 5xx,
   *   429) while the tokens are still present, so the session may yet recover.
   */
  pinSubject?: string
}

function pinnedError(code: 'identity_changed' | 'session_ended' | 'refresh_unavailable'): ApiError {
  const detail = {
    identity_changed: 'identity changed',
    session_ended: 'session ended',
    refresh_unavailable: 'refresh unavailable',
  }[code]
  return new ApiError(401, detail, { code })
}

/**
 * Sends with the current token and, on a 401, refreshes and resends once.
 *
 * With `pinSubject`, the token is checked before the first send, in the same
 * tick as the fetch, so an account switched in another tab after the caller's
 * own owner check still sends nothing. After a 401, no refresh is tried once
 * another account's token is in storage, and the refreshed token is resent
 * only if it belongs to the same account.
 */
async function sendWithAuth(
  execute: (token: string | null) => Promise<Response>,
  pinSubject: string | undefined,
): Promise<Response> {
  const token = getAccessToken()
  if (pinSubject !== undefined) {
    const sub = subjectOf(token)
    if (sub !== pinSubject) throw pinnedError(sub ? 'identity_changed' : 'session_ended')
  }

  const response = await execute(token)
  if (response.status !== 401) return response

  if (pinSubject === undefined) {
    const newToken = await refreshAccessToken()
    return newToken ? execute(newToken) : response
  }
  // Another account signed in while this was on the wire. The refresh token in
  // storage is now that account's: spending it on this request would rotate
  // their session for nothing, and a refusal would sign them out everywhere.
  const stored = subjectOf(getAccessToken())
  if (stored !== null && stored !== pinSubject) throw pinnedError('identity_changed')

  const newToken = await refreshAccessToken()
  if (newToken) {
    if (subjectOf(newToken) !== pinSubject) throw pinnedError('identity_changed')
    return execute(newToken)
  }
  // `refreshAccessToken` keeps the tokens when the refresh got no answer and
  // clears them when the server refused it. Tokens kept may still have become
  // another account's while the refresh was out.
  const left = subjectOf(getAccessToken())
  if (left === null) throw pinnedError(getAccessToken() ? 'refresh_unavailable' : 'session_ended')
  throw pinnedError(left === pinSubject ? 'refresh_unavailable' : 'identity_changed')
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  options?: RequestOptions,
): Promise<T> {
  const buildHeaders = (token: string | null): Record<string, string> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...options?.headers,
    }
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }
    return headers
  }

  const execute = async (token: string | null): Promise<Response> => {
    return fetch(`${API_URL}${path}`, {
      method,
      headers: buildHeaders(token),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  }

  // On 401, attempt a token refresh and retry once
  const response = await sendWithAuth(execute, options?.pinSubject)

  if (!response.ok) {
    throw await toApiError(response, { joinValidationMessages: true })
  }

  // Handle empty responses (e.g. 204 No Content, or empty body)
  if (response.status === 204 || response.headers.get('content-length') === '0') {
    return undefined as unknown as T
  }

  const contentType = response.headers.get('content-type')
  if (!contentType || !contentType.includes('application/json')) {
    return undefined as unknown as T
  }

  const text = await response.text()
  if (!text) {
    return undefined as unknown as T
  }

  return JSON.parse(text) as T
}

async function uploadRequest<T>(
  path: string,
  formData: FormData,
  options?: Pick<RequestOptions, 'pinSubject'>,
): Promise<T> {
  const buildHeaders = (token: string | null): Record<string, string> => {
    const headers: Record<string, string> = {}
    if (token) headers['Authorization'] = `Bearer ${token}`
    return headers
  }

  const execute = async (token: string | null): Promise<Response> => {
    return fetch(`${API_URL}${path}`, {
      method: 'POST',
      headers: buildHeaders(token),
      body: formData,
    })
  }

  const response = await sendWithAuth(execute, options?.pinSubject)

  if (!response.ok) {
    throw await toApiError(response, { joinValidationMessages: false })
  }

  if (response.status === 204) return undefined as unknown as T
  const text = await response.text()
  return text ? (JSON.parse(text) as T) : (undefined as unknown as T)
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) =>
    request<T>('GET', path, undefined, options),

  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('POST', path, body, options),

  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('PATCH', path, body, options),

  put: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('PUT', path, body, options),

  delete: <T>(path: string, options?: RequestOptions) =>
    request<T>('DELETE', path, undefined, options),

  upload: <T>(path: string, formData: FormData, options?: Pick<RequestOptions, 'pinSubject'>) =>
    uploadRequest<T>(path, formData, options),
}

export type { ApiError as ApiErrorType }
