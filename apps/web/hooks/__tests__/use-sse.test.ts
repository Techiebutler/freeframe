import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSSE } from '../use-sse'

const auth = vi.hoisted(() => ({
  getAccessToken: vi.fn((): string | null => 'test-token'),
  refreshAccessToken: vi.fn(async (): Promise<string | null> => null),
}))
vi.mock('@/lib/auth', () => auth)

// A token shaped like the API's: only `exp` matters to the hook.
function jwt(expSecondsFromNow: number): string {
  const b64url = (o: object) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const exp = Math.floor(Date.now() / 1000) + expSecondsFromNow
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: 'u1', type: 'access', exp })}.sig`
}

// Mock EventSource
class MockEventSource {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 2

  url: string
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  listeners: Record<string, ((e: MessageEvent) => void)[]> = {}
  closed = false

  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
  }

  addEventListener(type: string, handler: (e: MessageEvent) => void) {
    if (!this.listeners[type]) {
      this.listeners[type] = []
    }
    this.listeners[type].push(handler)
  }

  removeEventListener(type: string, handler: (e: MessageEvent) => void) {
    if (this.listeners[type]) {
      this.listeners[type] = this.listeners[type].filter((h) => h !== handler)
    }
  }

  close() {
    this.closed = true
  }

  // Test helper: emit a named event
  emit(type: string, data: unknown) {
    const event = { data: JSON.stringify(data) } as MessageEvent
    this.listeners[type]?.forEach((fn) => fn(event))
  }

  static instances: MockEventSource[] = []
  static reset() {
    MockEventSource.instances = []
  }
}

describe('useSSE hook', () => {
  beforeEach(() => {
    MockEventSource.reset()
    vi.stubGlobal('EventSource', MockEventSource)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('creates EventSource with correct URL', () => {
    renderHook(() => useSSE('project-123'))
    expect(MockEventSource.instances).toHaveLength(1)
    expect(MockEventSource.instances[0].url).toContain('/events/project-123')
  })

  it('includes access token in URL query param', () => {
    renderHook(() => useSSE('project-123'))
    expect(MockEventSource.instances[0].url).toContain('token=test-token')
  })

  it('does not create EventSource when projectId is null', () => {
    renderHook(() => useSSE(null))
    expect(MockEventSource.instances).toHaveLength(0)
  })

  it('does not create EventSource when enabled is false', () => {
    renderHook(() => useSSE('project-123', { enabled: false }))
    expect(MockEventSource.instances).toHaveLength(0)
  })

  it('sets isConnected to true when connection opens', () => {
    const { result } = renderHook(() => useSSE('project-123'))
    expect(result.current.isConnected).toBe(false)
    act(() => {
      MockEventSource.instances[0].onopen?.()
    })
    expect(result.current.isConnected).toBe(true)
  })

  it('sets isConnected to false and closes on error', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useSSE('project-123'))

    act(() => {
      MockEventSource.instances[0].onopen?.()
    })
    expect(result.current.isConnected).toBe(true)

    act(() => {
      MockEventSource.instances[0].onerror?.()
    })
    expect(result.current.isConnected).toBe(false)
    expect(MockEventSource.instances[0].closed).toBe(true)

    vi.useRealTimers()
  })

  it('calls onNewComment callback when new_comment event fires', () => {
    const onNewComment = vi.fn()
    renderHook(() => useSSE('project-123', { onNewComment }))

    act(() => {
      MockEventSource.instances[0].emit('new_comment', {
        asset_id: 'a1',
        comment_id: 'c1',
        author: 'Alice',
      })
    })

    expect(onNewComment).toHaveBeenCalledWith({
      asset_id: 'a1',
      comment_id: 'c1',
      author: 'Alice',
    })
  })

  it('cleans up EventSource on unmount', () => {
    const { unmount } = renderHook(() => useSSE('project-123'))
    const instance = MockEventSource.instances[0]
    unmount()
    expect(instance.closed).toBe(true)
  })

  it('schedules reconnect with backoff after error', () => {
    vi.useFakeTimers()
    renderHook(() => useSSE('project-123'))

    act(() => {
      MockEventSource.instances[0].onerror?.()
    })

    // After error, no new instance yet (waiting for timer)
    expect(MockEventSource.instances).toHaveLength(1)

    // After backoff delay (1000ms), a new EventSource should be created
    act(() => {
      vi.advanceTimersByTime(1100)
    })
    expect(MockEventSource.instances).toHaveLength(2)

    vi.useRealTimers()
  })
})

describe('useSSE when the server revokes the stream', () => {
  beforeEach(() => {
    MockEventSource.reset()
    vi.stubGlobal('EventSource', MockEventSource)
    vi.useFakeTimers()
    auth.getAccessToken.mockReset().mockImplementation(() => 'test-token')
    auth.refreshAccessToken.mockReset().mockImplementation(async () => null)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('stops for good when access was revoked', async () => {
    const { result } = renderHook(() => useSSE('project-123'))
    const first = MockEventSource.instances[0]
    act(() => first.onopen?.())
    expect(result.current.isConnected).toBe(true)

    act(() => first.emit('revoked', { reason: 'access_revoked' }))
    expect(first.closed).toBe(true)
    expect(result.current.isConnected).toBe(false)

    // even if the browser reports the closed connection afterwards
    act(() => first.onerror?.())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000)
    })
    expect(MockEventSource.instances).toHaveLength(1)
    expect(auth.refreshAccessToken).not.toHaveBeenCalled()
  })

  it('treats an unreadable revoked event as access revoked', async () => {
    renderHook(() => useSSE('project-123'))
    act(() => {
      const event = { data: 'not json' } as MessageEvent
      MockEventSource.instances[0].listeners['revoked']?.forEach((fn) => fn(event))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(MockEventSource.instances).toHaveLength(1)
  })

  it.each(['token_expired', 'token_revoked'])(
    'refreshes the token and reconnects after %s',
    async (reason) => {
      const original = jwt(600)
      auth.getAccessToken.mockImplementation(() => original)
      auth.refreshAccessToken.mockImplementation(async () => {
        auth.getAccessToken.mockImplementation(() => 'fresh-token')
        return 'fresh-token'
      })
      renderHook(() => useSSE('project-123'))
      expect(MockEventSource.instances[0].url).toContain(`token=${original}`)

      act(() => MockEventSource.instances[0].emit('revoked', { reason }))
      expect(MockEventSource.instances[0].closed).toBe(true)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1100)
      })
      // the refused token is not offered again, even though it has not expired
      expect(auth.refreshAccessToken).toHaveBeenCalledTimes(1)
      expect(MockEventSource.instances).toHaveLength(2)
      expect(MockEventSource.instances[1].url).toContain('token=fresh-token')
    },
  )

  it('does not reconnect with the refused token when the refresh fails', async () => {
    const original = jwt(600)
    auth.getAccessToken.mockImplementation(() => original)
    renderHook(() => useSSE('project-123'))
    act(() => MockEventSource.instances[0].emit('revoked', { reason: 'token_revoked' }))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100)
    })
    expect(auth.refreshAccessToken).toHaveBeenCalledTimes(1)
    expect(MockEventSource.instances).toHaveLength(1)

    // keeps trying on the backoff schedule, never with the refused token
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100)
    })
    expect(auth.refreshAccessToken).toHaveBeenCalledTimes(2)
    expect(MockEventSource.instances).toHaveLength(1)
  })

  it('refreshes an expired stored token before connecting', async () => {
    auth.getAccessToken.mockImplementation(() => jwt(-60))
    auth.refreshAccessToken.mockImplementation(async () => 'fresh-token')
    renderHook(() => useSSE('project-123'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(auth.refreshAccessToken).toHaveBeenCalledTimes(1)
    expect(MockEventSource.instances).toHaveLength(1)
    expect(MockEventSource.instances[0].url).toContain('token=fresh-token')
  })

  it('refreshes a token that expires within the skew before connecting', async () => {
    // valid for another 5 s, which is inside the 10 s margin
    auth.getAccessToken.mockImplementation(() => jwt(5))
    auth.refreshAccessToken.mockImplementation(async () => 'fresh-token')
    renderHook(() => useSSE('project-123'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(auth.refreshAccessToken).toHaveBeenCalledTimes(1)
    expect(MockEventSource.instances).toHaveLength(1)
    expect(MockEventSource.instances[0].url).toContain('token=fresh-token')
  })

  it('does not connect when unmounted while a refresh is in flight', async () => {
    auth.getAccessToken.mockImplementation(() => jwt(-60))
    let resolveRefresh: (token: string | null) => void = () => {}
    auth.refreshAccessToken.mockImplementation(
      () => new Promise<string | null>((resolve) => {
        resolveRefresh = resolve
      }),
    )
    const { unmount } = renderHook(() => useSSE('project-123'))
    expect(auth.refreshAccessToken).toHaveBeenCalledTimes(1)
    unmount()

    await act(async () => {
      resolveRefresh('fresh-token')
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(MockEventSource.instances).toHaveLength(0)
  })

  it('connects with a stored token that is still valid, without refreshing', () => {
    const valid = jwt(600)
    auth.getAccessToken.mockImplementation(() => valid)
    renderHook(() => useSSE('project-123'))
    expect(auth.refreshAccessToken).not.toHaveBeenCalled()
    expect(MockEventSource.instances[0].url).toContain(`token=${valid}`)
  })
})

describe('useSSE with relative NEXT_PUBLIC_API_URL', () => {
  beforeEach(() => {
    MockEventSource.reset()
    vi.stubGlobal('EventSource', MockEventSource)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  // Regression for issue #46: deployments behind nginx set NEXT_PUBLIC_API_URL
  // to a relative path like "/api". `new URL("/api/events/abc")` throws
  // "Failed to construct 'URL': Invalid URL" without a base, crashing the
  // dashboard the moment UploadSSEBridge first opens an SSE connection.
  it('builds a valid URL when NEXT_PUBLIC_API_URL is a relative path', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', '/api')
    vi.resetModules()
    const { useSSE: useSSEFresh } = await import('../use-sse')

    expect(() => renderHook(() => useSSEFresh('project-123'))).not.toThrow()
    expect(MockEventSource.instances).toHaveLength(1)
    expect(MockEventSource.instances[0].url).toContain('/api/events/project-123')
  })
})
