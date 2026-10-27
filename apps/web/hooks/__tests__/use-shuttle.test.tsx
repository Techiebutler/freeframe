import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as React from 'react'
import { render, act } from '@testing-library/react'
import { useShuttle, nextShuttleRate, type UseShuttleReturn } from '../use-shuttle'

/**
 * Drives the real shuttle hook over a stand-in player. The player keeps
 * isPlaying and playbackRate in React state, as the real one does, so each
 * press sees what the previous one did.
 *
 * Reverse runs on requestAnimationFrame, which is replaced with a queue that
 * `frame(ms)` flushes at a chosen timestamp, so a test controls exactly how
 * much wall-clock time each step covers.
 */

type FakeVideo = EventTarget & { currentTime: number; seeking: boolean }

let shuttle: UseShuttleReturn
let video: FakeVideo
let state: { isPlaying: boolean; playbackRate: number }
const calls = { play: vi.fn(), pause: vi.fn(), togglePlay: vi.fn() }

function Harness() {
  const [isPlaying, setIsPlaying] = React.useState(false)
  const [playbackRate, setPlaybackRate] = React.useState(1)
  state = { isPlaying, playbackRate }
  const videoRef = React.useRef<HTMLVideoElement | null>(video as unknown as HTMLVideoElement)
  shuttle = useShuttle({
    videoRef,
    isPlaying,
    playbackRate,
    play: React.useCallback(() => { calls.play(); setIsPlaying(true); video.dispatchEvent(new Event('play')) }, []),
    pause: React.useCallback(() => { calls.pause(); setIsPlaying(false) }, []),
    togglePlay: React.useCallback(() => { calls.togglePlay(); setIsPlaying((p) => !p) }, []),
    seek: React.useCallback((t: number) => { video.currentTime = t }, []),
    setPlaybackRate,
  })
  return null
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
  video = Object.assign(new EventTarget(), { currentTime: 60, seeking: false })
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
    expect(state).toEqual({ isPlaying: true, playbackRate: 1 })

    const rates = [2, 4, 8, 8].map(() => {
      press(() => shuttle.shuttleForward())
      return state.playbackRate
    })
    expect(rates).toEqual([2, 4, 8, 8])
  })

  it('switches reverse to forward at 1x', () => {
    press(() => shuttle.shuttleReverse())
    press(() => shuttle.shuttleReverse())
    press(() => shuttle.shuttleForward())
    expect(shuttle.reverseRate).toBe(0)
    expect(state).toEqual({ isPlaying: true, playbackRate: 1 })
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
    expect(state).toEqual({ isPlaying: false, playbackRate: 1 })
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

describe('K', () => {
  it('stops reverse without starting forward playback', () => {
    press(() => shuttle.shuttleReverse())
    press(() => shuttle.togglePlay())
    expect(shuttle.reverseRate).toBe(0)
    expect(calls.togglePlay).not.toHaveBeenCalled()
    expect(state.isPlaying).toBe(false)
    frame(500)
    expect(video.currentTime).toBe(60)
  })

  it('stops an L speed-up and drops back to 1x', () => {
    press(() => shuttle.shuttleForward())
    press(() => shuttle.shuttleForward())
    press(() => shuttle.shuttleForward()) // 4x
    press(() => shuttle.togglePlay())
    expect(state).toEqual({ isPlaying: false, playbackRate: 1 })
  })

  it('keeps a speed picked from the menu', () => {
    press(() => shuttle.setPlaybackRate(1.5))
    press(() => shuttle.togglePlay())
    press(() => shuttle.togglePlay())
    expect(calls.togglePlay).toHaveBeenCalledTimes(2)
    expect(state.playbackRate).toBe(1.5)
  })
})
