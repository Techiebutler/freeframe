import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as React from 'react'
import { render, act } from '@testing-library/react'
import { useReviewStore } from '@/stores/review-store'
import { useVideoPlayer, type UseVideoPlayerReturn } from '../use-video-player'

/**
 * The timecode must follow the picture frame by frame. `timeupdate` alone fires
 * every 250-330 ms in Chrome (7-8 frames at 25 fps, measured), so the display
 * moved in steps and jumped on pause when the final update caught up.
 *
 * Real hook, real jsdom <video>; only the clock sources and `currentTime` are
 * stubbed, because jsdom plays nothing.
 */

let player: UseVideoPlayerReturn

function Harness() {
  player = useVideoPlayer('http://example.test/v.mp4')
  return <video ref={player.videoRef} data-testid="video" />
}

type FrameCb = (now: number, meta: { mediaTime: number }) => void

function mount() {
  const view = render(<Harness />)
  const video = view.getByTestId('video') as HTMLVideoElement
  let time = 0
  Object.defineProperty(video, 'currentTime', {
    configurable: true,
    get: () => time,
    set: (v: number) => { time = v },
  })
  return { video, setTime: (t: number) => { time = t } }
}

const fire = (video: HTMLVideoElement, type: string) =>
  act(async () => { video.dispatchEvent(new Event(type)) })

beforeEach(() => {
  useReviewStore.getState().reset()
})

afterEach(() => {
  vi.unstubAllGlobals()
  // @ts-expect-error test-only cleanup of the prototype stub
  delete HTMLVideoElement.prototype.requestVideoFrameCallback
  // @ts-expect-error test-only cleanup of the prototype stub
  delete HTMLVideoElement.prototype.cancelVideoFrameCallback
})

describe('useVideoPlayer: frame clock', () => {
  it('follows every presented frame while playing (requestVideoFrameCallback)', async () => {
    const pending: FrameCb[] = []
    const cancel = vi.fn()
    Object.assign(HTMLVideoElement.prototype, {
      requestVideoFrameCallback(cb: FrameCb) { pending.push(cb); return pending.length },
      cancelVideoFrameCallback: cancel,
    })
    const { video } = mount()

    await fire(video, 'play')
    for (const k of [1, 2, 3]) {
      const cb = pending.shift()!
      await act(async () => { cb(0, { mediaTime: k / 25 }) })
      expect(player.currentTime).toBe(k / 25) // one frame per step, no 7-frame strides
    }

    await fire(video, 'pause')
    expect(cancel).toHaveBeenCalled() // the clock stops with the picture
  })

  it('falls back to requestAnimationFrame where requestVideoFrameCallback is missing', async () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length })
    const cancelRaf = vi.fn()
    vi.stubGlobal('cancelAnimationFrame', cancelRaf)
    const { video, setTime } = mount()

    await fire(video, 'play')
    setTime(0.44)
    await act(async () => { frames.shift()!(0) })
    expect(player.currentTime).toBe(0.44)

    await fire(video, 'pause')
    expect(cancelRaf).toHaveBeenCalled()
  })

  it('settles display and store on the paused frame, without waiting for timeupdate', async () => {
    const { video, setTime } = mount()

    await fire(video, 'play')
    setTime(3.04)
    await fire(video, 'pause')

    expect(player.currentTime).toBe(3.04)
    // A comment written now is anchored to the frame on screen.
    expect(useReviewStore.getState().playheadTime).toBe(3.04)
  })
})
