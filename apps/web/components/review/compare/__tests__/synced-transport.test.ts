import { describe, expect, it, vi } from 'vitest'
import { applySideState, type SlavableVideo } from '../use-synced-transport'

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
