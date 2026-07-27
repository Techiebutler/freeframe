import { describe, expect, it } from 'vitest'
import {
  canCompare, driftedBeyond, frameStep, localTime, markerPosition,
  parseOffsetParam, sideEnded, sideNotStarted, tMax,
} from '../compare-time'

const side = (offset: number, duration: number) => ({ offset, duration })

describe('tMax', () => {
  it('spans the longer side including offsets', () => {
    expect(tMax(side(0, 60), side(2, 61))).toBe(63)
    expect(tMax(side(5, 10), side(0, 12))).toBe(15)
  })
})

describe('localTime', () => {
  it('maps transport time through the offset', () => {
    expect(localTime(10, side(2, 60))).toBe(8)
  })
  it('clamps before the offset to 0 (hold first frame)', () => {
    expect(localTime(1, side(2, 60))).toBe(0)
  })
  it('clamps past the end to duration (freeze last frame)', () => {
    expect(localTime(70, side(2, 60))).toBe(60)
  })
})

describe('side state', () => {
  it('not started before offset, ended after offset+duration', () => {
    expect(sideNotStarted(1.9, side(2, 60))).toBe(true)
    expect(sideNotStarted(2.0, side(2, 60))).toBe(false)
    expect(sideEnded(61.9, side(2, 60))).toBe(false)
    expect(sideEnded(62.0, side(2, 60))).toBe(true)
  })
})

describe('markerPosition', () => {
  it('places a comment at (tc + offset) / total', () => {
    expect(markerPosition(10, side(2, 60), 63)).toBeCloseTo(12 / 63)
  })
  it('clamps to [0, 1]', () => {
    expect(markerPosition(500, side(0, 60), 60)).toBe(1)
    expect(markerPosition(-5, side(0, 60), 60)).toBe(0)
  })
})

describe('frameStep', () => {
  it('is 1/fps for known rates', () => {
    expect(frameStep(25)).toBeCloseTo(0.04)
    expect(frameStep(23.976)).toBeCloseTo(1 / 23.976, 6)
  })
  it('falls back to 0.04 when fps missing or invalid', () => {
    expect(frameStep(null)).toBe(0.04)
    expect(frameStep(undefined)).toBe(0.04)
    expect(frameStep(0)).toBe(0.04)
  })
})

describe('driftedBeyond', () => {
  it('uses the 50ms default threshold, exclusive', () => {
    expect(driftedBeyond(10, 10.049)).toBe(false)
    expect(driftedBeyond(10, 10.051)).toBe(true)
    expect(driftedBeyond(10, 9.94)).toBe(true)
  })
})

describe('parseOffsetParam', () => {
  it('parses non-negative floats, else 0', () => {
    expect(parseOffsetParam('2.5')).toBe(2.5)
    expect(parseOffsetParam('-3')).toBe(0)
    expect(parseOffsetParam('abc')).toBe(0)
    expect(parseOffsetParam(null)).toBe(0)
  })
})

describe('canCompare', () => {
  const ready = { processing_status: 'ready' }
  const processing = { processing_status: 'processing' }
  it('requires video or image and >= 2 ready versions', () => {
    expect(canCompare('video', [ready, ready])).toBe(true)
    expect(canCompare('image', [ready, processing, ready])).toBe(true)
    expect(canCompare('video', [ready, processing])).toBe(false)
    expect(canCompare('audio', [ready, ready])).toBe(false)
    expect(canCompare('image_carousel', [ready, ready])).toBe(false)
  })
})
