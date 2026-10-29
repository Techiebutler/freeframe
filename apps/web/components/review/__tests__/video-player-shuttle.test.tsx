import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as React from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { useReviewStore } from '@/stores/review-store'

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(async () => ({ data: {} })) } }))
vi.mock('../review-provider', () => ({
  useReview: () => ({ registerPauseHandler: () => {}, registerTogglePlayHandler: () => () => {} }),
}))

// A stand-in <video> for the real shuttle hook: paused, and parked well into
// the clip so reverse has room to run.
const video = vi.hoisted(() => ({
  el: null as unknown as EventTarget & { paused: boolean; currentTime: number; seeking: boolean },
}))
const player = vi.hoisted(() => ({ play: vi.fn(), pause: vi.fn() }))

vi.mock('@/hooks/use-video-player', () => ({
  useVideoPlayer: () => ({
    videoRef: { current: video.el }, hlsRef: { current: null },
    isPlaying: false, currentTime: 0, duration: 100, buffered: 0,
    volume: 1, isMuted: false, playbackRate: 1,
    qualityLevels: [], currentQuality: -1, selectedQuality: -1, isLoading: false, isFullscreen: false, error: null,
    play: player.play, pause: player.pause, togglePlay: () => {}, seek: () => {}, setPlaybackRate: () => {},
    setQuality: () => {}, setVolume: () => {}, toggleMute: () => {}, toggleFullscreen: () => {},
  }),
}))

import { VideoPlayer } from '../video-player'

vi.stubGlobal('matchMedia', (query: string) => ({
  matches: true, media: query, onchange: null,
  addEventListener() {}, removeEventListener() {},
  addListener() {}, removeListener() {}, dispatchEvent: () => false,
}))

beforeEach(() => {
  video.el = Object.assign(new EventTarget(), { paused: true, currentTime: 60, seeking: false })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  useReviewStore.setState({ seekTarget: null, activeAnnotation: null, isDrawingMode: false })
})
afterEach(() => {
  vi.clearAllMocks()
})

const props = { assetId: 'a1', comments: [], initialStreamUrl: 'x.m3u8' } as unknown as React.ComponentProps<typeof VideoPlayer>
const speed = () => screen.getByLabelText('Playback speed').textContent

describe('J/K/L in the video player', () => {
  it('J plays in reverse, shown on the speed button', () => {
    render(<VideoPlayer {...props} />)
    fireEvent.keyDown(window, { code: 'KeyJ' })
    expect(speed()).toBe('-1x')
    fireEvent.keyDown(window, { code: 'KeyJ' })
    expect(speed()).toBe('-2x')
    expect(screen.getByLabelText('Pause')).toBeTruthy()
  })

  it('the speed button steps the reverse speed while in reverse', () => {
    render(<VideoPlayer {...props} />)
    fireEvent.keyDown(window, { code: 'KeyJ' })
    fireEvent.click(screen.getByLabelText('Playback speed'))
    expect(speed()).toBe('-2x')
  })

  it('ignores a held key and a modified one, such as Cmd+K or Ctrl+L', () => {
    render(<VideoPlayer {...props} />)
    fireEvent.keyDown(window, { code: 'KeyL', ctrlKey: true })
    fireEvent.keyDown(window, { code: 'KeyL', metaKey: true })
    fireEvent.keyDown(window, { code: 'KeyL', repeat: true })
    expect(player.play).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { code: 'KeyJ', metaKey: true })
    expect(speed()).toBe('1x')
  })

  it('J clears a comment drawing, as forward playback does', () => {
    useReviewStore.setState({ activeAnnotation: { shapes: [] } })
    render(<VideoPlayer {...props} />)
    fireEvent.keyDown(window, { code: 'KeyJ' })
    expect(useReviewStore.getState().activeAnnotation).toBeNull()
  })

  it('clicking a comment stops reverse at its time', () => {
    render(<VideoPlayer {...props} />)
    fireEvent.keyDown(window, { code: 'KeyJ' })
    act(() => useReviewStore.getState().seekTo(12, true))
    expect(speed()).toBe('1x')
    expect(screen.getByLabelText('Play')).toBeTruthy()
  })

  it('a seek that does not pause leaves reverse running', () => {
    render(<VideoPlayer {...props} />)
    fireEvent.keyDown(window, { code: 'KeyJ' })
    act(() => useReviewStore.getState().seekTo(12))
    expect(speed()).toBe('-1x')
  })
})
