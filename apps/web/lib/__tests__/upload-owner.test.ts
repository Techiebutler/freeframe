import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { subjectOf, currentSubject, watchSubject } from '../upload-owner'
import { clearTokens } from '../auth'

/**
 * An upload belongs to the account that started it, and the only client-side
 * record of "which account" is the `sub` claim in the access token. Tokens live
 * in localStorage, shared by every tab, so another tab signing in as someone
 * else shows up here as a `storage` event carrying a token with a new `sub`.
 */

const b64url = (s: string) =>
  btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** A JWT-shaped token; the signature is never checked client-side. */
function tokenFor(sub: string, extra: Record<string, unknown> = {}): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify({ sub, exp: 9999999999, ...extra }))
  return `${header}.${payload}.sig`
}

const USER_X = '0b7c4a52-8f0e-4c1e-9d3b-6f5a2e1c9a01'
const USER_Y = 'f3e2d1c0-b9a8-4f7e-8d6c-5b4a39281706'

function storageEvent(key: string | null, newValue: string | null, oldValue: string | null = null) {
  window.dispatchEvent(new StorageEvent('storage', { key, newValue, oldValue }))
}

beforeEach(() => localStorage.clear())
afterEach(() => localStorage.clear())

describe('subjectOf', () => {
  it('decodes sub', () => {
    expect(subjectOf(tokenFor(USER_X))).toBe(USER_X)
    // A payload whose base64 needs the url-safe alphabet still decodes.
    expect(subjectOf(tokenFor(USER_Y, { name: '??>>~~' }))).toBe(USER_Y)
    localStorage.setItem('ff_access_token', tokenFor(USER_Y))
    expect(currentSubject()).toBe(USER_Y)
  })

  it('returns null on garbage', () => {
    expect(subjectOf(null)).toBeNull()
    expect(subjectOf('')).toBeNull()
    expect(subjectOf('not-a-jwt')).toBeNull()
    expect(subjectOf('a.!!!not-base64!!!.c')).toBeNull()
    expect(subjectOf(`x.${b64url('not json')}.y`)).toBeNull()
    expect(subjectOf(`x.${b64url(JSON.stringify({ sub: 42 }))}.y`)).toBeNull()
    expect(subjectOf(`x.${b64url(JSON.stringify({ sub: '' }))}.y`)).toBeNull()
    expect(subjectOf(`x.${b64url('null')}.y`)).toBeNull()
    expect(currentSubject()).toBeNull()
  })
})

describe('watchSubject', () => {
  it('fires on a different sub', () => {
    localStorage.setItem('ff_access_token', tokenFor(USER_X))
    const cb = vi.fn()
    const stop = watchSubject(cb)

    storageEvent('ff_access_token', tokenFor(USER_Y), tokenFor(USER_X))
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith(USER_Y, USER_X)

    // The new subject is the baseline for the next change.
    storageEvent('ff_access_token', tokenFor(USER_X), tokenFor(USER_Y))
    expect(cb).toHaveBeenCalledTimes(2)
    expect(cb).toHaveBeenLastCalledWith(USER_X, USER_Y)

    // Other keys are not ours.
    storageEvent('ff_refresh_token', 'something')
    storageEvent('unrelated', tokenFor(USER_Y))
    expect(cb).toHaveBeenCalledTimes(2)

    stop()
    storageEvent('ff_access_token', tokenFor(USER_Y), tokenFor(USER_X))
    expect(cb).toHaveBeenCalledTimes(2)
  })

  it('does not fire on a refreshed token with the same sub', () => {
    localStorage.setItem('ff_access_token', tokenFor(USER_X, { iat: 1 }))
    const cb = vi.fn()
    const stop = watchSubject(cb)

    storageEvent('ff_access_token', tokenFor(USER_X, { iat: 2 }), tokenFor(USER_X, { iat: 1 }))
    storageEvent('ff_access_token', tokenFor(USER_X, { iat: 3 }), tokenFor(USER_X, { iat: 2 }))
    expect(cb).not.toHaveBeenCalled()
    stop()
  })

  it('fires with null when the token is removed', () => {
    localStorage.setItem('ff_access_token', tokenFor(USER_X))
    const cb = vi.fn()
    const stop = watchSubject(cb)

    storageEvent('ff_access_token', null, tokenFor(USER_X))
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith(null, USER_X)

    // A second removal is no change.
    storageEvent('ff_access_token', null, null)
    expect(cb).toHaveBeenCalledTimes(1)

    // Signing back in fires again, and `localStorage.clear()` in another tab
    // (a storage event with a null key) reads as removal too.
    storageEvent('ff_access_token', tokenFor(USER_X), null)
    expect(cb).toHaveBeenLastCalledWith(USER_X, null)
    localStorage.clear()
    storageEvent(null, null)
    expect(cb).toHaveBeenCalledTimes(3)
    expect(cb).toHaveBeenLastCalledWith(null, USER_X)
    stop()
  })

  it('after this tab ends the session, another tab signing the same account back in is reported', () => {
    // A tab never hears its own storage writes, so `clearTokens` in this tab
    // is heard through `onSessionEnded` instead. Without it the watcher still
    // took X for signed in, and X signing back in elsewhere read as no change.
    vi.stubGlobal('location', { href: '' })
    localStorage.setItem('ff_access_token', tokenFor(USER_X))
    const cb = vi.fn()
    const stop = watchSubject(cb)

    clearTokens()
    storageEvent('ff_access_token', tokenFor(USER_X), null)

    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith(USER_X, null)
    stop()
    vi.unstubAllGlobals()
  })

  it('stops hearing this tab end the session once unsubscribed', () => {
    vi.stubGlobal('location', { href: '' })
    localStorage.setItem('ff_access_token', tokenFor(USER_X))
    const cb = vi.fn()
    watchSubject(cb)()

    clearTokens()

    expect(cb).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
