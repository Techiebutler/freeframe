// Embed review: the mic follows the video's pause state. Paused = talk, playing = silence (the video's own sound must
// never reach the transcript). Pure state machine; flow-view runs the effects it returns.

export interface DictState {
  /** False until the reviewer first plays the video or taps Comment: opening the page never asks for the mic. */
  armed: boolean
  video: 'playing' | 'paused'
  /** `on` = a dictation segment is recording, `typing` = the mic is unavailable, typed notes only. */
  mic: 'off' | 'on' | 'typing'
  /** Stop was tapped while paused: stay silent until the video plays again. */
  stopped: boolean
  /** Typing was chosen (keyboard button), not forced by a denied mic: it stays through Play and pause until Comment (dictation). */
  chosen: boolean
}
export type DictEvent = 'play' | 'pause' | 'comment' | 'stop' | 'denied' | 'type'
export type DictEffect = 'start' | 'flush' | 'close' | 'discard' | 'pause' | 'focus' | 'hint'

export const dictInitial: DictState = { armed: false, video: 'paused', mic: 'off', stopped: false, chosen: false }

export function dictStep(s: DictState, e: DictEvent): { state: DictState; effects: DictEffect[] } {
  switch (e) {
    case 'play':
      // Resuming closes the segment: it becomes its comment(s), unless nothing was said or drawn.
      return { state: { ...s, armed: true, video: 'playing', mic: s.mic === 'on' ? 'off' : s.mic, stopped: false }, effects: s.mic === 'on' ? ['close'] : [] }
    case 'pause':
      if (!s.armed || s.stopped || s.mic !== 'off') return { state: { ...s, video: 'paused' }, effects: [] }
      return { state: { ...s, video: 'paused', mic: 'on' }, effects: ['start'] }
    case 'comment': {
      if (s.mic === 'on') return { state: { ...s, stopped: true, mic: 'off' }, effects: ['flush'] } // second tap = Stop
      const effects: DictEffect[] = s.video === 'playing' ? ['pause'] : []
      const base = { ...s, armed: true, video: 'paused' as const, stopped: false }
      if (s.mic === 'typing' && !s.chosen) return { state: base, effects: [...effects, 'focus'] } // denied mic: typing is all there is
      return { state: { ...base, mic: 'on', chosen: false }, effects: [...effects, 'start', 'focus'] }
    }
    case 'stop':
      return { state: { ...s, mic: s.mic === 'on' ? 'off' : s.mic, stopped: true }, effects: s.mic === 'on' ? ['discard'] : [] }
    case 'type':
      // The keyboard button: typing mode until Comment. A running dictation is flushed first (what was said is kept); a playing video is paused.
      if (s.mic === 'typing') return { state: s, effects: ['focus'] }
      return {
        state: { ...s, armed: true, video: 'paused', mic: 'typing', stopped: false, chosen: true },
        effects: [...(s.mic === 'on' ? ['flush' as const] : []), ...(s.video === 'playing' ? ['pause' as const] : []), 'focus'],
      }
    case 'denied':
      return { state: { ...s, mic: 'typing', chosen: false }, effects: ['hint', 'focus'] }
  }
}

/** `close` (play) drops a segment this short with nothing drawn is a tap, not a note: Whisper would only invent words from silence. */
export const MIN_SEGMENT_MS = 700
export const keepSegment = (ms: number, drawn: number) => ms >= MIN_SEGMENT_MS || drawn > 0
