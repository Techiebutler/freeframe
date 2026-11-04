import { describe, expect, it } from 'vitest'
import { containedRect, DOT_PX, INK_MS, buildDrawingData, classifyMark, clamp01, normalizePoint, isInk } from '../ink'

describe('ink', () => {
  it('normalises to the visible frame, origin top-left, clamped to 0..1', () => {
    const rect = { left: 100, top: 50, width: 200, height: 400 }
    expect(normalizePoint(rect, 200, 250)).toEqual([0.5, 0.5])
    expect(normalizePoint(rect, 100, 50)).toEqual([0, 0])
    expect(normalizePoint(rect, 9999, -5)).toEqual([1, 0])
    expect(clamp01(-1)).toBe(0)
  })
  it('a tap under DOT_PX is a dot, a drag a stroke', () => {
    expect(classifyMark(DOT_PX - 1)).toBe('dot')
    expect(classifyMark(DOT_PX)).toBe('stroke')
  })
  it('keeps the first mark offset and ms precision on t', () => {
    const d = buildDrawingData([
      { k: 'stroke', points: [[0, 0], [1, 1]], t: 3.14159, offset_ms: 1200 },
      { k: 'dot', points: [[0.5, 0.5]], t: 4, offset_ms: 2500 },
    ])
    expect(d).toMatchObject({ format: 'ink.v1', mark_offset_ms: 1200 })
    expect((d!.marks as { t: number }[])[0].t).toBe(3.142)
    expect(isInk(d)).toBe(true)
  })
  it('is null without marks and fabric data is not ink', () => {
    expect(buildDrawingData([])).toBeNull()
    expect(isInk({ objects: [] })).toBe(false)
    expect(INK_MS).toBe(1200)
  })
})

describe('containedRect + normalizePoint (9:16 letterboxed in a 16:9 box)', () => {
  const box = containedRect(1600, 900, 1080, 1920)
  it('centres the picture and excludes the bars', () => {
    expect(box.height).toBe(900)
    expect(box.width).toBeCloseTo(506.25)
    expect(box.left).toBeCloseTo(546.875)
    expect(box.top).toBe(0)
  })
  it('maps picture corners and centre to 0..1, bars clamp', () => {
    expect(normalizePoint(box, 546.875, 0)).toEqual([0, 0])
    const c = normalizePoint(box, 800, 450)
    expect(c[0]).toBeCloseTo(0.5)
    expect(c[1]).toBeCloseTo(0.5)
    expect(normalizePoint(box, 10, 450)[0]).toBe(0)
    expect(normalizePoint(box, 1590, 450)[0]).toBe(1)
  })
  it('fills the box when the video size is unknown', () => {
    expect(containedRect(300, 200, 0, 0)).toEqual({ left: 0, top: 0, width: 300, height: 200 })
  })
})
