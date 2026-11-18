import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { hasStoredToken, hasUsableToken, isSignInExpired, shareRequest, SIGN_IN_EXPIRED } from '../share-request'

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

  // ...and when it cannot, sends nothing and says so, rather than going as the guest.
  it.each([
    ['refused', () => respond(401, { detail: 'Invalid refresh token' })],
    ['offline', () => fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))],
  ])('with an expired token whose refresh is %s, sends nothing and throws the sign-in message', async (_, answer) => {
    localStorage.setItem('ff_access_token', jwt(-60))
    localStorage.setItem('ff_refresh_token', 'the-refresh-token')
    answer()

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
  })

  it('with an expired token and no refresh token, sends nothing either', async () => {
    localStorage.setItem('ff_access_token', jwt(-60))
    await expect(
      shareRequest('tok', '/verdict?version_id=v1', { method: 'DELETE', guest }),
    ).rejects.toThrow(SIGN_IN_EXPIRED)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // "Continue as guest" is the explicit choice that makes the guest fields go.
  it('with an expired token and asGuest, sends the guest fields with no Authorization and no refresh', async () => {
    localStorage.setItem('ff_access_token', jwt(-60))
    localStorage.setItem('ff_refresh_token', 'the-refresh-token')
    respond(200, { id: 'v' })

    await shareRequest('tok', '/verdict', {
      method: 'PUT',
      body: { version_id: 'v1', status: 'approved' },
      guest,
      asGuest: true,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const { headers, body } = lastCall()
    expect(headers.Authorization).toBeUndefined()
    expect(body).toEqual({ version_id: 'v1', status: 'approved', guest_name: 'Dana', guest_email: 'dana@client.example' })
  })

  it('asGuest does not override a usable bearer', async () => {
    const token = jwt(3600)
    localStorage.setItem('ff_access_token', token)
    respond(200, {})
    await shareRequest('tok', '/verdict', { method: 'PUT', body: {}, guest, asGuest: true })
    expect(lastCall().headers.Authorization).toBe(`Bearer ${token}`)
    expect(lastCall().body).toEqual({})
  })

  // Reads never ask and never refresh: they go as the guest.
  it('reads with an expired token as the guest, with no refresh', async () => {
    localStorage.setItem('ff_access_token', jwt(-60))
    localStorage.setItem('ff_refresh_token', 'the-refresh-token')
    respond(200, [])

    await shareRequest('tok', '/verdicts?version_id=v1', { method: 'GET', guest })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const { url, headers } = lastCall()
    expect(url.pathname).toBe('/share/tok/verdicts')
    expect(headers.Authorization).toBeUndefined()
    expect(url.searchParams.get('guest_email')).toBe('dana@client.example')
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
