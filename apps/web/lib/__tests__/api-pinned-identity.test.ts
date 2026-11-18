import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * An upload is pinned to the account that queued it. Tokens live in
 * localStorage and every tab shares them, so another tab can sign in as a
 * different user while this tab's initiate is in flight, or between the
 * store's owner check and the fetch. A pinned request must never be sent, or
 * resent after a refresh, under any account but its own.
 *
 * Deliberately NOT mocking `../auth`: the refresh chain (dedup, keep tokens on
 * a network failure, clear them and navigate on a refusal) is the real one,
 * driven only through a mocked `fetch`.
 */

const b64url = (s: string) =>
  btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

function tokenFor(sub: string, n = 0): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify({ sub, exp: 9999999999, n }))
  return `${header}.${payload}.sig`
}

const X = '0b7c4a52-8f0e-4c1e-9d3b-6f5a2e1c9a01'
const Y = 'f3e2d1c0-b9a8-4f7e-8d6c-5b4a39281706'

const INITIATE = '/upload/initiate'
const BODY = { project_id: 'p', name: 'a.mp4' }

type Handler = (url: string, init: RequestInit) => Promise<Response> | Response

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

let calls: { url: string; auth: string | undefined }[] = []

function stubFetch(routes: { initiate: Handler[]; refresh?: Handler[] }) {
  const queues = { initiate: [...routes.initiate], refresh: [...(routes.refresh ?? [])] }
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input)
    const headers = (init.headers ?? {}) as Record<string, string>
    calls.push({ url, auth: headers['Authorization'] })
    const queue = url.endsWith('/auth/refresh') ? queues.refresh : queues.initiate
    const next = queue.shift()
    if (!next) throw new Error(`unexpected fetch ${url}`)
    return next(url, init)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const sentTo = (path: string) => calls.filter((c) => c.url.endsWith(path))

function signIn(sub: string, n = 0) {
  localStorage.setItem('ff_access_token', tokenFor(sub, n))
  localStorage.setItem('ff_refresh_token', `refresh-${sub}-${n}`)
}

let location: { href: string }

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  calls = []
  // `clearTokens` assigns `window.location.href`; jsdom cannot navigate.
  location = { href: '' }
  vi.stubGlobal('location', location)
})
afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

async function load() {
  return import('../api')
}

async function codeOf(p: Promise<unknown>): Promise<{ status: number; code?: string }> {
  const { ApiError } = await load()
  try {
    await p
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError)
    const e = err as InstanceType<typeof ApiError>
    return { status: e.status, code: e.code }
  }
  throw new Error('expected the request to throw')
}

