import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
  api: {
    post: vi.fn(),
    get: vi.fn(),
  },
}))

import { retainWakeLock, releaseWakeLock } from '../upload-store'

/** Minimal stand-in for a WakeLockSentinel. */
function makeSentinel() {
  return {
    release: vi.fn().mockResolvedValue(undefined),
    addEventListener: vi.fn(),
  }
}

describe('upload wake lock', () => {
  let request: ReturnType<typeof vi.fn>
  let sentinel: ReturnType<typeof makeSentinel>

  beforeEach(() => {
    sentinel = makeSentinel()
    request = vi.fn().mockResolvedValue(sentinel)
    Object.defineProperty(navigator, 'wakeLock', {
      value: { request },
      configurable: true,
      writable: true,
    })
  })

  afterEach(() => {
    // Leave no holder behind for the next test.
    releaseWakeLock()
    releaseWakeLock()
    Reflect.deleteProperty(navigator as object, 'wakeLock')
  })

  it('requests a screen wake lock while an upload runs', async () => {
    retainWakeLock()
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('screen'))
  })

  it('releases the lock when the last upload finishes', async () => {
    retainWakeLock()
    await vi.waitFor(() => expect(request).toHaveBeenCalled())

    releaseWakeLock()
    expect(sentinel.release).toHaveBeenCalled()
  })

  it('holds the lock until every concurrent upload is done', async () => {
    retainWakeLock()
    retainWakeLock()
    await vi.waitFor(() => expect(request).toHaveBeenCalled())

    releaseWakeLock()
    expect(sentinel.release).not.toHaveBeenCalled() // one upload still running

    releaseWakeLock()
    expect(sentinel.release).toHaveBeenCalled()
  })

  it('requests the lock only once for concurrent uploads', async () => {
    retainWakeLock()
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    retainWakeLock()
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
  })

  it('is a no-op when the browser has no Wake Lock API', () => {
    Reflect.deleteProperty(navigator as object, 'wakeLock')
    expect(() => {
      retainWakeLock()
      releaseWakeLock()
    }).not.toThrow()
  })

  it('does not fail the upload when the lock is refused', async () => {
    request.mockRejectedValue(new DOMException('denied', 'NotAllowedError'))
    expect(() => retainWakeLock()).not.toThrow()
    await vi.waitFor(() => expect(request).toHaveBeenCalled())
    expect(() => releaseWakeLock()).not.toThrow()
  })

  // Dropping several files calls startUpload once per file, and each runs
  // synchronously as far as retainWakeLock() before its first await. Selecting
  // N files therefore means N retains before the first request has resolved.
  it('requests a single sentinel when several uploads start in the same tick', async () => {
    const acquired: ReturnType<typeof makeSentinel>[] = []
    request.mockImplementation(async () => {
      const next = makeSentinel()
      acquired.push(next)
      return next
    })

    retainWakeLock()
    retainWakeLock()
    retainWakeLock()
    await vi.waitFor(() => expect(request).toHaveBeenCalled())

    expect(request).toHaveBeenCalledTimes(1)

    releaseWakeLock()
    releaseWakeLock()
    releaseWakeLock()
    const stillHeld = acquired.filter((s) => s.release.mock.calls.length === 0)
    expect(stillHeld).toHaveLength(0)
  })

  it('releases a lock that arrives after the last upload already finished', async () => {
    let handOver: (s: unknown) => void = () => {}
    request.mockImplementation(() => new Promise((resolve) => { handOver = resolve }))

    retainWakeLock() // the request is in flight
    releaseWakeLock() // a short upload finishes before it resolves
    handOver(sentinel) // only now does the browser hand the sentinel over

    await vi.waitFor(() => expect(sentinel.release).toHaveBeenCalled())
  })
})
