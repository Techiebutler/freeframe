import { describe, expect, it } from 'vitest'
import { videoTimeAt, type TimelinePoint } from '../rec-timeline'
import { notesFromDictation, notesReducer, sendable, sendBlocked, type FlowNote } from '../flow-notes'

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
  it('typing over a failed note makes it sendable', () => {
    let s = notesReducer(add([], 'a', 1), { type: 'failed', id: 'a' })
    expect(sendBlocked(s)).toBe(true)
    s = notesReducer(s, { type: 'edit', id: 'a', text: 'Cut earlier' })
    expect(sendBlocked(s)).toBe(false)
    expect(sendable(s)).toHaveLength(1)
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
  it('splits a note in the reducer and keeps order', () => {
    const s = notesReducer(add([], 'a', 10), { type: 'split', id: 'a', parts: [{ id: 'a', t: 10, text: 'One.', marks: [] }, { id: 'b', t: 13.5, text: 'Two.', marks: [] }] })
    expect(s.map(n => [n.id, n.status])).toEqual([['a', 'ready'], ['b', 'ready']])
  })
})