describe('pinned-identity requests', () => {
  it("a 401 where Y's tokens were written during the round trip sends no second initiate and throws identity_changed", async () => {
    signIn(X)
    stubFetch({
      initiate: [
        () => {
          // Another tab signs in as Y while this initiate is on the wire, and
          // X's token is refused.
          signIn(Y)
          return json(401, { detail: 'Not authenticated' })
        },
      ],
      refresh: [() => json(200, { access_token: tokenFor(Y, 1), refresh_token: `refresh-${Y}-1` })],
    })
    const { api } = await load()

    const err = await codeOf(api.post(INITIATE, BODY, { pinSubject: X }))

    expect(err).toEqual({ status: 401, code: 'identity_changed' })
    expect(sentTo(INITIATE)).toHaveLength(1)
    expect(sentTo(INITIATE)[0].auth).toBe(`Bearer ${tokenFor(X)}`)
    // Y's session is Y's; this tab did not refresh it or sign anyone out.
    expect(sentTo('/auth/refresh')).toHaveLength(0)
    expect(localStorage.getItem('ff_access_token')).toBe(tokenFor(Y))
    expect(location.href).toBe('')
  })

  it("a 401 while another account is signed in does not refresh with that account's token", async () => {
    // Refreshing would spend Y's refresh token on X's request, and a refusal
    // would sign Y out of every tab.
    signIn(X)
    stubFetch({
      initiate: [
        () => {
          signIn(Y)
          return json(401, { detail: 'Not authenticated' })
        },
      ],
      refresh: [() => json(401, { detail: 'Invalid refresh token' })],
    })
    const { api } = await load()

    const err = await codeOf(api.post(INITIATE, BODY, { pinSubject: X }))

    expect(err).toEqual({ status: 401, code: 'identity_changed' })
    expect(sentTo('/auth/refresh')).toHaveLength(0)
    expect(localStorage.getItem('ff_access_token')).toBe(tokenFor(Y))
    expect(localStorage.getItem('ff_refresh_token')).toBe(`refresh-${Y}-0`)
    expect(location.href).toBe('')
  })

  it('a refresh that gets no answer while another account signs in throws identity_changed', async () => {
    signIn(X)
    stubFetch({
      initiate: [() => json(401, { detail: 'Token expired' })],
      refresh: [
        () => {
          // Y signs in while X's refresh is on the wire, and the refresh is
          // lost to the network: the tokens left are Y's.
          signIn(Y)
          throw new TypeError('Failed to fetch')
        },
      ],
    })
    const { api } = await load()

    const err = await codeOf(api.post(INITIATE, BODY, { pinSubject: X }))

    expect(err).toEqual({ status: 401, code: 'identity_changed' })
    expect(sentTo(INITIATE)).toHaveLength(1)
    expect(localStorage.getItem('ff_access_token')).toBe(tokenFor(Y))
  })

  it('a 401 whose refresh fails on the network throws refresh_unavailable', async () => {
    signIn(X)
    stubFetch({
      initiate: [() => json(401, { detail: 'Token expired' })],
      refresh: [() => { throw new TypeError('Failed to fetch') }],
    })
    const { api } = await load()

    const err = await codeOf(api.post(INITIATE, BODY, { pinSubject: X }))

    expect(err).toEqual({ status: 401, code: 'refresh_unavailable' })
    expect(sentTo(INITIATE)).toHaveLength(1)
    expect(sentTo('/auth/refresh')).toHaveLength(1)
    // The session survives the outage.
    expect(localStorage.getItem('ff_access_token')).toBe(tokenFor(X))
    expect(location.href).toBe('')
  })

  it('a 401 whose refresh is refused throws session_ended', async () => {
    signIn(X)
    stubFetch({
      initiate: [() => json(401, { detail: 'Token expired' })],
      refresh: [() => json(401, { detail: 'Invalid refresh token' })],
    })
    const { api } = await load()

    const err = await codeOf(api.post(INITIATE, BODY, { pinSubject: X }))

    expect(err).toEqual({ status: 401, code: 'session_ended' })
    expect(sentTo(INITIATE)).toHaveLength(1)
    expect(localStorage.getItem('ff_access_token')).toBeNull()
    expect(location.href).toBe('/login')
  })

  it('a same-sub refresh resends once', async () => {
    signIn(X)
    stubFetch({
      initiate: [
        () => json(401, { detail: 'Token expired' }),
        () => json(200, { version_id: 'v1' }),
      ],
      refresh: [() => json(200, { access_token: tokenFor(X, 1), refresh_token: `refresh-${X}-1` })],
    })
    const { api } = await load()

    await expect(api.post(INITIATE, BODY, { pinSubject: X })).resolves.toEqual({ version_id: 'v1' })

    expect(sentTo(INITIATE).map((c) => c.auth)).toEqual([
      `Bearer ${tokenFor(X)}`,
      `Bearer ${tokenFor(X, 1)}`,
    ])
  })

  it('a same-sub refresh resends only once, and a second 401 surfaces as itself', async () => {
    signIn(X)
    stubFetch({
      initiate: [
        () => json(401, { detail: 'Token expired' }),
        () => json(401, { detail: 'Still no' }),
      ],
      refresh: [() => json(200, { access_token: tokenFor(X, 1), refresh_token: `refresh-${X}-1` })],
    })
    const { api } = await load()

    const err = await codeOf(api.post(INITIATE, BODY, { pinSubject: X }))

    expect(err).toEqual({ status: 401, code: undefined })
    expect(sentTo(INITIATE)).toHaveLength(2)
    expect(sentTo('/auth/refresh')).toHaveLength(1)
  })

  it('a token switched before the send sends nothing and throws identity_changed', async () => {
    // The store checked the row's owner against X; another tab signed in as Y
    // before the fetch.
    signIn(Y)
    const fetchMock = stubFetch({ initiate: [] })
    const { api } = await load()

    const err = await codeOf(api.post(INITIATE, BODY, { pinSubject: X }))

    expect(err).toEqual({ status: 401, code: 'identity_changed' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a token removed before the send sends nothing and throws session_ended', async () => {
    const fetchMock = stubFetch({ initiate: [] })
    const { api } = await load()

    const err = await codeOf(api.post(INITIATE, BODY, { pinSubject: X }))

    expect(err).toEqual({ status: 401, code: 'session_ended' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(location.href).toBe('')
  })

  it('every helper the upload store uses honours the pin', async () => {
    signIn(Y)
    const fetchMock = stubFetch({ initiate: [] })
    const { api } = await load()
    const pin = { pinSubject: X }

    for (const call of [
      () => api.get('/upload/v/parts', pin),
      () => api.post('/upload/complete', {}, pin),
      () => api.patch('/assets/a', { name: 'n' }, pin),
      () => api.put('/x', {}, pin),
      () => api.delete('/x', pin),
      () => api.upload('/x', new FormData(), pin),
    ]) {
      expect(await codeOf(call())).toEqual({ status: 401, code: 'identity_changed' })
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a pinned form upload refuses a refresh that lands on another account', async () => {
    signIn(X)
    stubFetch({
      initiate: [() => json(401, { detail: 'Token expired' })],
      refresh: [() => json(200, { access_token: tokenFor(Y, 1), refresh_token: `refresh-${Y}-1` })],
    })
    const { api } = await load()

    const err = await codeOf(api.upload('/x', new FormData(), { pinSubject: X }))

    expect(err).toEqual({ status: 401, code: 'identity_changed' })
    expect(sentTo('/x')).toHaveLength(1)
  })

  it('requests without pinSubject behave as before', async () => {
    // A switched account is not this request's business: it is sent with
    // whatever token is there, and resent after any successful refresh.
    signIn(X)
    stubFetch({
      initiate: [
        () => {
          signIn(Y)
          return json(401, { detail: 'Token expired' })
        },
        () => json(200, { ok: true }),
        () => json(401, { detail: 'Token expired' }),
      ],
      refresh: [
        () => json(200, { access_token: tokenFor(Y, 1), refresh_token: `refresh-${Y}-1` }),
        () => { throw new TypeError('Failed to fetch') },
      ],
    })
    const { api } = await load()

    await expect(api.post(INITIATE, BODY)).resolves.toEqual({ ok: true })
    expect(sentTo(INITIATE).map((c) => c.auth)).toEqual([
      `Bearer ${tokenFor(X)}`,
      `Bearer ${tokenFor(Y, 1)}`,
    ])

    // A refresh lost to the network surfaces the original 401, uncoded.
    expect(await codeOf(api.post(INITIATE, BODY))).toEqual({ status: 401, code: undefined })
    expect(sentTo(INITIATE)).toHaveLength(3)

    // With no token at all, the request still goes out (public endpoints).
    localStorage.clear()
    stubFetch({ initiate: [() => json(200, { public: true })] })
    await expect(api.get('/branding')).resolves.toEqual({ public: true })
    expect(calls.at(-1)?.auth).toBeUndefined()
  })
})
