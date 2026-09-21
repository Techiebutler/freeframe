import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as React from 'react'
import { render, act } from '@testing-library/react'
import { useReviewStore } from '@/stores/review-store'

// jsdom has no MediaSource, so `Hls.isSupported()` is false there and the whole
// hls.js branch of the hook is unreachable. A fake lets a test switch that
// branch on, which is the only way `startLoad()` can be pinned at all.
const hlsMock = vi.hoisted(() => {
  const instances: Array<{ startLoad: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }> = []
  class FakeHls {
    static supported = false
    static isSupported() { return FakeHls.supported }
    static Events = { MANIFEST_PARSED: 'manifestParsed', ERROR: 'error', LEVEL_SWITCHED: 'levelSwitched' }
    loadSource = vi.fn()
    attachMedia = vi.fn()
    on = vi.fn()
    destroy = vi.fn()
    startLoad = vi.fn()
    constructor() { instances.push(this) }
  }
  return { FakeHls, instances }
})
vi.mock('hls.js', () => ({ default: hlsMock.FakeHls }))

import { useVideoPlayer, type UseVideoPlayerReturn } from '../use-video-player'

/**
 * On iOS the first tap often only starts buffering: play() rejects with nothing
 * buffered, and togglePlay retries once on the next `canplay`.
 *
 * These render the REAL hook against a REAL jsdom <video>, so the media effect
 * runs, its teardown runs, and the listeners are the element's own. A
 * hand-rolled object assigned to `videoRef.current` after render makes the
 * effect bail on the null ref, and its teardown never runs: that is how a retry
 * that was never disarmed survived a green suite.
 *
 * jsdom implements neither play() nor pause(), and `paused` is read-only, so
 * those three are stubbed on the element. Everything else is the real thing.
 */

const V1 = 'http://example.test/v1.m3u8'
const V2 = 'http://example.test/v2.m3u8'

let player: UseVideoPlayerReturn

function Harness({ src }: { src: string | null }) {
  player = useVideoPlayer(src)
  return <video ref={player.videoRef} data-testid="video" />
}

type PlayImpl = () => Promise<void>

function mount(playImpl: PlayImpl, opts: { paused?: boolean; duration?: number } = {}) {
  const view = render(<Harness src={V1} />)
  const video = view.getByTestId('video') as HTMLVideoElement
  const play = vi.fn(playImpl)
  const pause = vi.fn()
  video.play = play
  video.pause = pause
  Object.defineProperty(video, 'paused', { configurable: true, get: () => opts.paused ?? true })
  if (opts.duration !== undefined) setDuration(video, opts.duration)
  return { ...view, video, play, pause }
}

function setDuration(video: HTMLVideoElement, duration: number) {
  Object.defineProperty(video, 'duration', { configurable: true, get: () => duration })
}

const rejected: PlayImpl = () => Promise.reject(new DOMException('no data', 'NotAllowedError'))

/** First call rejects (the first tap), every later call resolves (the retry). */
function rejectsOnce(): PlayImpl {
  let call = 0
  return () => {
    call += 1
    return call === 1 ? rejected() : Promise.resolve()
  }
}

/** A play() that stays pending until the test settles it, as it does in a
 * browser while the element has nothing to play yet. */
function pendingPlay() {
  let reject!: (reason: unknown) => void
  const impl: PlayImpl = () => new Promise<void>((_resolve, rej) => { reject = rej })
  return { impl, abort: () => reject(new DOMException('interrupted by pause()', 'AbortError')) }
}

const tap = () => act(async () => { player.togglePlay() })
const fire = (video: HTMLVideoElement, type: string) => act(async () => { video.dispatchEvent(new Event(type)) })

beforeEach(() => {
  useReviewStore.getState().reset()
  hlsMock.FakeHls.supported = false
  hlsMock.instances.length = 0
})

describe('useVideoPlayer: the first tap retries a rejected play() on canplay', () => {
  it('calls play() once more when data arrives, and only once', async () => {
    const { video, play } = mount(rejectsOnce())

    await tap()
    expect(play).toHaveBeenCalledTimes(1) // the first attempt, rejected

    await fire(video, 'canplay')
    expect(play).toHaveBeenCalledTimes(2) // the retry: the FIRST tap ends up playing

    await fire(video, 'canplay')
    expect(play).toHaveBeenCalledTimes(2) // a later rebuffer is not a tap
  })

  it('arms no retry when play() succeeds', async () => {
    const { video, play } = mount(() => Promise.resolve())

    await tap()
    await fire(video, 'canplay')
    expect(play).toHaveBeenCalledTimes(1)
  })

  it('never holds two listeners: a second rejected tap replaces the first retry', async () => {
    let call = 0
    const { video, play } = mount(() => {
      call += 1
      return call <= 2 ? rejected() : Promise.resolve()
    })

    await tap()
    await tap()
    expect(play).toHaveBeenCalledTimes(2) // two taps, both rejected

    await fire(video, 'canplay')
    expect(play).toHaveBeenCalledTimes(3) // ONE retry, not one per tap
  })

  it('leaves the pause path alone: a playing video is paused, and nothing is armed', async () => {
    const { video, play, pause } = mount(() => Promise.resolve(), { paused: false })

    await tap()
    expect(pause).toHaveBeenCalledTimes(1)
    expect(play).not.toHaveBeenCalled()

    await fire(video, 'canplay')
    expect(play).not.toHaveBeenCalled()
  })
})

