import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSSE } from '../use-sse'

vi.mock('@/lib/auth', () => ({
  getAccessToken: vi.fn(() => 'test-token'),
}))

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
