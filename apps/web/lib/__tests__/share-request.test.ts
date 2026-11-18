import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  continueAsGuest, hasStoredToken, hasUsableToken, isSignInExpired, prepareShareWrite, resetShareRequestState,
  SERVER_UNREACHABLE, shareCallerKey, shareRequest, SIGN_IN_EXPIRED,
} from '../share-request'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

/** A JWT whose only meaningful part is `exp`, which is all the client reads. */
function jwt(expSecondsFromNow: number): string {
  const b64url = (o: object) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const exp = Math.floor(Date.now() / 1000) + expSecondsFromNow
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: 'u1', exp })}.sig`
}

const guest = { name: 'Dana', email: 'dana@client.example' }

let fetchMock: ReturnType<typeof vi.fn>

function lastCall(): { url: URL; init: RequestInit; headers: Record<string, string>; body: Record<string, unknown> | null } {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit]
  const headers = (init.headers ?? {}) as Record<string, string>
  return {
    url: new URL(url),
    init,
    headers,
    body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
  }
}

function respond(status: number, body?: unknown) {
  fetchMock.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body === undefined) throw new SyntaxError('Unexpected end of JSON input')
      return body
    },
  })
}

beforeEach(() => {
  localStorage.clear()
  resetShareRequestState()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('hasStoredToken', () => {
  it('is true for any stored token, lapsed or not', () => {
    expect(hasStoredToken()).toBe(false)
    localStorage.setItem('ff_access_token', jwt(-60))
    expect(hasStoredToken()).toBe(true)
  })
})

describe('hasUsableToken', () => {
  it('is false with no token', () => {
    expect(hasUsableToken()).toBe(false)
  })

  it('is true for a token that has not expired', () => {
    localStorage.setItem('ff_access_token', jwt(3600))
    expect(hasUsableToken()).toBe(true)
  })

  it('is false for an expired token', () => {
    localStorage.setItem('ff_access_token', jwt(-60))
    expect(hasUsableToken()).toBe(false)
  })

  it('is false for a token inside the 10 s expiry skew', () => {
    localStorage.setItem('ff_access_token', jwt(5))
    expect(hasUsableToken()).toBe(false)
  })

  // Not ours to judge, as in the SSE hook: the server answers for it.
  it('is true for a token it cannot decode', () => {
    localStorage.setItem('ff_access_token', 'not-a-jwt')
    expect(hasUsableToken()).toBe(true)
  })
})

describe('shareRequest', () => {
  // Review Focus 1 and ruling R15: a signed-in client whose login has lapsed
  // must not have their verdict filed under whatever guest identity is left in
  // storage. The write refreshes the sign-in first...
  it('with an expired token, refreshes and sends the new bearer and no guest fields', async () => {
    localStorage.setItem('ff_access_token', jwt(-60))
    localStorage.setItem('ff_refresh_token', 'the-refresh-token')
    const fresh = jwt(3600)
    respond(200, { access_token: fresh, refresh_token: 'rotated' }) // /auth/refresh
    respond(200, { id: 'v' })

    await shareRequest('tok', '/verdict', {
      method: 'PUT',
      body: { version_id: 'v1', status: 'approved' },
      guest,
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${API}/auth/refresh`)
    const { url, init, headers, body } = lastCall()
    expect(url.origin + url.pathname).toBe(`${API}/share/tok/verdict`)
    expect(init.method).toBe('PUT')
    expect(headers.Authorization).toBe(`Bearer ${fresh}`)
    expect(body).toEqual({ version_id: 'v1', status: 'approved' })
  })

  // ...and when it is refused, sends nothing and says so, rather than going as the guest.
  it('with an expired token whose refresh is refused, sends nothing and throws the sign-in message', async () => {
    localStorage.setItem('ff_access_token', jwt(-60))
    localStorage.setItem('ff_refresh_token', 'the-refresh-token')
    respond(401, { detail: 'Invalid refresh token' })

    const err = await shareRequest('tok', '/verdict', {
      method: 'PUT',
      body: { version_id: 'v1', status: 'approved' },
      guest,
    }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe(SIGN_IN_EXPIRED)
    expect(isSignInExpired(err)).toBe(true)
    // Only the refresh went out; no share call.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${API}/auth/refresh`)
    // And the page is not left, nor the tokens dropped.
    expect(localStorage.getItem('ff_refresh_token')).toBe('the-refresh-token')

    // Refused is remembered: the next write does not refresh again.
    await expect(shareRequest('tok', '/verdict', { method: 'PUT', body: {}, guest })).rejects.toThrow(SIGN_IN_EXPIRED)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  // A refresh that got no answer is not a reason to sign in again.
  it.each([
    ['offline', () => fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))],
    ['a 502', () => respond(502)],
  ])('with an expired token whose refresh is %s, says to try again, with the tokens untouched', async (_, answer) => {
    const stale = jwt(-60)
    localStorage.setItem('ff_access_token', stale)
    localStorage.setItem('ff_refresh_token', 'the-refresh-token')
    answer()

    const err = await shareRequest('tok', '/verdict', { method: 'PUT', body: {}, guest }).catch((e: unknown) => e)

    expect((err as Error).message).toBe(SERVER_UNREACHABLE)
    expect(isSignInExpired(err)).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem('ff_access_token')).toBe(stale)
    expect(localStorage.getItem('ff_refresh_token')).toBe('the-refresh-token')
  })

  it('with an expired token and no refresh token, sends nothing either', async () => {
    localStorage.setItem('ff_access_token', jwt(-60))
    await expect(
      shareRequest('tok', '/verdict?version_id=v1', { method: 'DELETE', guest }),
    ).rejects.toThrow(SIGN_IN_EXPIRED)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // "Continue as guest" is the explicit choice that makes the guest fields go.
  it('with an expired token after "Continue as guest", sends the guest fields with no Authorization and no refresh', async () => {
    localStorage.setItem('ff_access_token', jwt(-60))
    localStorage.setItem('ff_refresh_token', 'the-refresh-token')
    continueAsGuest()
    respond(200, { id: 'v' })

    await shareRequest('tok', '/verdict', {
      method: 'PUT',
      body: { version_id: 'v1', status: 'approved' },
      guest,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const { headers, body } = lastCall()
    expect(headers.Authorization).toBeUndefined()
    expect(body).toEqual({ version_id: 'v1', status: 'approved', guest_name: 'Dana', guest_email: 'dana@client.example' })
  })

  // Fix round 1, issue 1: the server refused a bearer the client thought good
  // (clock skew, a deactivated user, a rotated secret, an undecodable token).
  // "Continue as guest" must really drop it, not send it again.
  it.each([
    ['unexpired', () => jwt(3600)],
    ['undecodable', () => 'not-a-jwt'],
  ])('after the server refuses an %s bearer and the refresh is refused, "Continue as guest" drops it', async (_, make) => {
    const bearer = make()
    localStorage.setItem('ff_access_token', bearer)
    localStorage.setItem('ff_refresh_token', 'the-refresh-token')
    respond(401, { detail: SIGN_IN_EXPIRED }) // PUT
    respond(403, { detail: 'User is deactivated' }) // /auth/refresh

    await expect(shareRequest('tok', '/verdict', { method: 'PUT', body: {}, guest })).rejects.toThrow(SIGN_IN_EXPIRED)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(hasUsableToken()).toBe(false)

    continueAsGuest()
    respond(200, {})
    await shareRequest('tok', '/verdict', { method: 'PUT', body: { status: 'approved' }, guest })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(lastCall().headers.Authorization).toBeUndefined()
    expect(lastCall().body).toEqual({ status: 'approved', guest_name: 'Dana', guest_email: 'dana@client.example' })
  })

  it('a new token in storage still wins over a refused one, guest chosen or not', async () => {
    localStorage.setItem('ff_access_token', jwt(3600))
    localStorage.setItem('ff_refresh_token', 'the-refresh-token')
    respond(401, { detail: SIGN_IN_EXPIRED })
    respond(401, {})
    await expect(shareRequest('tok', '/verdict', { method: 'PUT', body: {}, guest })).rejects.toThrow(SIGN_IN_EXPIRED)
    continueAsGuest()

    // Signed in again, here or in another tab.
    const fresh = jwt(7200)
    localStorage.setItem('ff_access_token', fresh)
    respond(200, {})
    await shareRequest('tok', '/verdict', { method: 'PUT', body: {}, guest })
    expect(lastCall().headers.Authorization).toBe(`Bearer ${fresh}`)
    expect(lastCall().body).toEqual({})
  })

  // Clock skew: the server's clock says expired, ours does not. /auth/refresh
  // ignores the access token, so one refresh and one retry recovers it.
  it('after a server 401, refreshes and retries once with the new bearer', async () => {
    const old = jwt(3600)
    localStorage.setItem('ff_access_token', old)
    localStorage.setItem('ff_refresh_token', 'the-refresh-token')
    const fresh = jwt(7200)
    respond(401, { detail: SIGN_IN_EXPIRED }) // PUT with the old bearer
    respond(200, { access_token: fresh, refresh_token: 'rotated' }) // /auth/refresh
    respond(200, { id: 'v' }) // PUT with the new one

    await expect(
      shareRequest('tok', '/verdict', { method: 'PUT', body: { status: 'approved' }, guest }),
    ).resolves.toEqual({ id: 'v' })

    const puts = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit).method === 'PUT')
    expect(puts).toHaveLength(2)
    expect(((puts[0][1] as RequestInit).headers as Record<string, string>).Authorization).toBe(`Bearer ${old}`)
    expect(((puts[1][1] as RequestInit).headers as Record<string, string>).Authorization).toBe(`Bearer ${fresh}`)
    expect(lastCall().body).toEqual({ status: 'approved' })
  })

  it('after a server 401 whose refresh gets no answer, says to try again and keeps the bearer', async () => {
    const bearer = jwt(3600)
    localStorage.setItem('ff_access_token', bearer)
    localStorage.setItem('ff_refresh_token', 'the-refresh-token')
    respond(401, { detail: SIGN_IN_EXPIRED })
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))

    await expect(shareRequest('tok', '/verdict', { method: 'PUT', body: {}, guest })).rejects.toThrow(SERVER_UNREACHABLE)
    expect(hasUsableToken()).toBe(true)
    expect(localStorage.getItem('ff_access_token')).toBe(bearer)
  })

  // Reads never ask. A lapsed sign-in refreshes once; if that fails the read
  // goes as nobody, so the stored guest's verdict never shows as theirs.
  it('reads with an expired token that refreshes, with the new bearer', async () => {
    localStorage.setItem('ff_access_token', jwt(-60))
    localStorage.setItem('ff_refresh_token', 'the-refresh-token')
    const fresh = jwt(3600)
    respond(200, { access_token: fresh, refresh_token: 'rotated' })
    respond(200, [])

    await shareRequest('tok', '/verdicts?version_id=v1', { method: 'GET', guest })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(lastCall().headers.Authorization).toBe(`Bearer ${fresh}`)
    expect(lastCall().url.searchParams.has('guest_email')).toBe(false)
  })

  it.each([
    ['refused', () => respond(401, {})],
    ['offline', () => fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))],
  ])('reads with an expired token whose refresh is %s as nobody: no bearer, no guest email', async (_, answer) => {
    localStorage.setItem('ff_access_token', jwt(-60))
    localStorage.setItem('ff_refresh_token', 'the-refresh-token')
    answer()
    respond(200, [])

    await shareRequest('tok', '/verdicts?version_id=v1', { method: 'GET', guest })

    const { url, headers } = lastCall()
    expect(url.pathname).toBe('/share/tok/verdicts')
    expect(headers.Authorization).toBeUndefined()
    expect(url.searchParams.has('guest_email')).toBe(false)
  })

  it('reads as the guest once "Continue as guest" is chosen', async () => {
    localStorage.setItem('ff_access_token', jwt(-60))
    continueAsGuest()
    respond(200, [])
    await shareRequest('tok', '/verdicts?version_id=v1', { method: 'GET', guest })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(lastCall().url.searchParams.get('guest_email')).toBe('dana@client.example')
  })

  it('with no token at all, sends the guest fields as before', async () => {
    respond(200, {})
    await shareRequest('tok', '/verdict', { method: 'PUT', body: { status: 'approved' }, guest })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(lastCall().headers.Authorization).toBeUndefined()
    expect(lastCall().body).toEqual({ status: 'approved', guest_name: 'Dana', guest_email: 'dana@client.example' })
  })

  // ...and a signed-in client whose login is good must not be filed as a guest.
  it('with a valid token and a stored guest, sends Authorization and no guest fields', async () => {
    const token = jwt(3600)
    localStorage.setItem('ff_access_token', token)
    respond(200, { id: 'v' })

    await shareRequest('tok', '/verdict', {
      method: 'PUT',
      body: { version_id: 'v1', status: 'approved' },
      guest,
    })

    const { headers, body } = lastCall()
    expect(headers.Authorization).toBe(`Bearer ${token}`)
    expect(body).toEqual({ version_id: 'v1', status: 'approved' })
    expect(body).not.toHaveProperty('guest_email')
    expect(body).not.toHaveProperty('guest_name')
  })

  it('puts the guest email in the query for GET and DELETE, never the name', async () => {
    respond(200, [])
    await shareRequest('tok', '/verdicts?asset_id=a1&version_id=v1', { method: 'GET', guest })
    let { url, init } = lastCall()
    expect(url.pathname).toBe('/share/tok/verdicts')
    expect(url.searchParams.get('asset_id')).toBe('a1')
    expect(url.searchParams.get('version_id')).toBe('v1')
    expect(url.searchParams.get('guest_email')).toBe('dana@client.example')
    expect(url.searchParams.has('guest_name')).toBe(false)
    expect(init.body).toBeUndefined()

    respond(204)
    await shareRequest('tok', '/verdict?version_id=v1', { method: 'DELETE', guest })
    ;({ url, init } = lastCall())
    expect(init.method).toBe('DELETE')
    expect(url.searchParams.get('guest_email')).toBe('dana@client.example')
  })

  it('leaves the guest email out of the query when a usable token is sent', async () => {
    localStorage.setItem('ff_access_token', jwt(3600))
    respond(200, [])
    await shareRequest('tok', '/verdicts?version_id=v1', { method: 'GET', guest })
    expect(lastCall().url.searchParams.has('guest_email')).toBe(false)
  })

  it('sends the bearer for a token it cannot decode', async () => {
    localStorage.setItem('ff_access_token', 'not-a-jwt')
    respond(200, {})
    await shareRequest('tok', '/verdict', { method: 'PUT', body: {}, guest })
    const { headers, body } = lastCall()
    expect(headers.Authorization).toBe('Bearer not-a-jwt')
    expect(body).toEqual({})
  })

  it('adds the share session, encoded', async () => {
    respond(200, [])
    await shareRequest('tok', '/verdicts?version_id=v1', { method: 'GET', shareSession: 'a b&c' })
    expect(lastCall().url.searchParams.get('share_session')).toBe('a b&c')
  })

  it('sets Content-Type only when there is a body', async () => {
    respond(200, {})
    await shareRequest('tok', '/verdict', { method: 'PUT', body: { a: 1 } })
    expect(lastCall().headers['Content-Type']).toBe('application/json')

    respond(200, [])
    await shareRequest('tok', '/verdicts?version_id=v1', { method: 'GET' })
    expect(lastCall().headers['Content-Type']).toBeUndefined()
  })

  it('returns the parsed body, and undefined for a 204', async () => {
    respond(200, [{ id: 'x' }])
    await expect(shareRequest('tok', '/verdicts?version_id=v1', { method: 'GET' })).resolves.toEqual([{ id: 'x' }])

    respond(204)
    await expect(shareRequest('tok', '/verdict?version_id=v1', { method: 'DELETE', guest })).resolves.toBeUndefined()
  })

  it("throws the server's string detail", async () => {
    respond(403, { detail: 'This share link does not allow approvals' })
    await expect(shareRequest('tok', '/verdict', { method: 'PUT', body: {}, guest })).rejects.toThrow(
      'This share link does not allow approvals',
    )
  })

  it('falls back to "Request failed" for a list detail or no JSON body', async () => {
    respond(422, { detail: [{ msg: 'field required' }] })
    await expect(shareRequest('tok', '/verdict', { method: 'PUT', body: {} })).rejects.toThrow('Request failed')

    respond(502)
    await expect(shareRequest('tok', '/verdict', { method: 'PUT', body: {} })).rejects.toThrow('Request failed')
  })
})

