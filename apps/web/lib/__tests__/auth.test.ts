import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setTokens, getAccessToken, getRefreshToken, clearTokens, onSessionEnded } from '../auth'

describe('Token management', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
  })

  it('setTokens stores access and refresh tokens in localStorage', () => {
    setTokens('access-123', 'refresh-456')
    expect(localStorage.getItem('ff_access_token')).toBe('access-123')
    expect(localStorage.getItem('ff_refresh_token')).toBe('refresh-456')
  })

  it('getAccessToken retrieves access token from localStorage', () => {
    localStorage.setItem('ff_access_token', 'my-access-token')
    expect(getAccessToken()).toBe('my-access-token')
  })

  it('getAccessToken returns null when no token stored', () => {
    expect(getAccessToken()).toBeNull()
  })

  it('getRefreshToken retrieves refresh token from localStorage', () => {
    localStorage.setItem('ff_refresh_token', 'my-refresh-token')
    expect(getRefreshToken()).toBe('my-refresh-token')
  })

  it('getRefreshToken returns null when no token stored', () => {
    expect(getRefreshToken()).toBeNull()
  })

  it('clearTokens removes both tokens from localStorage', () => {
    localStorage.setItem('ff_access_token', 'access-123')
    localStorage.setItem('ff_refresh_token', 'refresh-456')

    // Mock window.location.href setter to avoid navigation errors
    const locationMock = { href: '' }
    Object.defineProperty(window, 'location', {
      value: locationMock,
      writable: true,
    })

    clearTokens()

    expect(localStorage.getItem('ff_access_token')).toBeNull()
    expect(localStorage.getItem('ff_refresh_token')).toBeNull()
  })

  it('clearTokens redirects to /login', () => {
    const locationMock = { href: '' }
    Object.defineProperty(window, 'location', {
      value: locationMock,
      writable: true,
    })

    clearTokens()

    expect(window.location.href).toBe('/login')
  })

  it('clearTokens tells onSessionEnded listeners after the tokens are gone and before the page leaves, even past one that throws', () => {
    localStorage.setItem('ff_access_token', 'access-123')
    let href = ''
    const heard: string[] = []
    Object.defineProperty(window, 'location', {
      value: {
        get href() { return href },
        set href(v: string) {
          heard.push(`leave ${v}`)
          href = v
        },
      },
      writable: true,
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const stopFirst = onSessionEnded(() => {
      heard.push(`first ${String(localStorage.getItem('ff_access_token'))}`)
      throw new Error('boom')
    })
    const stopSecond = onSessionEnded(() => heard.push('second'))

    clearTokens()
    stopFirst()
    stopSecond()
    clearTokens()

    expect(heard).toEqual(['first null', 'second', 'leave /login', 'leave /login'])
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})
