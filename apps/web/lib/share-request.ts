import { isExpiringSoon } from '@/hooks/use-sse'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

const FALLBACK_DETAIL = 'Request failed'

export interface ShareGuest {
  name: string
  email: string
}

/** The stored access token, when there is one and it has not run out. */
function usableAccessToken(): string | null {
  let token: string | null = null
  try {
    token = localStorage.getItem('ff_access_token')
  } catch {
    return null
  }
  return token && !isExpiringSoon(token) ? token : null
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
  const bearer = usableAccessToken()
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
