import { describe, expect, it } from 'vitest'
import { applySideState, computeNextT, isMasterActive, type SlavableVideo } from '../use-synced-transport'
import { frameStep } from '@/lib/compare-time'

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

  it('leaves a paused video within one frame of expected ALONE (no re-seek thrash)', () => {
    // A paused seek snaps currentTime to the nearest decodable frame, never
    // exactly `expected`; with a sub-frame threshold that would re-seek every
    // rAF forever. A ~half-frame offset (20ms @ ~30fps) must not correct.
    const v = fakeVideo(8.02, true) // paused, expected local = 8
    applySideState(v, 10, side(2, 60), false, frameStep(30))
    expect(v.currentTime).toBe(8.02) // untouched
  })

  it('still snaps a paused video that is more than one frame off', () => {
    const v = fakeVideo(8.2, true) // 200ms off, well past one frame
    applySideState(v, 10, side(2, 60), false, frameStep(30))
    expect(v.currentTime).toBe(8)
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

describe('isMasterActive', () => {
  const live = { ended: false, error: null }

  it('true for a live element inside its offset window', () => {
    expect(isMasterActive(live, 10, side(2, 60))).toBe(true)
  })

  it('false when the element has ended (real HLS end can precede the recorded end)', () => {
    // Recorded duration routinely overshoots real duration by milliseconds:
    // an ended master would freeze T inside the recorded window, and play()
    // on an ended element restarts from 0 → freeze/replay chatter.
    expect(isMasterActive({ ended: true, error: null }, 10, side(2, 60))).toBe(false)
  })

  it('false when the element carries a media error', () => {
    expect(isMasterActive({ ended: false, error: { code: 2 } }, 10, side(2, 60))).toBe(false)
  })

  it('false before the offset window', () => {
    expect(isMasterActive(live, 1, side(2, 60))).toBe(false)
  })

  it('false past the recorded end', () => {
    expect(isMasterActive(live, 63, side(2, 60))).toBe(false)
  })

  it('false without an element', () => {
    expect(isMasterActive(null, 10, side(2, 60))).toBe(false)
  })
})
