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

import { smoothPath, thinPoints, taperChunks, STROKE_WIDTHS } from '../ink'

describe('smoothing', () => {
  it('thins points that sit closer than the minimum distance but keeps both ends', () => {
    const out = thinPoints([[0, 0], [0.001, 0], [0.002, 0], [0.5, 0], [0.5005, 0], [1, 0]], 0.01)
    expect(out[0]).toEqual([0, 0])
    expect(out[out.length - 1]).toEqual([1, 0])
    expect(out).toHaveLength(3)
  })
  it('draws a quadratic curve through the midpoints, not a polyline', () => {
    const d = smoothPath([[0, 0], [0.4, 0.4], [0.8, 0]])
    expect(d.startsWith('M0,0')).toBe(true)
    expect(d).toContain('Q0.4,0.4 0.6,0.2')
    expect(d.endsWith('L0.8,0')).toBe(true)
    expect(d).not.toMatch(/^M[^Q]*L[^Q]*L/)
  })
  it('handles one and two points', () => {
    expect(smoothPath([[0.1, 0.1]])).toBe('M0.1,0.1L0.1,0.1')
    expect(smoothPath([[0, 0], [1, 1]])).toBe('M0,0L1,1')
  })
  it('splits a stroke into chunks that taper from thick to thinner and join on midpoints', () => {
    const pts: [number, number][] = Array.from({ length: 21 }, (_, i) => [i / 20, 0.5])
    const chunks = taperChunks(pts)
    expect(chunks.map(c => c.width)).toEqual(STROKE_WIDTHS)
    expect(STROKE_WIDTHS[0]).toBeGreaterThan(STROKE_WIDTHS[STROKE_WIDTHS.length - 1])
    expect(chunks[0]).toMatchObject({ trimStart: false, trimEnd: true })
    expect(chunks[0].points[0]).toEqual(pts[0])
    expect(chunks.at(-1)).toMatchObject({ trimStart: true, trimEnd: false })
    expect(chunks.at(-1)!.points.at(-1)).toEqual(pts.at(-1))
    // a chunk ends where the next one starts: both on the midpoint of the same two raw points
    const end0 = smoothPath(chunks[0].points, chunks[0]).match(/ ([\d.]+),([\d.]+)$/)!
    const start1 = smoothPath(chunks[1].points, chunks[1]).match(/^M([\d.]+),([\d.]+)/)!
    expect([end0[1], end0[2]]).toEqual([start1[1], start1[2]])
  })
  it('a very short stroke is a single chunk at the starting width', () => {
    expect(taperChunks([[0, 0], [0.01, 0]])).toEqual([{ points: [[0, 0], [0.01, 0]], width: STROKE_WIDTHS[0], trimStart: false, trimEnd: false }])
  })
})

import { markDuration, visibleMarks, splitDeictic } from '../ink'

describe('timed replay', () => {
  const stroke = { k: 'stroke' as const, points: [[0, 0], [0.2, 0.2], [0.4, 0.4], [0.6, 0.6]] as [number, number][], t: 3, offset_ms: 1000, times: [0, 100, 300, 600] }
  it('knows how long a stroke took to draw', () => {
    expect(markDuration(stroke)).toBe(600)
    expect(markDuration({ ...stroke, times: undefined })).toBe(0)
  })
  it('reveals points at their original timing', () => {
    expect(visibleMarks([stroke], 0)).toEqual([])
    expect(visibleMarks([stroke], 150)[0].points).toHaveLength(2)
    expect(visibleMarks([stroke], 350)[0].points).toHaveLength(3)
    expect(visibleMarks([stroke], 5000)[0].points).toHaveLength(4)
  })
  it('later marks start after the gap they had in the recording', () => {
    const second = { ...stroke, offset_ms: 1500 }
    expect(visibleMarks([stroke, second], 300)).toHaveLength(1)
    expect(visibleMarks([stroke, second], 700)).toHaveLength(2)
  })
  it('a mark without times is simply there', () => {
    expect(visibleMarks([{ ...stroke, times: undefined }], 0)).toHaveLength(1)
  })
})

describe('splitDeictic', () => {
  it('marks pointing words in English and German, keeping the text intact', () => {
    const parts = splitDeictic('Cut this part, hier ist das zu lang. Thanks.')
    expect(parts.map(p => p.text).join('')).toBe('Cut this part, hier ist das zu lang. Thanks.')
    expect(parts.filter(p => p.deictic).map(p => p.text)).toEqual(['this', 'hier', 'das'])
  })
  it('does not match inside other words', () => {
    expect(splitDeictic('Thatcher said thisle hereditary').some(p => p.deictic)).toBe(false)
  })
  it('is case-insensitive and handles empty text', () => {
    expect(splitDeictic('Here!').filter(p => p.deictic).map(p => p.text)).toEqual(['Here'])
    expect(splitDeictic('')).toEqual([])
  })
})
