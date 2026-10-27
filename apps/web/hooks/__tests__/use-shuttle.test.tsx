import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as React from 'react'
import { render, act } from '@testing-library/react'
import { useShuttle, nextShuttleRate, type UseShuttleReturn } from '../use-shuttle'

/**
 * Drives the real shuttle hook over a stand-in player. playbackRate is React
 * state, as in the real player, and the stand-in element flips `paused` and
 * fires `play` and `pause` the way a media element does, so each press sees
 * what the previous one did.
 *
 * Reverse runs on requestAnimationFrame, which is replaced with a queue that
 * `frame(ms)` flushes at a chosen timestamp, so a test controls exactly how
 * much wall-clock time each step covers.
 */

type FakeVideo = EventTarget & { currentTime: number; seeking: boolean; paused: boolean }

let shuttle: UseShuttleReturn
let video: FakeVideo
let state: { isPlaying: boolean; playbackRate: number }
const calls = { play: vi.fn(), pause: vi.fn(), togglePlay: vi.fn() }

function Harness() {
  const [playbackRate, setPlaybackRate] = React.useState(1)
  state = { isPlaying: !video.paused, playbackRate }
  const videoRef = React.useRef<HTMLVideoElement | null>(video as unknown as HTMLVideoElement)
  shuttle = useShuttle({
    videoRef,
    playbackRate,
    play: React.useCallback(() => { calls.play(); setPaused(false) }, []),
    pause: React.useCallback(() => { calls.pause(); setPaused(true) }, []),
    togglePlay: React.useCallback(() => { calls.togglePlay(); setPaused(!video.paused) }, []),
    seek: React.useCallback((t: number) => { video.currentTime = t }, []),
    setPlaybackRate,
  })
  return null
}

function setPaused(paused: boolean) {
  if (video.paused === paused) return
  video.paused = paused
  video.dispatchEvent(new Event(paused ? 'pause' : 'play'))
}

let queue: FrameRequestCallback[] = []
let now = 0
function frame(ms: number) {
  now += ms
  const due = queue
  queue = []
  act(() => { due.forEach((cb) => cb(now)) })
}

beforeEach(() => {
  video = Object.assign(new EventTarget(), { currentTime: 60, seeking: false, paused: true })
  queue = []
  now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { queue.push(cb); return queue.length })
  vi.stubGlobal('cancelAnimationFrame', () => { queue = [] })
  render(<Harness />)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Object.values(calls).forEach((c) => c.mockClear())
})

const press = (fn: () => void) => act(() => fn())
// isPlaying is read off the element at render, so re-render to see it.
const current = () => ({ isPlaying: !video.paused, playbackRate: state.playbackRate })

describe('nextShuttleRate', () => {
  it('steps 1, 2, 4, 8 and holds at 8', () => {
    expect([1, 2, 4, 8].map(nextShuttleRate)).toEqual([2, 4, 8, 8])
  })

  it('goes to the next step above a speed picked from the menu', () => {
    expect(nextShuttleRate(1.5)).toBe(2)
    expect(nextShuttleRate(0.5)).toBe(1)
  })
})

describe('L', () => {
  it('plays forward at 1x from paused, then speeds up on each press', () => {
    press(() => shuttle.shuttleForward())
    expect(calls.play).toHaveBeenCalledOnce()
    expect(current()).toEqual({ isPlaying: true, playbackRate: 1 })

    const rates = [2, 4, 8, 8].map(() => {
      press(() => shuttle.shuttleForward())
      return state.playbackRate
    })
    expect(rates).toEqual([2, 4, 8, 8])
  })

  it('speeds up on a second quick press, before the player re-renders as playing', () => {
    act(() => {
      shuttle.shuttleForward()
      shuttle.shuttleForward()
    })
    expect(current()).toEqual({ isPlaying: true, playbackRate: 2 })
  })

  it('drops back to 1x however playback stops, such as the end of the clip', () => {
    press(() => shuttle.shuttleForward())
    press(() => shuttle.shuttleForward())
    press(() => shuttle.shuttleForward()) // 4x
    act(() => setPaused(true))
    expect(current()).toEqual({ isPlaying: false, playbackRate: 1 })
  })

  it('switches reverse to forward at 1x', () => {
    press(() => shuttle.shuttleReverse())
    press(() => shuttle.shuttleReverse())
    press(() => shuttle.shuttleForward())
    expect(shuttle.reverseRate).toBe(0)
    expect(current()).toEqual({ isPlaying: true, playbackRate: 1 })
  })
})

