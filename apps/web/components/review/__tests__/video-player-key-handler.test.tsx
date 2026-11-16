import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as React from 'react'
import { render, fireEvent } from '@testing-library/react'
import { useReviewStore } from '@/stores/review-store'

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(async () => ({ data: {} })) } }))
vi.mock('../review-provider', () => ({
  useReview: () => ({ registerPauseHandler: () => {}, registerTogglePlayHandler: () => () => {} }),
}))

/**
 * The display now updates once per presented frame, so anything that rebinds
 * per render rebinds 25 to 60 times a second. The window keydown listener must
 * read the time through a ref instead of taking it as a dependency.
 */

const state = vi.hoisted(() => ({ currentTime: 0 }))
const seek = vi.hoisted(() => vi.fn())
const controls = vi.hoisted(() => ({
  videoRef: { current: null as HTMLVideoElement | null },
  hlsRef: { current: null },
  play: vi.fn(), pause: vi.fn(), togglePlay: vi.fn(), setPlaybackRate: vi.fn(),
  setQuality: vi.fn(), setVolume: vi.fn(), toggleMute: vi.fn(), toggleFullscreen: vi.fn(),
}))

vi.mock('@/hooks/use-video-player', () => ({
  useVideoPlayer: () => ({
    ...controls,
    isPlaying: false, currentTime: state.currentTime, duration: 100, buffered: 0,
    volume: 1, isMuted: false, playbackRate: 1,
    qualityLevels: [], currentQuality: -1, selectedQuality: -1, isLoading: false, isFullscreen: false, error: null,
    seek,
  }),
}))

import { VideoPlayer } from '../video-player'

vi.stubGlobal('matchMedia', (query: string) => ({
  matches: true, media: query, onchange: null,
  addEventListener() {}, removeEventListener() {},
  addListener() {}, removeListener() {}, dispatchEvent: () => false,
}))

beforeEach(() => {
  state.currentTime = 0
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  useReviewStore.setState({ seekTarget: null, activeAnnotation: null, isDrawingMode: false })
})

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

const props = { assetId: 'a1', comments: [], initialStreamUrl: 'x.m3u8' } as unknown as React.ComponentProps<typeof VideoPlayer>

/** Counts only the window keydown binding the shortcut effect installs. */
function countKeydownBindings() {
  const spy = vi.spyOn(window, 'addEventListener')
  return () => spy.mock.calls.filter(([type]) => type === 'keydown').length
}

describe('video player keyboard shortcuts', () => {
  it('seeks from the time of the last frame, not the time the effect closed over', () => {
    const { rerender } = render(<VideoPlayer {...props} />)

    // Frames advance the display; the listener must see the new time.
    state.currentTime = 12
    rerender(<VideoPlayer {...props} />)
    fireEvent.keyDown(window, { code: 'ArrowRight' })
    expect(seek).toHaveBeenLastCalledWith(17)

    state.currentTime = 30
    rerender(<VideoPlayer {...props} />)
    fireEvent.keyDown(window, { code: 'ArrowLeft' })
    expect(seek).toHaveBeenLastCalledWith(25)
  })

  it('binds the window listener once, not once per frame', () => {
    const bound = countKeydownBindings()
    const { rerender } = render(<VideoPlayer {...props} />)
    expect(bound()).toBe(1)

    // 30 presented frames at 25 fps is a little over a second of playback.
    for (let frame = 1; frame <= 30; frame += 1) {
      state.currentTime = frame / 25
      rerender(<VideoPlayer {...props} />)
    }

    expect(bound()).toBe(1)
  })
})