describe('shareCallerKey', () => {
  it('names who a read goes as', () => {
    expect(shareCallerKey(guest)).toBe('guest:dana@client.example')
    expect(shareCallerKey(null)).toBe('nobody')
    localStorage.setItem('ff_access_token', jwt(3600))
    expect(shareCallerKey(guest)).toBe('bearer')
    localStorage.setItem('ff_access_token', jwt(-60))
    expect(shareCallerKey(guest)).toBe('lapsed')
    continueAsGuest()
    expect(shareCallerKey(guest)).toBe('guest:dana@client.example')
  })
})

describe('prepareShareWrite', () => {
  it('refreshes a lapsed sign-in and says so', async () => {
    localStorage.setItem('ff_access_token', jwt(-60))
    localStorage.setItem('ff_refresh_token', 'r')
    respond(200, { access_token: jwt(3600), refresh_token: 'r2' })
    await expect(prepareShareWrite()).resolves.toBe('refreshed')
  })

  it('is unchanged for a usable token, no token, or a refused refresh', async () => {
    await expect(prepareShareWrite()).resolves.toBe('unchanged')
    localStorage.setItem('ff_access_token', jwt(3600))
    await expect(prepareShareWrite()).resolves.toBe('unchanged')
    expect(fetchMock).not.toHaveBeenCalled()
    localStorage.setItem('ff_access_token', jwt(-60))
    localStorage.setItem('ff_refresh_token', 'r')
    respond(401, {})
    await expect(prepareShareWrite()).resolves.toBe('unchanged')
  })
})
