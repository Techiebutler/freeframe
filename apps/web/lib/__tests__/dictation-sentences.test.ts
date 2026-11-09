import { describe, expect, it } from 'vitest'
import { notesFromDictation } from '../flow-notes'
import { sentencesFromDictation, type DictationWord } from '../dictation-sentences'
import { videoTimeAt, type TimelinePoint } from '../rec-timeline'

const p = (rec_ms: number, video_t: number, playing: boolean, rate = 1): TimelinePoint => ({ rec_ms, video_t, playing, rate })
/** Words spoken one after another from `from` s, 0.4 s each, no gaps. */
const say = (from: number, ...ws: string[]): DictationWord[] => ws.map((word, i) => ({ word, start: from + i * 0.4, end: from + i * 0.4 + 0.35 }))
const mk = (offset_ms: number) => ({ k: 'dot' as const, points: [[0.5, 0.5] as [number, number]], t: 0, offset_ms })

describe('sentencesFromDictation', () => {
  it('joins segments into whole sentences: a long sentence across three segments stays one', () => {
    const segments = [
      { start: 0, end: 2, text: 'Der Hook ist am Anfang viel zu langsam' },
      { start: 2, end: 4, text: 'und die Musik ist zu laut' },
      { start: 4, end: 6, text: 'in der zweiten Szene.' },
      { start: 6.2, end: 8, text: 'Danach passt es wieder.' },
    ]
    const s = sentencesFromDictation(segments, [])
    expect(s.map(x => x.text)).toEqual(['Der Hook ist am Anfang viel zu langsam und die Musik ist zu laut in der zweiten Szene.', 'Danach passt es wieder.'])
    expect(s[0].start).toBe(0)
    expect(s[1].start).toBeCloseTo(6.2)
  })

  it('anchors a sentence at its FIRST spoken word, from the word timestamps', () => {
    const words = [...say(1.2, 'Der', 'Hook', 'ist', 'langsam'), ...say(6, 'Musik', 'lauter')]
    const segments = [{ start: 0.9, end: 3, text: 'Der Hook ist langsam.' }, { start: 5.8, end: 7, text: 'Musik lauter.' }]
    const s = sentencesFromDictation(segments, words)
    expect(s.map(x => x.start)).toEqual([1.2, 6])
  })

  it('German text with English lexicon words (B-Roll, Trello, Talking Head) aligns to the right words', () => {
    const words = [...say(0.5, 'Die', 'B-Roll', 'im', 'Talking', 'Head', 'ist', 'gut'), ...say(8, 'Schick', 'es', 'in', 'Trello')]
    const segments = [{ start: 0.5, end: 3.5, text: 'Die B-Roll im Talking Head ist gut.' }, { start: 8, end: 9.6, text: 'Schick es in Trello.' }]
    const s = sentencesFromDictation(segments, words)
    expect(s).toHaveLength(2)
    expect(s[1].start).toBe(8)
    expect(s[0].text).toBe('Die B-Roll im Talking Head ist gut.')
  })

  it('splits at a pause longer than 1.5 s even without punctuation, never at a shorter one', () => {
    const words = [...say(0, 'zu', 'langsam'), ...say(4, 'Musik', 'leiser'), ...say(5.5, 'bitte')]
    const segments = [{ start: 0, end: 5.9, text: 'zu langsam Musik leiser bitte' }]
    const s = sentencesFromDictation(segments, words)
    expect(s.map(x => x.text)).toEqual(['zu langsam', 'Musik leiser bitte'])
  })

  it('does not end a sentence at an abbreviation or an ordinal', () => {
    const segments = [{ start: 0, end: 6, text: 'Am 3. Mai, z.B. im Hook, passt das nicht. Danke!' }]
    expect(sentencesFromDictation(segments, []).map(x => x.text)).toEqual(['Am 3. Mai, z.B. im Hook, passt das nicht.', 'Danke!'])
  })

  it('falls back to segment times when there are no words, and to nothing when there is no speech', () => {
    expect(sentencesFromDictation([{ start: 2, end: 3, text: 'Nur Segment.' }], [])[0].start).toBe(2)
    expect(sentencesFromDictation([{ start: 0, end: 1, text: ' ' }], [])).toEqual([])
  })
})

describe('notesFromDictation with sentences: the video time at the first word', () => {
  const segments = [{ start: 0, end: 2, text: 'Der Hook ist' }, { start: 2, end: 4, text: 'zu langsam.' }, { start: 5, end: 6, text: 'Musik lauter.' }]

  it('paused video: both notes sit on the frozen frame and merge (one frame, one thought)', () => {
    const tl = [p(0, 12, false)]
    const parts = notesFromDictation(ms => videoTimeAt(tl, ms), 'x', segments, [])
    expect(parts).toHaveLength(1)
    expect(parts[0].t).toBe(12)
    expect(parts[0].text).toBe('Der Hook ist zu langsam. Musik lauter.')
  })

  it('playing video: each sentence is stamped where the playhead was when its first word was said', () => {
    const tl = [p(0, 30, true)]
    const parts = notesFromDictation(ms => videoTimeAt(tl, ms), 'x', segments, [])
    expect(parts.map(x => x.t)).toEqual([30, 35])
    expect(parts[0].text).toBe('Der Hook ist zu langsam.')
  })

  it('seek mid-recording: a sentence spanning the seek keeps its first-word time', () => {
    const tl = [p(0, 10, true), p(3000, 50, true)] // seek to 50 s while the first sentence is still being spoken
    const parts = notesFromDictation(ms => videoTimeAt(tl, ms), 'x', segments, [])
    expect(parts.map(x => x.t)).toEqual([10, 52])
  })

  it('ink drawn while a sentence is spoken goes to that sentence', () => {
    const tl = [p(0, 30, true)]
    const parts = notesFromDictation(ms => videoTimeAt(tl, ms), 'x', segments, [mk(3000), mk(5500)])
    expect(parts[0].marks.map(m => m.offset_ms)).toEqual([3000])
    expect(parts[1].marks.map(m => m.offset_ms)).toEqual([5500])
  })

  it('uses word timestamps when given', () => {
    const words = [...say(1, 'Der', 'Hook', 'ist', 'zu', 'langsam'), ...say(5.2, 'Musik', 'lauter')]
    const parts = notesFromDictation(ms => 100 + ms / 1000, 'x', segments, [], words)
    expect(parts.map(x => x.t)).toEqual([101, 105.2])
  })
})
