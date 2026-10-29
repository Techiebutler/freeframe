import { describe, it, expect, vi } from 'vitest'
import * as React from 'react'
import { render, act } from '@testing-library/react'

// jsdom has no MediaSource, so hls.js is never used here; a direct URL takes
// the plain `video.src` path, which is enough for the element's own events.
vi.mock('hls.js', () => ({ default: class { static isSupported() { return false } } }))

import { useVideoPlayer, type UseVideoPlayerReturn } from '../use-video-player'

let player: UseVideoPlayerReturn

function Harness({ src }: { src: string }) {
  player = useVideoPlayer(src)
  return <video ref={player.videoRef} data-testid="video" />
}

describe('the chosen playback rate', () => {
  it('is put back on the element when a new source loads', () => {
    const { rerender, getByTestId } = render(<Harness src="http://example.test/v1.mp4" />)
    const video = getByTestId('video') as HTMLVideoElement
    act(() => player.setPlaybackRate(1.5))

    rerender(<Harness src="http://example.test/v2.mp4" />)
    // What a browser's load algorithm does, with no ratechange to follow.
    video.playbackRate = 1
    act(() => { video.dispatchEvent(new Event('loadedmetadata')) })

    expect(video.playbackRate).toBe(1.5)
    expect(player.playbackRate).toBe(1.5)
  })
})
