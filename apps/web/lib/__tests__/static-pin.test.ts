import { describe, expect, it } from 'vitest'
import { byName, pinDrawing, pinOf, staticNotesFromMemo } from '../static-pin'

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

describe('staticNotesFromMemo', () => {
  const dot = (ms: number) => ({ k: 'dot' as const, points: [[0.5, 0.5]] as [number, number][], t: 0, offset_ms: ms })
  const views = [{ fileId: 'A', at: 0 }, { fileId: 'B', at: 4000 }, { fileId: 'A', at: 9000 }]
  it('sends each sentence to the ad on screen when it was said, merging neighbours', () => {
    const out = staticNotesFromMemo(views, [], 'x', [
      { start: 0.5, end: 1.5, text: 'Headline bigger.' }, { start: 2, end: 3, text: 'Logo too.' },
      { start: 5, end: 6, text: 'Swap the photo.' }, { start: 9.5, end: 10, text: 'Back here.' },
    ])
    expect(out.map(n => [n.fileId, n.text])).toEqual([['A', 'Headline bigger. Logo too.'], ['B', 'Swap the photo.'], ['A', 'Back here.']])
  })
  it('puts a drawing on its own ad, with the sentence nearest in time', () => {
    const out = staticNotesFromMemo(views, [{ fileId: 'A', mark: dot(9200) }, { fileId: 'B', mark: dot(3000) }], 'x', [
      { start: 1, end: 2, text: 'One.' }, { start: 5, end: 6, text: 'Two.' }, { start: 9.5, end: 10, text: 'Three.' },
    ])
    expect(out.map(n => n.marks.map(m => m.offset_ms))).toEqual([[], [3000], [9200]])
  })
  it('keeps a drawing on an ad nobody spoke about as its own note', () => {
    const out = staticNotesFromMemo(views, [{ fileId: 'B', mark: dot(5000) }], 'x', [{ start: 1, end: 2, text: 'Only A.' }])
    expect(out).toMatchObject([{ fileId: 'A', text: 'Only A.' }, { fileId: 'B', text: '', marks: [{ offset_ms: 5000 }] }])
  })
  it('without segments, the whole text goes to the first ad', () => {
    expect(staticNotesFromMemo(views, [], ' All of it ', [])).toMatchObject([{ fileId: 'A', text: 'All of it' }])
  })
})
