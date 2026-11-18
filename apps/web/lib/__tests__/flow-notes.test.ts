import { describe, expect, it } from 'vitest'
import { videoTimeAt, type TimelinePoint } from '../rec-timeline'
import { dictationPayload, notesFromDictation, notesReducer, sendable, sendBlocked, type FlowNote } from '../flow-notes'

const blob = new Blob(['x'])
const add = (s: FlowNote[], id: string, t: number) => notesReducer(s, { type: 'add', id, t })

describe('flow notes', () => {
  it('adds notes in timeline order, starting as recording', () => {
    const s = add(add([], 'b', 9), 'a', 3)
    expect(s.map(n => n.id)).toEqual(['a', 'b'])
    expect(s[0].status).toBe('recording')
  })
  it('goes recording -> transcribing -> ready and drops the audio', () => {
    let s = add([], 'a', 3)
    s = notesReducer(s, { type: 'transcribing', id: 'a', audio: blob })
    expect(s[0]).toMatchObject({ status: 'transcribing', audio: blob })
    s = notesReducer(s, { type: 'done', id: 'a', text: 'Hook too slow' })
    expect(s[0]).toMatchObject({ status: 'ready', text: 'Hook too slow' })
    expect(s[0].audio).toBeUndefined()
  })
  it('keeps the audio when transcription fails so Try again still works', () => {
    let s = add([], 'a', 3)
    s = notesReducer(s, { type: 'transcribing', id: 'a', audio: blob })
    s = notesReducer(s, { type: 'failed', id: 'a' })
    expect(s[0]).toMatchObject({ status: 'failed', audio: blob })
  })
  it('a typed note becomes saveable only once typing is committed', () => {
    let s = notesReducer(add([], 'a', 1), { type: 'failed', id: 'a' })
    expect(sendBlocked(s)).toBe(true)
    s = notesReducer(s, { type: 'edit', id: 'a', text: 'Cut earlier' })
    expect(sendable(s)).toHaveLength(0)
    s = notesReducer(s, { type: 'commit', id: 'a' })
    expect(sendBlocked(s)).toBe(false)
    expect(sendable(s)).toHaveLength(1)
  })
  it('committing an empty note does nothing', () => {
    const s = notesReducer(notesReducer(add([], 'a', 1), { type: 'failed', id: 'a' }), { type: 'commit', id: 'a' })
    expect(s[0].status).toBe('failed')
  })
  it('blocks sending while recording or transcribing', () => {
    let s = add([], 'a', 1)
    expect(sendBlocked(s)).toBe(true)
    s = notesReducer(s, { type: 'transcribing', id: 'a', audio: blob })
    expect(sendBlocked(s)).toBe(true)
  })
  it('keeps the ink made while recording on the note', () => {
    const m = { k: 'dot' as const, points: [[0, 0]] as [number, number][], t: 1, offset_ms: 10 }
    const s = notesReducer(add([], 'a', 1), { type: 'marks', id: 'a', marks: [m] })
    expect(s[0].marks).toEqual([m])
  })
  it('removes and clears', () => {
    const s = add(add([], 'a', 1), 'b', 2)
    expect(notesReducer(s, { type: 'remove', id: 'a' }).map(n => n.id)).toEqual(['b'])
    expect(notesReducer(s, { type: 'clear' })).toEqual([])
  })
})

