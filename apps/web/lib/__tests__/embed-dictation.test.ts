import { describe, expect, it } from 'vitest'
import { dictInitial, dictStep, keepSegment, type DictEvent, type DictState } from '../embed-dictation'
import { notesFromDictation } from '../flow-notes'
import { videoTimeAt, type TimelinePoint } from '../rec-timeline'

const run = (events: DictEvent[], from: DictState = dictInitial) =>
  events.reduce((acc, e) => { const r = dictStep(acc.state, e); return { state: r.state, effects: r.effects, all: [...acc.all, ...r.effects] } }, { state: from, effects: [] as string[], all: [] as string[] })

describe('embed dictation state machine', () => {
  it('stays silent until the reviewer first plays or taps Comment (no mic prompt on load)', () => {
    expect(run(['pause']).all).toEqual([])
  })
  it('playing -> paused starts dictation', () => {
    const r = run(['play', 'pause'])
    expect(r.all).toEqual(['start'])
    expect(r.state.mic).toBe('on')
  })
  it('paused -> playing closes the segment and the mic is off while it plays', () => {
    const r = run(['play', 'pause', 'play'])
    expect(r.all).toEqual(['start', 'close'])
    expect(r.state).toMatchObject({ mic: 'off', video: 'playing' })
  })
  it('Comment while playing pauses, starts and focuses the box', () => {
    const r = run(['play', 'comment'])
    expect(r.effects).toEqual(['pause', 'start', 'focus'])
    // the pause event the video then fires must not start a second segment
    expect(run(['play', 'comment', 'pause']).all.filter(e => e === 'start')).toHaveLength(1)
  })
  it('Comment on a fresh paused video arms and starts', () => {
    expect(run(['comment']).effects).toEqual(['start', 'focus'])
  })
  it('a second Comment tap is Stop: it flushes and stays silent while still paused, until the next play', () => {
    const r = run(['comment', 'comment'])
    expect(r.effects).toEqual(['flush'])
    expect(run(['comment', 'comment', 'pause']).all.filter(e => e === 'start')).toHaveLength(1)
    expect(run(['comment', 'comment', 'play', 'pause']).all.filter(e => e === 'start')).toHaveLength(2)
  })
  it('permission denied -> typing fallback: hint once, focus the box, never records again', () => {
    const r = run(['comment', 'denied'])
    expect(r.effects).toEqual(['hint', 'focus'])
    expect(r.state.mic).toBe('typing')
    expect(run(['comment', 'denied', 'play', 'pause', 'comment']).all.filter(e => e === 'start')).toHaveLength(1)
    expect(run(['comment', 'denied', 'play']).all).not.toContain('close')
  })
  it('Cancel discards without a note and stays silent until the next play', () => {
    const r = run(['comment', 'stop'])
    expect(r.effects).toEqual(['discard'])
    expect(run(['comment', 'stop', 'pause']).all.filter(e => e === 'start')).toHaveLength(1)
  })
  it('drops a segment with no speech time and no drawing', () => {
    expect(keepSegment(300, 0)).toBe(false)
    expect(keepSegment(300, 1)).toBe(true)
    expect(keepSegment(2000, 0)).toBe(true)
  })
})

describe('timestamps while paused', () => {
  // Segment starts paused at 10 s; the reviewer scrubs to 25 s after 4 s of talking.
  const points: TimelinePoint[] = [
    { rec_ms: 0, video_t: 10, playing: false, rate: 1 },
    { rec_ms: 4000, video_t: 25, playing: false, rate: 1 },
  ]
  it('each sentence gets the playhead where it was said', () => {
    const words = [
      { start: 0.5, end: 1, word: 'First' }, { start: 1, end: 1.5, word: 'thing.' },
      { start: 5, end: 5.5, word: 'Second' }, { start: 5.5, end: 6, word: 'thing.' },
    ]
    const parts = notesFromDictation(ms => videoTimeAt(points, ms), 'First thing. Second thing.', [{ start: 0.5, end: 6, text: 'First thing. Second thing.' }], [], words)
    expect(parts.map(p => [p.t, p.text])).toEqual([[10, 'First thing.'], [25, 'Second thing.']])
  })
  it('Type while dictating flushes the segment and focuses the field; Play ends typing, the next pause dictates again', () => {
    const r = run(['play', 'pause', 'type'])
    expect(r.effects).toEqual(['flush', 'focus'])
    expect(r.state).toMatchObject({ mic: 'typing', typeOnce: true })
    expect(run(['play', 'pause', 'type', 'pause', 'play']).effects).toEqual([])
    const again = run(['play', 'pause', 'type', 'play', 'pause'])
    expect(again.state).toMatchObject({ mic: 'on', typeOnce: false })
    expect(again.effects).toEqual(['start'])
  })
  it('Type does nothing unless dictating; typing after a denied mic stays sticky', () => {
    expect(run(['play', 'type']).effects).toEqual([])
    const denied = run(['comment', 'denied', 'play', 'pause'])
    expect(denied.state.mic).toBe('typing')
    expect(denied.all.filter(e => e === 'start')).toHaveLength(1)
  })
})
