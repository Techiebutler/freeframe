import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as React from 'react'
import { render, screen } from '@testing-library/react'

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(async () => ({ data: {} })) } }))
vi.mock('../review-provider', () => ({ useReview: () => ({ registerPauseHandler: () => {} }) }))
vi.mock('@/hooks/use-video-player', () => ({
  useVideoPlayer: () => ({
    videoRef: { current: null }, hlsRef: { current: null },
    isPlaying: false, currentTime: 0, duration: 100, buffered: 0,
    volume: 1, isMuted: false, playbackRate: 1,
    qualityLevels: [], currentQuality: -1, isLoading: false, isFullscreen: false, error: null,
    pause: () => {}, togglePlay: () => {}, seek: () => {}, setPlaybackRate: () => {},
    setQuality: () => {}, setVolume: () => {}, toggleMute: () => {}, toggleFullscreen: () => {},
  }),
}))

import { VideoPlayer } from '../video-player'

/**
 * `use-media-query` caches each MediaQueryList at module scope, which is right
 * in a browser because a real list is live, but means a stub returning a frozen
 * `matches` would be read once and reused for the rest of the file. So this
 * returns a list whose `matches` is a getter over a mutable width.
 */
let width = 1024
function stubWidth(px: number) { width = px }

vi.stubGlobal('matchMedia', (query: string) => {
  const m = query.match(/min-width:\s*(\d+)px/)
  return {
    get matches() { return m ? width >= Number(m[1]) : false },
    media: query, onchange: null,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, dispatchEvent: () => false,
  }
})

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => { vi.clearAllMocks() })

const props = { assetId: 'a1', versionId: 'v1', comments: [], initialStreamUrl: 'x.m3u8' } as unknown as React.ComponentProps<typeof VideoPlayer>

describe('the transport row below sm', () => {
  it('moves loop, speed and mute behind an overflow menu on a phone', () => {
    stubWidth(390)
    render(<VideoPlayer {...props} />)

    expect(screen.getByLabelText('More controls')).toBeTruthy()
    // The three that moved. Their inline buttons must be gone, not merely
    // hidden, or a screen reader still reaches two of each.
    expect(screen.queryByLabelText('Loop')).toBeNull()
    expect(screen.queryByLabelText('Playback speed')).toBeNull()
    expect(screen.queryByLabelText('Mute')).toBeNull()
  })

  it('keeps every control inline above sm, with no overflow menu', () => {
    stubWidth(1024)
    render(<VideoPlayer {...props} />)

    expect(screen.queryByLabelText('More controls')).toBeNull()
    expect(screen.getByLabelText('Loop')).toBeTruthy()
    expect(screen.getByLabelText('Playback speed')).toBeTruthy()
  })

  it('gives the play button a 44px target when compact and 28px when not', () => {
    stubWidth(390)
    const { unmount } = render(<VideoPlayer {...props} />)
    expect(screen.getByLabelText('Play').className).toContain('h-11')
    unmount()

    stubWidth(1024)
    render(<VideoPlayer {...props} />)
    expect(screen.getByLabelText('Play').className).toContain('h-7')
  })
})
