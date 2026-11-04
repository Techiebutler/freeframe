import { describe, expect, it } from 'vitest'
import { dotsLit, pushLevel, rmsLevel, METER_COLUMNS } from '../level-meter'

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
})