describe('notesFromDictation', () => {
  const mk = (offset_ms: number) => ({ k: 'stroke' as const, points: [[0, 0]] as [number, number][], t: 0, offset_ms })
  const play = (base: number) => (ms: number) => base + ms / 1000
  it('no segments: one note at the start with all ink', () => {
    const [n] = notesFromDictation(play(5), ' Hook slow ', [], [mk(100)])
    expect(n).toMatchObject({ t: 5, text: 'Hook slow' })
    expect(n.marks[0]).toMatchObject({ offset_ms: 100, t: 5.1 })
  })
  it('one note per segment, ink goes to the sentence being said', () => {
    const parts = notesFromDictation(play(10), 'x', [{ start: 0, end: 2, text: 'One.' }, { start: 3.5, end: 5, text: 'Two.' }], [mk(500), mk(3400), mk(3600), mk(9000)])
    expect(parts.map(p => [p.t, p.text, p.marks.map(m => m.offset_ms)])).toEqual([[10, 'One.', [500, 3400]], [13.5, 'Two.', [3600, 9000]]])
  })
  it('a pause mid-recording holds the video time for later sentences and ink', () => {
    const tl: TimelinePoint[] = [{ rec_ms: 0, video_t: 10, playing: true, rate: 1 }, { rec_ms: 2000, video_t: 12, playing: false, rate: 1 }]
    const parts = notesFromDictation(ms => videoTimeAt(tl, ms), 'x', [{ start: 0.5, end: 1.5, text: 'Early.' }, { start: 4, end: 5, text: 'Late.' }], [mk(4500)])
    expect(parts[0].t).toBe(10.5)
    expect(parts[1].t).toBe(12)
    expect(parts[1].marks[0].t).toBe(12)
  })
  it('a seek mid-recording and a 1.5x rate are honoured', () => {
    const tl: TimelinePoint[] = [{ rec_ms: 0, video_t: 0, playing: true, rate: 1.5 }, { rec_ms: 2000, video_t: 40, playing: true, rate: 1.5 }]
    const parts = notesFromDictation(ms => videoTimeAt(tl, ms), 'x', [{ start: 1, end: 2, text: 'A.' }, { start: 4, end: 5, text: 'B.' }], [])
    expect(parts.map(p => p.t)).toEqual([1.5, 43])
  })
  it('ink before the first segment starts joins the first note; blank segments are skipped', () => {
    const parts = notesFromDictation(play(0), 'x', [{ start: 1, end: 2, text: ' ' }, { start: 2, end: 3, text: 'Late.' }], [mk(100)])
    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({ t: 2, text: 'Late.' })
    expect(parts[0].marks).toHaveLength(1)
  })
  it('everything said and drawn on one paused frame is ONE note, not a dot per fragment', () => {
    const tl: TimelinePoint[] = [{ rec_ms: 0, video_t: 3.2, playing: false, rate: 1 }]
    const segs = [{ start: 0, end: 1, text: 'und dann haben wir eine Person,' }, { start: 1.2, end: 2, text: 'also die grindet' }, { start: 2.5, end: 3, text: 'zum Beispiel.' }]
    const parts = notesFromDictation(ms => videoTimeAt(tl, ms), 'x', segs, [mk(100), mk(1500), mk(2600)])
    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({ t: 3.2, text: 'und dann haben wir eine Person, also die grindet zum Beispiel.' })
    expect(parts[0].marks).toHaveLength(3)
  })
  it('drops mic-noise sentences, keeps short real notes', () => {
    const segs = [{ start: 0, end: 1, text: 'Ssort.' }, { start: 1.5, end: 2, text: 'Ss.' }, { start: 3, end: 4, text: 'Zu laut.' }, { start: 5, end: 6, text: 'Cut weg.' }]
    const w = [{ start: 0, end: 1, word: 'x' }]
    expect(notesFromDictation(play(0), 'x', segs, [], w).map(p => p.text)).toEqual(['Zu laut.', 'Cut weg.'])
    expect(notesFromDictation(play(0), 'Ssort.', [], [], w)).toEqual([])
  })
  it('keeps a real one-word note', () => {
    const w = [{ start: 0, end: 1, word: 'x' }]
    expect(notesFromDictation(play(0), 'x', [{ start: 0, end: 1, text: 'Schneller.' }], [], w).map(p => p.text)).toEqual(['Schneller.'])
  })
  it('noise with ink keeps the marks and empties the text', () => {
    const parts = notesFromDictation(play(0), 'x', [{ start: 0, end: 1, text: 'Ss.' }], [mk(100)], [{ start: 0, end: 1, word: 'Ss.' }])
    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({ text: '' })
    expect(parts[0].marks).toHaveLength(1)
  })
  it('splits a note in the reducer and keeps order', () => {
    const s = notesReducer(add([], 'a', 10), { type: 'split', id: 'a', parts: [{ id: 'a', t: 10, text: 'One.', marks: [] }, { id: 'b', t: 13.5, text: 'Two.', marks: [] }] })
    expect(s.map(n => [n.id, n.status])).toEqual([['a', 'ready'], ['b', 'ready']])
  })
})

