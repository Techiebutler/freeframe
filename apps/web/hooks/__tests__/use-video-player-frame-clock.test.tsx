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

function Harness({ detached = false }: { detached?: boolean }) {
  const value = useVideoPlayer('http://example.test/v.mp4', { detached })
  React.useLayoutEffect(() => { player = value })
  // The fixture attaches the real hook's ref so native events reach its listeners.
  // eslint-disable-next-line react-hooks/refs
  return <video ref={value.videoRef} data-testid="video" />
}

function DetachedHarness() {
  return <Harness detached />
}

type FrameCb = (now: number, meta: { mediaTime: number }) => void

function mount(Component: React.ComponentType = Harness) {
  const view = render(<Component />)
  const video = view.getByTestId('video') as HTMLVideoElement
  let time = 0
  let paused = true
  Object.defineProperty(video, 'currentTime', {
    configurable: true,
    get: () => time,
    set: (v: number) => { time = v },
  })
  // jsdom reports `paused` true forever, which would make the `video.paused`
  // clause of the timeupdate guard always true and never exercise the skip.
  Object.defineProperty(video, 'paused', { configurable: true, get: () => paused })
  return {
    video,
    setTime: (t: number) => { time = t },
    setPaused: (p: boolean) => { paused = p },
    setBuffered: (end: number) => {
      Object.defineProperty(video, 'buffered', {
        configurable: true,
        get: () => ({ length: 1, start: () => 0, end: () => end }),
      })
    },
  }
}

/** Drives the clock-is-alive threshold the timeupdate guard reads. */
function fakeClock() {
  let now = 0
  const spy = vi.spyOn(performance, 'now').mockImplementation(() => now)
  return { set: (v: number) => { now = v }, restore: () => spy.mockRestore() }
}

const fire = (video: HTMLVideoElement, type: string) =>
  act(async () => { video.dispatchEvent(new Event(type)) })

const stubFrameCallback = (pending: FrameCb[], cancel = vi.fn()) => {
  Object.assign(HTMLVideoElement.prototype, {
    requestVideoFrameCallback(cb: FrameCb) { pending.push(cb); return pending.length },
    cancelVideoFrameCallback: cancel,
  })
  return cancel
}

beforeEach(() => {
  useReviewStore.getState().reset()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  // @ts-expect-error test-only cleanup of the prototype stub
  delete HTMLVideoElement.prototype.requestVideoFrameCallback
  // @ts-expect-error test-only cleanup of the prototype stub
  delete HTMLVideoElement.prototype.cancelVideoFrameCallback
})

describe('useVideoPlayer: frame clock', () => {
  it('follows every presented frame while playing (requestVideoFrameCallback)', async () => {
    const pending: FrameCb[] = []
    const cancel = stubFrameCallback(pending)
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

  it('settles display and store on the paused position at once', async () => {
    const { video, setTime } = mount()

    await fire(video, 'play')
    setTime(3.04)
    await fire(video, 'pause')

    expect(player.currentTime).toBe(3.04)
    // Display and comment playhead carry the same paused position, within a
    // frame of the picture, without waiting for the next `timeupdate`.
    expect(useReviewStore.getState().playheadTime).toBe(3.04)
  })

  it('does not run a clock in a detached pane', async () => {
    const pending: FrameCb[] = []
    stubFrameCallback(pending)
    const { video } = mount(DetachedHarness)

    await fire(video, 'play')

    // No compare code reads a detached pane's time, so no frame is requested
    // and neither pane re-renders per frame.
    expect(pending).toHaveLength(0)
  })

  it('does not write the store when a detached player is paused', async () => {
    const { video, setTime } = mount(DetachedHarness)

    await fire(video, 'play')
    setTime(7.5)
    await fire(video, 'pause')

    // The pane's own display still settles; the shared playhead is untouched.
    expect(player.currentTime).toBe(7.5)
    expect(useReviewStore.getState().playheadTime).toBe(0)
  })
})

describe('useVideoPlayer: timeupdate defers to a running frame clock', () => {
  it('skips the display while the clock is running, so the label cannot step back', async () => {
    const pending: FrameCb[] = []
    stubFrameCallback(pending)
    const clock = fakeClock()
    const { video, setTime, setPaused } = mount()
    setPaused(false)

    await fire(video, 'play')
    clock.set(1000)
    await act(async () => { pending.shift()!(0, { mediaTime: 2 }) })
    expect(player.currentTime).toBe(2)

    // `timeupdate` carries `video.currentTime`, which can be up to a frame
    // behind the frame just presented.
    setTime(1.96)
    clock.set(1100)
    await fire(video, 'timeupdate')

    expect(player.currentTime).toBe(2)
    clock.restore()
  })

  it('still updates the buffered end while it skips the display', async () => {
    const pending: FrameCb[] = []
    stubFrameCallback(pending)
    const clock = fakeClock()
    const { video, setTime, setPaused, setBuffered } = mount()
    setPaused(false)

    await fire(video, 'play')
    clock.set(1000)
    await act(async () => { pending.shift()!(0, { mediaTime: 2 }) })

    setTime(1.96)
    setBuffered(12.5)
    clock.set(1100)
    await fire(video, 'timeupdate')

    expect(player.currentTime).toBe(2)
    expect(player.buffered).toBe(12.5)
    clock.restore()
  })

  it('writes the display on a paused element, which is how reverse shuttle moves', async () => {
    const pending: FrameCb[] = []
    stubFrameCallback(pending)
    const clock = fakeClock()
    const { video, setTime, setPaused } = mount()
    setPaused(false)

    await fire(video, 'play')
    clock.set(1000)
    await act(async () => { pending.shift()!(0, { mediaTime: 2 }) })

    // J/K/L reverse keeps the element paused and walks `currentTime` itself,
    // and `timeupdate` is the only signal that carries it.
    setPaused(true)
    setTime(1.9)
    clock.set(1050)
    await fire(video, 'timeupdate')

    expect(player.currentTime).toBe(1.9)
    clock.restore()
  })

  it('writes the display again once the clock has stalled, as in a hidden tab', async () => {
    const pending: FrameCb[] = []
    stubFrameCallback(pending)
    const clock = fakeClock()
    const { video, setTime, setPaused } = mount()
    setPaused(false)

    await fire(video, 'play')
    clock.set(1000)
    await act(async () => { pending.shift()!(0, { mediaTime: 2 }) })

    // A hidden tab presents no frames, so neither clock source fires and
    // `timeupdate` takes the transport back.
    setTime(5)
    clock.set(1400)
    await fire(video, 'timeupdate')

    expect(player.currentTime).toBe(5)
    clock.restore()
  })

  it('writes the display before the clock has ever run', async () => {
    const clock = fakeClock()
    const { video, setTime, setPaused } = mount()
    setPaused(false)
    clock.set(50)

    setTime(0.2)
    await fire(video, 'timeupdate')

    expect(player.currentTime).toBe(0.2)
    clock.restore()
  })
})
