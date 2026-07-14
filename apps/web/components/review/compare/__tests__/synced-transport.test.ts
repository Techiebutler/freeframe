import { describe, expect, it } from 'vitest'
import { applySideState, computeNextT, type SlavableVideo } from '../use-synced-transport'

function fakeVideo(currentTime = 0, paused = true): SlavableVideo & { played: number; pausedCalls: number } {
  const v = {
    currentTime,
    paused,
    played: 0,
    pausedCalls: 0,
    play() { this.paused = false; this.played += 1; return Promise.resolve() },
    pause() { this.paused = true; this.pausedCalls += 1 },
  }
  return v
}

const side = (offset: number, duration: number) => ({ offset, duration })

describe('applySideState', () => {
  it('holds first frame (paused at 0) before the offset', () => {
    const v = fakeVideo(3, false)
    applySideState(v, 1, side(2, 60), true)
    expect(v.paused).toBe(true)
    expect(v.currentTime).toBe(0)
  })

  it('freezes last frame (paused at duration) past the end', () => {
    const v = fakeVideo(59, false)
    applySideState(v, 63, side(2, 60), true)
    expect(v.paused).toBe(true)
    expect(v.currentTime).toBe(60)
  })

  it('plays and leaves currentTime alone when within drift threshold', () => {
    const v = fakeVideo(8.01, true)
    applySideState(v, 10, side(2, 60), true)   // expected local = 8
    expect(v.played).toBe(1)
    expect(v.currentTime).toBe(8.01)           // 10ms drift: no correction
  })

  it('issues a corrective seek when drifted beyond 50ms', () => {
    const v = fakeVideo(8.2, false)
    applySideState(v, 10, side(2, 60), true)
    expect(v.currentTime).toBe(8)              // snapped to expected local
  })

  it('pauses the element when the transport is paused', () => {
    const v = fakeVideo(8, false)
    applySideState(v, 10, side(2, 60), false)
    expect(v.paused).toBe(true)
  })
})

describe('computeNextT', () => {
  it('follows the master media clock (mediaTime + offset) when a master is active', () => {
    // Master at local 8s with a 2s offset → transport lands on 10, regardless
    // of prevT/dt (the audible video's own clock owns time — no drift, ever).
    expect(computeNextT(9.7, 0.016, { mediaTime: 8, offset: 2 }, 60)).toBe(10)
  })

  it('advances by wall dt when no master is active', () => {
    expect(computeNextT(10, 0.25, null, 60)).toBeCloseTo(10.25)
  })

  it('clamps at total (master past the end)', () => {
    expect(computeNextT(59, 0.016, { mediaTime: 61, offset: 2 }, 60)).toBe(60)
    expect(computeNextT(59.99, 0.5, null, 60)).toBe(60)
  })

  it('clamps at 0 (master reporting a pre-offset time)', () => {
    expect(computeNextT(1, 0.016, { mediaTime: 0.5, offset: -2 }, 60)).toBe(0)
  })

  it('waits when the master stalls (same mediaTime → same T)', () => {
    // Buffering audible side: currentTime stops, so T stops too — better than
    // running ahead on the wall clock and snapping back with an audible chop.
    expect(computeNextT(10, 0.5, { mediaTime: 8, offset: 2 }, 60)).toBe(10)
  })
})