describe('useVideoPlayer: an armed retry is disarmed when the intent to play ends', () => {
  it('does not fire for the next source: the <video> is reused across a version switch', async () => {
    const { video, play, rerender } = mount(rejected)

    await tap()
    expect(play).toHaveBeenCalledTimes(1) // armed for v1

    rerender(<Harness src={V2} />)
    await fire(video, 'canplay') // v2 is ready, and nobody tapped it
    expect(play).toHaveBeenCalledTimes(1)
  })

  it('does not fire after seekTo(time, pause=true): a comment timecode holds its frame', async () => {
    // comment-panel.tsx and progress-bar.tsx go through the store's seekTo. The
    // element is already paused here, so pause() fires no `pause` event and
    // only an explicit disarm can stop the retry.
    const { video, play, pause } = mount(rejected, { duration: 60 })

    await tap()
    await act(async () => { useReviewStore.getState().seekTo(12, true) })
    expect(pause).toHaveBeenCalledTimes(1)

    await fire(video, 'canplay') // the seek rebuffered, and data is back
    expect(play).toHaveBeenCalledTimes(1)
  })

  it('does not fire after a seekTo(time, pause=true) that was queued for metadata', async () => {
    const { video, play, pause } = mount(rejected) // duration is NaN: the seek is queued

    await tap()
    await act(async () => { useReviewStore.getState().seekTo(12, true) })
    expect(pause).not.toHaveBeenCalled()

    setDuration(video, 60)
    await fire(video, 'loadedmetadata')
    expect(pause).toHaveBeenCalledTimes(1)

    await fire(video, 'canplay')
    expect(play).toHaveBeenCalledTimes(1)
  })

  it('still fires after a seekTo without pause: the user asked to keep playing', async () => {
    const { video, play } = mount(rejectsOnce(), { duration: 60 })

    await tap()
    await act(async () => { useReviewStore.getState().seekTo(12) })

    await fire(video, 'canplay')
    expect(play).toHaveBeenCalledTimes(2)
  })

  it('does not fire after pause(): the handler behind pauseVideo() on the comment box', async () => {
    // video-player.tsx registers the hook's `pause` as the review provider's
    // pause handler, and comment-input.tsx reaches it through pauseVideo().
    const { video, play, pause } = mount(rejected)

    await tap()
    act(() => { player.pause() })
    expect(pause).toHaveBeenCalledTimes(1)

    await fire(video, 'canplay')
    expect(play).toHaveBeenCalledTimes(1)
  })

  it('is removed on unmount from the element it was armed on', async () => {
    // React nulls videoRef.current before a passive cleanup runs, so a teardown
    // that reads the ref finds nothing to disarm and leaks the listener.
    const { video, play, unmount } = mount(rejected)
    const add = vi.spyOn(video, 'addEventListener')
    const remove = vi.spyOn(video, 'removeEventListener')

    await tap()
    const armed = add.mock.calls.filter(
      ([type, , options]) => type === 'canplay' && typeof options === 'object' && options.once === true,
    )
    expect(armed).toHaveLength(1)

    unmount()
    expect(remove).toHaveBeenCalledWith('canplay', armed[0][1])

    video.dispatchEvent(new Event('canplay'))
    expect(play).toHaveBeenCalledTimes(1)
  })
})

describe('useVideoPlayer: a play() that is still pending cannot arm a retry once the intent is gone', () => {
  // Off iOS the promise does not reject at once: it stays pending while the
  // element buffers, and a pause() in that window rejects it with AbortError
  // AFTER the pause path has run. Disarming alone is too early to catch that.
  it('a deliberate pause while play() is pending arms nothing from its AbortError', async () => {
    const pending = pendingPlay()
    const { video, play } = mount(pending.impl, { duration: 60 })

    await tap()
    await act(async () => { useReviewStore.getState().seekTo(12, true) })
    await act(async () => { pending.abort() })

    await fire(video, 'canplay')
    expect(play).toHaveBeenCalledTimes(1)
  })

  it('a source change while play() is pending arms nothing for the next source', async () => {
    const pending = pendingPlay()
    const { video, play, rerender } = mount(pending.impl)

    await tap()
    rerender(<Harness src={V2} />)
    await act(async () => { pending.abort() })

    await fire(video, 'canplay')
    expect(play).toHaveBeenCalledTimes(1)
  })
})

describe('useVideoPlayer: the hls.js side of the first tap', () => {
  it('restarts loading when play() is rejected, and not when it succeeds', async () => {
    hlsMock.FakeHls.supported = true
    const { play } = mount(rejectsOnce())
    expect(hlsMock.instances).toHaveLength(1)

    await tap()
    expect(play).toHaveBeenCalledTimes(1)
    expect(hlsMock.instances[0].startLoad).toHaveBeenCalledTimes(1)

    await tap() // resolves this time
    expect(hlsMock.instances[0].startLoad).toHaveBeenCalledTimes(1)
  })

  it('leaves disableRemotePlayback to hls.js', () => {
    // hls.js sets it inside attachMedia() on the ManagedMediaSource path, where
    // it is needed. Setting it here as well turns remote playback off in every
    // desktop browser that takes the hls.js branch.
    hlsMock.FakeHls.supported = true
    const { video } = mount(() => Promise.resolve())
    expect(hlsMock.instances).toHaveLength(1)
    expect((video as HTMLVideoElement & { disableRemotePlayback?: boolean }).disableRemotePlayback).toBeUndefined()
  })
})