// The BOF case (spec 2026-11-18 T6): the stroke began 30 ms BEFORE the first word of the next sentence. The sentence that was
// ongoing (cut by a pause, no punctuation) got the stroke and a late video time; the sentence after it sat on the same frame.
describe('notesFromDictation - one dictation, no orphan fragment (BOF)', () => {
  // video: playing from 10.4 s; at 4 s into the recording the reviewer seeks back and the video sits at 5.6+rec
  const tl: TimelinePoint[] = [{ rec_ms: 0, video_t: 10.4, playing: true, rate: 1 }, { rec_ms: 4000, video_t: 5.6, playing: true, rate: 1 }]
  const timeAt = (ms: number) => videoTimeAt(tl, ms)
  const segs = [{ start: 2, end: 3.1, text: 'Mach das hier' }, { start: 6.1, end: 7.6, text: 'so likeable wie möglich.' }]
  const stroke = { k: 'stroke' as const, points: [[0.4, 0.4], [0.6, 0.6]] as [number, number][], t: 0, offset_ms: 6070 }

  it('reproduces the premise: first sentence at 12.4 s, its stroke on frame 7.67, the second sentence at 7.7 s', () => {
    expect(timeAt(2000)).toBe(12.4)
    expect(timeAt(6070)).toBeCloseTo(7.67, 3)
    expect(timeAt(6100)).toBeCloseTo(7.7, 3)
  })

  it('a pause-cut fragment whose stroke sits on the next sentence joins it: one note on the stroke frame, nothing orphaned', () => {
    const parts = notesFromDictation(timeAt, 'x', segs, [stroke])
    expect(parts).toHaveLength(1)
    expect(parts[0].text).toBe('Mach das hier so likeable wie möglich.')
    expect(parts[0].t).toBeCloseTo(7.7, 3)
    expect(parts[0].marks.map(m => m.t.toFixed(2))).toEqual(['7.67'])
    expect(parts[0].segments.map(s => [s.text, s.start_s, +s.video_t.toFixed(2)])).toEqual([['Mach das hier', 2, 12.4], ['so likeable wie möglich.', 6.1, 7.7]])
  })

  it('a sentence that ends in . ? ! is never glued to its neighbour just because a stroke is near', () => {
    const parts = notesFromDictation(timeAt, 'x', [{ start: 2, end: 3, text: 'Mach das hier.' }, segs[1]], [stroke])
    expect(parts.map(p => p.text)).toEqual(['Mach das hier.', 'so likeable wie möglich.'])
  })

  it('a pause-cut fragment far from every stroke and from the next sentence stays its own note', () => {
    const parts = notesFromDictation(timeAt, 'x', segs, [])
    expect(parts.map(p => [p.text, +p.t.toFixed(1)])).toEqual([['Mach das hier', 12.4], ['so likeable wie möglich.', 7.7]])
  })

  it('every note carries the sentences it was made of, with times on the recording clock', () => {
    const [a, b] = notesFromDictation(timeAt, 'x', segs, [])
    expect(a.segments).toHaveLength(1)
    expect(a.segments[0]).toMatchObject({ text: 'Mach das hier', start_s: 2 })
    expect(a.segments[0].end_s).toBeGreaterThan(2.5)
    expect(a.segments[0].end_s).toBeLessThanOrEqual(3.1)
    expect(a.segments[0].video_t).toBeCloseTo(12.4, 3)
    expect(b.segments[0]).toMatchObject({ start_s: 6.1 })
    expect(b.segments[0].end_s).toBeLessThanOrEqual(7.6)
  })
})

describe('dictationPayload', () => {
  const play = (ms: number) => ms / 1000
  it('shares one id, keeps raw text and words in the server clock, and numbers the notes', () => {
    const segs = [{ start: 0, end: 1, text: 'Eins.' }, { start: 3, end: 4, text: 'Zwei.' }]
    const words = [{ start: 0, end: 0.5, word: 'Eins.' }, { start: 3, end: 3.4, word: 'Zwei.' }]
    const parts = notesFromDictation(play, 'Eins. Zwei.', segs, [], words)
    const d = dictationPayload('11111111-1111-4111-8111-111111111111', { text: 'Eins. Zwei.', raw_text: 'Eins Zwei', segments: segs, words }, parts)
    expect(d).toEqual({
      id: '11111111-1111-4111-8111-111111111111', text: 'Eins. Zwei.', raw_text: 'Eins Zwei',
      words: [{ w: 'Eins.', start_s: 0, end_s: 0.5 }, { w: 'Zwei.', start_s: 3, end_s: 3.4 }],
      segments: [{ text: 'Eins.', start_s: 0, end_s: 0.5, video_t: 0, segment_index: 0 }, { text: 'Zwei.', start_s: 3, end_s: 3.4, video_t: 3, segment_index: 1 }],
    })
  })
})
