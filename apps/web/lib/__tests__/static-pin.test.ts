import { describe, expect, it } from 'vitest'
import { byName, pinDrawing, pinOf } from '../static-pin'

describe('static pins', () => {
  it('round-trips a point through the ink format video notes already use', () => {
    const d = pinDrawing(0.25, 0.75)
    expect(d.format).toBe('ink.v1')
    expect(pinOf(d)).toEqual([0.25, 0.75])
  })
  it('keeps a pin inside the picture', () => {
    expect(pinOf(pinDrawing(-1, 2))).toEqual([0, 1])
  })
  it('reads no pin from a note without a drawing or from fabric data', () => {
    expect(pinOf(null)).toBeNull()
    expect(pinOf({ objects: [] })).toBeNull()
  })
  it('sorts file names naturally', () => {
    expect([{ name: 'Ad 10' }, { name: 'Ad 2' }, { name: 'Ad 1' }].sort(byName).map(f => f.name)).toEqual(['Ad 1', 'Ad 2', 'Ad 10'])
  })
})
