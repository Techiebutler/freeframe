import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * A failed refresh used to clear both tokens and hard-navigate to /login,
 * whatever the reason. `fetch` rejects only on a transport failure, so being
 * offline for one request signed the user out and took the page they had open
 * with it. A 502 from a proxy mid-deploy did the same to everyone at once.
 *
 * Only the server refusing the refresh token ends the session.
 */

const store: Record<string, string> = {}

beforeEach(() => {
  vi.resetModules()
  for (const k of Object.keys(store)) delete store[k]
  store['ff_access_token'] = 'old-access'
  store['ff_refresh_token'] = 'the-refresh-token'
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v },
    removeItem: (k: string) => { delete store[k] },
  })
  // `clearTokens` navigates; jsdom would warn and the assertion we care about
  // is whether the tokens survived.
  vi.stubGlobal('location', { href: '' })
})
afterEach(() => vi.unstubAllGlobals())

async function refresh() {
  const mod = await import('../auth')
  return mod.refreshAccessToken()
}

const sessionSurvived = () =>
  store['ff_refresh_token'] === 'the-refresh-token'

describe('refreshAccessToken', () => {
  it('keeps the session when the request never gets an answer', async () => {
    // The regression: this is what being offline looks like to fetch.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))

    await expect(refresh()).resolves.toBeNull()
    expect(sessionSurvived()).toBe(true)
  })

  it('keeps the session when the server is briefly unavailable', async () => {
    // A proxy returning 502 during a deploy should not sign everyone out.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502 })))

    await expect(refresh()).resolves.toBeNull()
    expect(sessionSurvived()).toBe(true)
  })

  it('ends the session when the refresh token is refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401 })))

    await expect(refresh()).resolves.toBeNull()
    expect(sessionSurvived()).toBe(false)
  })

  it('ends the session on a forbidden refresh, which revocation returns', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403 })))

    await expect(refresh()).resolves.toBeNull()
    expect(sessionSurvived()).toBe(false)
  })

  it('stores the new pair on success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ access_token: 'fresh', refresh_token: 'rotated' }),
    })))

    await expect(refresh()).resolves.toBe('fresh')
    expect(store['ff_access_token']).toBe('fresh')
    expect(store['ff_refresh_token']).toBe('rotated')
  })
})

/**
 * Tokens live in localStorage, which every tab shares. Another tab can sign in,
 * sign out or refresh while this tab's refresh is out, and the answer used to
 * be written over whatever was there: a 200 put the old account's pair over the
 * new sign-in, and a 401 cleared it and sent every tab to /login.
 */
describe('refreshAccessToken when another tab changes the session mid-flight', () => {
  const b64url = (s: string) =>
    btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

  /** A JWT-shaped token; the signature is never checked client-side. */
  function tokenFor(sub: string, type: 'access' | 'refresh', n = 0): string {
    const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
    const payload = b64url(JSON.stringify({ sub, type, exp: 9999999999, n }))
    return `${header}.${payload}.sig`
  }

  const X = '0b7c4a52-8f0e-4c1e-9d3b-6f5a2e1c9a01'
  const Y = 'f3e2d1c0-b9a8-4f7e-8d6c-5b4a39281706'

  function signInAs(sub: string, n = 0) {
    store['ff_access_token'] = tokenFor(sub, 'access', n)
    store['ff_refresh_token'] = tokenFor(sub, 'refresh', n)
  }

  const ok = (sub: string, n: number) => ({
    ok: true, status: 200,
    json: async () => ({
      access_token: tokenFor(sub, 'access', n),
      refresh_token: tokenFor(sub, 'refresh', n),
    }),
  })

  /** A refresh whose answer arrives only after `meanwhile` has run. */
  function answerAfter(meanwhile: () => void, answer: unknown) {
    vi.stubGlobal('fetch', vi.fn(async () => {
      meanwhile()
      return answer
    }))
  }

  beforeEach(() => signInAs(X))

  it('does not write over another account signed in meanwhile', async () => {
    answerAfter(() => signInAs(Y), ok(X, 1))

    await expect(refresh()).resolves.toBeNull()
    expect(store['ff_access_token']).toBe(tokenFor(Y, 'access'))
    expect(store['ff_refresh_token']).toBe(tokenFor(Y, 'refresh'))
  })

  it('does not sign out another account signed in meanwhile', async () => {
    // X deactivated or its password changed: the server refuses X's token.
    answerAfter(() => signInAs(Y), { ok: false, status: 401 })

    await expect(refresh()).resolves.toBeNull()
    expect(store['ff_access_token']).toBe(tokenFor(Y, 'access'))
    expect(store['ff_refresh_token']).toBe(tokenFor(Y, 'refresh'))
    expect(location.href).toBe('')
  })

  it('does not sign back in after another tab signed out meanwhile', async () => {
    answerAfter(() => {
      delete store['ff_access_token']
      delete store['ff_refresh_token']
    }, ok(X, 1))

    await expect(refresh()).resolves.toBeNull()
    expect(store['ff_access_token']).toBeUndefined()
    expect(store['ff_refresh_token']).toBeUndefined()
  })

  it('does not write when the change lands while the body is read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => {
        signInAs(Y)
        return { access_token: tokenFor(X, 'access', 1), refresh_token: tokenFor(X, 'refresh', 1) }
      },
    })))

    await expect(refresh()).resolves.toBeNull()
    expect(store['ff_access_token']).toBe(tokenFor(Y, 'access'))
    expect(store['ff_refresh_token']).toBe(tokenFor(Y, 'refresh'))
  })

  it('uses the pair another tab stored for the same account', async () => {
    // Two tabs of one account refreshing together: the one answered second
    // keeps the other's pair and retries with it, rather than failing.
    answerAfter(() => signInAs(X, 1), ok(X, 2))

    await expect(refresh()).resolves.toBe(tokenFor(X, 'access', 1))
    expect(store['ff_access_token']).toBe(tokenFor(X, 'access', 1))
    expect(store['ff_refresh_token']).toBe(tokenFor(X, 'refresh', 1))
  })

  it('keeps the same account signed in again meanwhile when the old token is refused', async () => {
    // X changed their password and signed in again in another tab, which
    // revokes the token this tab sent. The new session is the one to keep.
    answerAfter(() => signInAs(X, 1), { ok: false, status: 401 })

    await expect(refresh()).resolves.toBe(tokenFor(X, 'access', 1))
    expect(store['ff_refresh_token']).toBe(tokenFor(X, 'refresh', 1))
    expect(location.href).toBe('')
  })
})
