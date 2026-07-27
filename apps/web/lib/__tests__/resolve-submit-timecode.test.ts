import { describe, expect, it } from 'vitest'
import { resolveSubmitTimecode } from '../resolve-submit-timecode'

describe('resolveSubmitTimecode', () => {
  it('attached at playhead 0 includes the timecode (0, not undefined)', () => {
    expect(
      resolveSubmitTimecode({
        hasTimecode: true,
        timecodeAttached: true,
        hasAnnotation: false,
        playheadTime: 0,
      }),
    ).toBe(0)
  })

  it('attached at a non-zero playhead includes that timecode', () => {
    expect(
      resolveSubmitTimecode({
        hasTimecode: true,
        timecodeAttached: true,
        hasAnnotation: false,
        playheadTime: 42.5,
      }),
    ).toBe(42.5)
  })

  it('detached with no drawing omits the timecode', () => {
    expect(
      resolveSubmitTimecode({
        hasTimecode: true,
        timecodeAttached: false,
        hasAnnotation: false,
        playheadTime: 12,
      }),
    ).toBeUndefined()
  })

  it('detached WITH a drawing force-attaches the timecode (frame-anchored)', () => {
    expect(
      resolveSubmitTimecode({
        hasTimecode: true,
        timecodeAttached: false,
        hasAnnotation: true,
        playheadTime: 12,
      }),
    ).toBe(12)
  })

  it('detached WITH a drawing at playhead 0 still attaches 0', () => {
    expect(
      resolveSubmitTimecode({
        hasTimecode: true,
        timecodeAttached: false,
        hasAnnotation: true,
        playheadTime: 0,
      }),
    ).toBe(0)
  })

  it('non-timed media (image) never carries a timecode, even attached', () => {
    expect(
      resolveSubmitTimecode({
        hasTimecode: false,
        timecodeAttached: true,
        hasAnnotation: true,
        playheadTime: 5,
      }),
    ).toBeUndefined()
  })
})
