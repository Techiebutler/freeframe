import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useReviewStore } from '@/stores/review-store'
import { useVideoPlayer } from '../use-video-player'

// The `detached` option is the mechanism that keeps a compare pane from writing
// to the GLOBAL review store (so it can't corrupt the normal single-asset
// reviewer's playhead/annotation). These tests pin that gate on the two most
// impactful store-write paths: the seek control and the ~4fps playhead sync.
//
// The hook's HLS/media effect bails while videoRef.current is null, so we attach
// a minimal fake element after render to drive the control paths without media.

beforeEach(() => {
  useReviewStore.getState().reset()
})

const SRC = 'http://example.test/v.m3u8'

// videoRef.current is typed read-only; attach a minimal fake element for tests.
function attach(ref: { current: HTMLVideoElement | null }, el: Partial<HTMLVideoElement>) {
  ref.current = el as HTMLVideoElement
}

describe('useVideoPlayer — detached gates global-store writes', () => {
  it('seek writes playheadTime to the store when ATTACHED (normal reviewer)', () => {
    const { result } = renderHook(() => useVideoPlayer(SRC))
    attach(result.current.videoRef, { currentTime: 0, duration: 60, paused: true })
    act(() => result.current.seek(12))
    expect(useReviewStore.getState().playheadTime).toBe(12)
  })

  it('seek does NOT write playheadTime when DETACHED (compare pane)', () => {
    const { result } = renderHook(() => useVideoPlayer(SRC, { detached: true }))
    attach(result.current.videoRef, { currentTime: 0, duration: 60, paused: true })
    act(() => result.current.seek(12))
    expect(useReviewStore.getState().playheadTime).toBe(0) // store untouched
  })

  it('syncs the playing video to the store when ATTACHED', () => {
    vi.useFakeTimers()
    try {
      const { result } = renderHook(() => useVideoPlayer(SRC))
      attach(result.current.videoRef, { currentTime: 7, paused: false })
      act(() => { vi.advanceTimersByTime(300) }) // one ~250ms sync tick
      expect(useReviewStore.getState().playheadTime).toBe(7)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never starts the playhead sync interval when DETACHED', () => {
    vi.useFakeTimers()
    try {
      const { result } = renderHook(() => useVideoPlayer(SRC, { detached: true }))
      attach(result.current.videoRef, { currentTime: 7, paused: false })
      act(() => { vi.advanceTimersByTime(1000) })
      expect(useReviewStore.getState().playheadTime).toBe(0) // store untouched
    } finally {
      vi.useRealTimers()
    }
  })
})

// On iOS the first tap often only starts buffering: play() rejects with nothing
// buffered, and a swallowed rejection meant the user had to tap twice. togglePlay
// now retries once on `canplay`.
describe('useVideoPlayer — togglePlay retries a rejected play() on canplay', () => {
  function fakeVideo(playImpl: () => Promise<void>) {
    const listeners: Record<string, Array<() => void>> = {}
    return {
      el: {
        paused: true,
        play: vi.fn(playImpl),
        pause: vi.fn(),
        addEventListener: vi.fn((type: string, fn: () => void, opts?: AddEventListenerOptions) => {
          void opts
          ;(listeners[type] ||= []).push(fn)
        }),
        removeEventListener: vi.fn(),
      },
      fire: (type: string) => (listeners[type] || []).forEach((fn) => fn()),
      count: (type: string) => (listeners[type] || []).length,
    }
  }

  it('calls play() again once data arrives, so the FIRST tap ends up playing', async () => {
    let call = 0
    const v = fakeVideo(() => {
      call += 1
      return call === 1
        ? Promise.reject(new DOMException('no data', 'AbortError'))
        : Promise.resolve()
    })
    const { result } = renderHook(() => useVideoPlayer(SRC))
    attach(result.current.videoRef, v.el as unknown as Partial<HTMLVideoElement>)

    await act(async () => { result.current.togglePlay() })
    expect(v.el.play).toHaveBeenCalledTimes(1) // first attempt rejected
    expect(v.count('canplay')).toBe(1) // retry armed

    await act(async () => { v.fire('canplay') })
    expect(v.el.play).toHaveBeenCalledTimes(2) // retry fired -> playback starts
  })

  it('registers the retry listener with { once: true } (no accumulation)', async () => {
    const v = fakeVideo(() => Promise.reject(new DOMException('no data', 'AbortError')))
    const { result } = renderHook(() => useVideoPlayer(SRC))
    attach(result.current.videoRef, v.el as unknown as Partial<HTMLVideoElement>)

    await act(async () => { result.current.togglePlay() })
    const call = v.el.addEventListener.mock.calls.find((c) => c[0] === 'canplay')
    expect(call?.[2]).toEqual({ once: true })
  })

  it('leaves the pause path untouched', async () => {
    const v = fakeVideo(() => Promise.resolve())
    v.el.paused = false
    const { result } = renderHook(() => useVideoPlayer(SRC))
    attach(result.current.videoRef, v.el as unknown as Partial<HTMLVideoElement>)

    await act(async () => { result.current.togglePlay() })
    expect(v.el.pause).toHaveBeenCalledTimes(1)
    expect(v.el.play).not.toHaveBeenCalled()
    expect(v.count('canplay')).toBe(0)
  })
})
