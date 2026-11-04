import { describe, expect, it } from 'vitest'
import { columnRows, dotsLit, pushLevel, rmsLevel, METER_COLUMNS } from '../level-meter'

describe('level meter maths', () => {
  it('turns audio samples into a 0..1 level, silence being 0', () => {
    expect(rmsLevel(new Uint8Array([128, 128, 128, 128]))).toBe(0)
    expect(rmsLevel(new Uint8Array([255, 0, 255, 0]))).toBeGreaterThan(0.9)
    expect(rmsLevel(new Uint8Array([]))).toBe(0)
  })
  it('lights more dots for louder sound, at least one while recording', () => {
    expect(dotsLit(0, 5)).toBe(1)
    expect(dotsLit(0.5, 5)).toBe(3)
    expect(dotsLit(1, 5)).toBe(5)
    expect(dotsLit(7, 5)).toBe(5)
  })
  it('the newest level enters on the right and old ones run off to the left', () => {
    let h: number[] = []
    for (let i = 1; i <= METER_COLUMNS + 3; i++) h = pushLevel(h, i / 100)
    expect(h).toHaveLength(METER_COLUMNS)
    expect(h[h.length - 1]).toBeCloseTo((METER_COLUMNS + 3) / 100)
    expect(h[0]).toBeCloseTo(4 / 100)
  })

  it('grows symmetrically from the centre line: silence is one centre dot', () => {
    expect(columnRows(0, 7)).toEqual([false, false, false, true, false, false, false])
    expect(columnRows(0.34, 7)).toEqual([false, false, true, true, true, false, false])
    expect(columnRows(1, 7)).toEqual([true, true, true, true, true, true, true])
  })
  it('is always symmetric, odd in height, and clamps out-of-range levels', () => {
    for (const lv of [0, 0.1, 0.5, 0.9, 1, 3, -1]) {
      const r = columnRows(lv, 7)
      expect(r).toHaveLength(7)
      expect(r).toEqual([...r].reverse())
      expect(r[3]).toBe(true)
    }
    expect(columnRows(0.5, 6)).toHaveLength(7)
  })
})

import { dbLevel, dotStyle, rmsFloat, smoothLevel, ATTACK_MS, RELEASE_MS } from '../level-meter'

describe('perceptual level (dBFS)', () => {
  it('maps -50 dB .. -14 dB to 0 .. 1', () => {
    expect(dbLevel(0)).toBe(0)
    expect(dbLevel(10 ** (-60 / 20))).toBe(0)
    expect(dbLevel(10 ** (-50 / 20))).toBeCloseTo(0, 5)
    expect(dbLevel(10 ** (-14 / 20))).toBeCloseTo(1, 5)
    expect(dbLevel(1)).toBe(1)
    expect(dbLevel(10 ** (-32 / 20))).toBeCloseTo(0.5, 2)
  })
  it('normal speech (RMS 0.05 to 0.2) fills 60 to 90% and more', () => {
    expect(dbLevel(0.05)).toBeGreaterThan(0.6)
    expect(dbLevel(0.1)).toBeGreaterThan(0.75)
    expect(dbLevel(0.2)).toBe(1)
  })
  it('takes the RMS of float samples', () => {
    expect(rmsFloat(new Float32Array([0, 0, 0]))).toBe(0)
    expect(rmsFloat(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5, 5)
    expect(rmsFloat(new Float32Array([]))).toBe(0)
  })
})

describe('attack and release', () => {
  it('attacks fast: most of a jump arrives within one attack time', () => {
    expect(smoothLevel(0, 1, ATTACK_MS)).toBeGreaterThan(0.6)
  })
  it('releases slowly: after one release time it has only dropped about two thirds', () => {
    const v = smoothLevel(1, 0, RELEASE_MS)
    expect(v).toBeGreaterThan(0.3); expect(v).toBeLessThan(0.45)
  })
  it('a syllable punches up quicker than it dies away', () => {
    expect(smoothLevel(0, 1, 50)).toBeGreaterThan(1 - smoothLevel(1, 0, 50))
  })
  it('does nothing without elapsed time and never leaves 0..1', () => {
    expect(smoothLevel(0.3, 1, 0)).toBe(0.3)
    expect(smoothLevel(0.5, 5, 1000)).toBeLessThanOrEqual(1)
    expect(smoothLevel(0.5, -5, 1000)).toBeGreaterThanOrEqual(0)
  })
})

describe('dot look', () => {
  it('quiet is small and dim, loud is full size and bright', () => {
    const quiet = dotStyle(0.05, 3, 7); const loud = dotStyle(0.9, 3, 7)
    expect(quiet.scale).toBeLessThan(loud.scale)
    expect(quiet.opacity).toBeLessThan(loud.opacity)
    expect(loud.scale).toBeLessThanOrEqual(1)
  })
  it('the centre dot is always on; outer dots only appear with level', () => {
    expect(dotStyle(0, 3, 7).on).toBe(true)
    expect(dotStyle(0, 0, 7).on).toBe(false)
    expect(dotStyle(1, 0, 7).on).toBe(true)
  })
  it('is symmetric around the centre', () => {
    for (const lv of [0.2, 0.6, 1]) expect(dotStyle(lv, 1, 7)).toEqual(dotStyle(lv, 5, 7))
  })
  it('only peaks turn brand orange', () => {
    expect(dotStyle(0.6, 3, 7).peak).toBe(false)
    expect(dotStyle(0.95, 3, 7).peak).toBe(true)
    expect(dotStyle(1, 0, 7).peak).toBe(true)
  })
})