describe('J', () => {
  it('plays in reverse at 1x, then speeds up on each press', () => {
    press(() => shuttle.shuttleReverse())
    expect(shuttle.reverseRate).toBe(1)
    const rates = [2, 4, 8, 8].map(() => {
      press(() => shuttle.shuttleReverse())
      return shuttle.reverseRate
    })
    expect(rates).toEqual([2, 4, 8, 8])
  })

  it('walks the playhead back at the shuttle speed', () => {
    press(() => shuttle.shuttleReverse())
    press(() => shuttle.shuttleReverse()) // 2x
    frame(500)
    expect(video.currentTime).toBeCloseTo(59)
    frame(500)
    expect(video.currentTime).toBeCloseTo(58)
  })

  it('carries time over a slow seek instead of losing it', () => {
    press(() => shuttle.shuttleReverse())
    video.seeking = true
    frame(250)
    expect(video.currentTime).toBe(60)
    video.seeking = false
    frame(250)
    expect(video.currentTime).toBeCloseTo(59.5)
  })

  it('pauses forward playback and resets an L speed-up', () => {
    press(() => shuttle.shuttleForward())
    press(() => shuttle.shuttleForward()) // 2x
    press(() => shuttle.shuttleReverse())
    expect(calls.pause).toHaveBeenCalledOnce()
    expect(current()).toEqual({ isPlaying: false, playbackRate: 1 })
    expect(shuttle.reverseRate).toBe(1)
  })

  it('stops at the start of the clip', () => {
    video.currentTime = 0.2
    press(() => shuttle.shuttleReverse())
    frame(500)
    expect(video.currentTime).toBe(0)
    expect(shuttle.reverseRate).toBe(0)
    expect(queue).toHaveLength(0)
  })

  it('ends when something else starts forward playback', () => {
    press(() => shuttle.shuttleReverse())
    act(() => { video.dispatchEvent(new Event('play')) })
    expect(shuttle.reverseRate).toBe(0)
  })
})

describe('pause', () => {
  it('stops reverse where it is, with no step after', () => {
    press(() => shuttle.shuttleReverse())
    frame(500)
    const at = video.currentTime
    press(() => shuttle.pause())
    frame(500)
    expect(shuttle.reverseRate).toBe(0)
    expect(video.currentTime).toBe(at)
  })
})

describe('K', () => {
  it('stops reverse without starting forward playback', () => {
    press(() => shuttle.shuttleReverse())
    press(() => shuttle.togglePlay())
    expect(shuttle.reverseRate).toBe(0)
    expect(calls.togglePlay).not.toHaveBeenCalled()
    expect(current().isPlaying).toBe(false)
    frame(500)
    expect(video.currentTime).toBe(60)
  })

  it('stops an L speed-up and drops back to 1x', () => {
    press(() => shuttle.shuttleForward())
    press(() => shuttle.shuttleForward())
    press(() => shuttle.shuttleForward()) // 4x
    press(() => shuttle.togglePlay())
    expect(current()).toEqual({ isPlaying: false, playbackRate: 1 })
  })

  it('keeps a speed picked from the menu', () => {
    press(() => shuttle.setPlaybackRate(1.5))
    press(() => shuttle.togglePlay())
    press(() => shuttle.togglePlay())
    expect(calls.togglePlay).toHaveBeenCalledTimes(2)
    expect(state.playbackRate).toBe(1.5)
  })
})
