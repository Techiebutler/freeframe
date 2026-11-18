import type { InkMark } from './ink'
import type { DictationSegment } from './agents'
import { sentencesFromDictation, type DictationWord } from './dictation-sentences'

// Notes drafted in the phone "Flow" view before they are sent as comments.

export type NoteStatus = 'recording' | 'transcribing' | 'ready' | 'failed'
export interface FlowNote {
  id: string
  /** Playhead second captured when the note was started. */
  t: number
  text: string
  status: NoteStatus
  /** Kept when transcription fails so "Try again" never loses the recording. */
  audio?: Blob
  /** Ink drawn during this note's part of the recording. */
  marks?: InkMark[]
  /** Reference images pasted, dropped or picked for this note; they go out in the same comment. */
  images?: File[]
  /** Set when the note came from a spoken dictation: every sentence-note of one dictation shares this payload (spec 2026-11-18). */
  dictation?: DictationPayload
  /** Which note (comment) of the dictation this is: its sentences carry this `segment_index`. */
  segment_index?: number
  /** The recording itself, kept on the dictation's first note so it goes up with that comment (agents can re-transcribe it). */
  dictationAudio?: { blob: Blob; duration_s: number }
}

/** One dictation as the API stores it. Times are seconds since the recording start (Whisper's clock); `video_t` is video time. */
export interface DictationPayload {
  id: string
  text: string
  raw_text?: string
  lang?: string
  words: { w: string; start_s: number; end_s: number }[]
  segments: { text: string; start_s: number; end_s: number; video_t: number; segment_index: number }[]
}

export type NoteAction =
  | { type: 'add'; id: string; t: number; status?: NoteStatus; images?: File[] }
  | { type: 'transcribing'; id: string; audio: Blob }
  | { type: 'done'; id: string; text: string }
  | { type: 'failed'; id: string }
  | { type: 'edit'; id: string; text: string }
  /** A typed note (nothing was transcribed) is done being typed: it may now be saved. */
  | { type: 'commit'; id: string }
  | { type: 'marks'; id: string; marks: InkMark[] }
  | { type: 'split'; id: string; parts: { id: string; t: number; text: string; marks: InkMark[]; segment_index?: number }[]; dictation?: DictationPayload; audio?: { blob: Blob; duration_s: number } }
  | { type: 'remove'; id: string }
  | { type: 'dropImages'; id: string }
  | { type: 'clear' }

export function notesReducer(state: FlowNote[], a: NoteAction): FlowNote[] {
  switch (a.type) {
    case 'add':
      return [...state, { id: a.id, t: a.t, text: '', status: a.status ?? 'recording', marks: [], ...(a.images?.length ? { images: a.images } : {}) }].sort((x, y) => x.t - y.t)
    case 'transcribing':
      return state.map(n => (n.id === a.id ? { ...n, status: 'transcribing', audio: a.audio } : n))
    case 'done':
      return state.map(n => (n.id === a.id ? { ...n, status: 'ready', text: a.text, audio: undefined } : n))
    case 'failed':
      return state.map(n => (n.id === a.id ? { ...n, status: 'failed' } : n))
    case 'edit':
      return state.map(n => (n.id === a.id ? { ...n, text: a.text } : n))
    case 'commit':
      return state.map(n => (n.id === a.id && n.status === 'failed' && n.text.trim() ? { ...n, status: 'ready' } : n))
    case 'marks':
      return state.map(n => (n.id === a.id ? { ...n, marks: a.marks } : n))
    case 'split': {
      const rest = state.filter(n => n.id !== a.id)
      const images = state.find(n => n.id === a.id)?.images  // a spoken note's images stay with its first sentence
      return [...rest, ...a.parts.map((p, i) => ({ id: p.id, t: p.t, text: p.text, status: 'ready' as const, marks: p.marks,
        ...(i === 0 && images?.length ? { images } : {}),
        ...(a.dictation ? { dictation: a.dictation, segment_index: p.segment_index ?? i } : {}),
        ...(i === 0 && a.dictation && a.audio ? { dictationAudio: a.audio } : {}) }))].sort((x, y) => x.t - y.t)
    }
    case 'dropImages':
      return state.map(n => (n.id === a.id ? { ...n, images: undefined } : n))
    case 'remove':
      return state.filter(n => n.id !== a.id)
    case 'clear':
      return []
  }
}

export const sendable = (notes: FlowNote[]) => notes.filter(n => n.status === 'ready' && n.text.trim())
/** Send must wait while any note is still being recorded, transcribed or empty. */
export const sendBlocked = (notes: FlowNote[]) => notes.some(n => n.status === 'recording' || n.status === 'transcribing' || (n.status === 'failed' && !n.text.trim()) || (n.status === 'ready' && !n.text.trim()))

const FILLER = /^(s+|sh+|z+|hm+|h+m+|äh+m*|ähm|mm+|uh+m*|um+|ah+|oh+|e+h+)$/i
/** Mic noise Whisper turned into text ("Ssort.", "Ss."): only filler/sibilant tokens, or one token that starts with a doubled sibilant.
 *  ponytail: deliberately narrow; a real one-word note ("Schneller.") must survive, a noise note can be deleted by hand. */
export function isNoiseText(text: string): boolean {
  const tokens = text.toLowerCase().replace(/[^a-z0-9äöüß\s'-]/g, ' ').split(/\s+/).filter(Boolean)
  if (!tokens.length || tokens.every(t => t.length < 2 || FILLER.test(t))) return true
  return tokens.length === 1 && /^(ss|shh|schh|zz)/.test(tokens[0])
}

/** One spoken sentence inside a note: times on the recording clock, `video_t` where the video was when it was said. */
export interface NoteSegment { text: string; start_s: number; end_s: number; video_t: number }
export interface NotePart { t: number; text: string; marks: InkMark[]; segments: NoteSegment[] }

/** Sentences that end like this were cut by punctuation; any other (not last) one was cut only by a pause. */
const TERMINAL = /[.?!…]["'”“»«)\]]*$/

/**
 * One note per spoken sentence (H69, dictation v2: segments merged until . ? ! or a 1.5 s pause), fragments on the same frame merged. `timeAt` maps an offset into the recording to video time (pauses, seeks and
 * playback rate included), for the sentence's note AND for every ink mark. A mark belongs to the last segment that
 * had started when it was drawn. No segments: one note with everything.
 * A sentence cut only by a pause (no . ? !) is a fragment: when its ink or its time sits on its neighbour's frame it joins that
 * neighbour (spec 2026-11-18 T6), so a stroke drawn just before the next sentence's first word is never orphaned from it.
 */
export function notesFromDictation(timeAt: (offsetMs: number) => number, text: string, segments: DictationSegment[], marks: InkMark[], words: DictationWord[] = []): NotePart[] {
  const timed = marks.map(m => ({ ...m, t: timeAt(m.offset_ms) }))
  // Only for real Whisper results (they always carry word timings); bare segments stay untouched.
  const cleaned = (parts: NotePart[]) => !words.length ? parts : parts.flatMap(p => (isNoiseText(p.text) ? (p.marks.length ? [{ ...p, text: '' }] : []) : [p]))
  // Whole sentences, each stamped where the video was when its first word was said
  const spoken = sentencesFromDictation(segments, words)
  if (!spoken.length) return cleaned([{ t: timeAt(0), text: text.trim(), marks: timed, segments: [] }])
  const parts: NotePart[] = spoken.map(s => ({ t: timeAt(s.start * 1000), text: s.text.trim(), marks: [], segments: [{ text: s.text.trim(), start_s: s.start, end_s: s.end, video_t: timeAt(s.start * 1000) }] }))
  for (const m of timed) {
    let i = 0
    spoken.forEach((s, idx) => { if (s.start * 1000 <= m.offset_ms) i = idx })
    parts[i].marks.push(m)
  }
  const join = (into: NotePart, from: NotePart, t: number, fromFirst: boolean) => {
    into.text = (fromFirst ? `${from.text} ${into.text}` : `${into.text} ${from.text}`).trim()
    into.marks = [...into.marks, ...from.marks].sort((a, b) => a.offset_ms - b.offset_ms)
    into.segments = fromFirst ? [...from.segments, ...into.segments] : [...into.segments, ...from.segments]
    into.t = t
  }
  // Fragments on (nearly) the same frame are one thought: paused while drawing, they would all stack on one timestamp.
  const merged = cleaned(parts).reduce<NotePart[]>((out, part) => {
    const prev = out[out.length - 1]
    if (prev && Math.abs(part.t - prev.t) < SAME_FRAME_S) join(prev, part, prev.t, false)
    else out.push(part)
    return out
  }, [])
  // A pause-cut fragment (not last, no terminal punctuation) whose ink sits on the next note's frame joins that note.
  for (let i = 0; i < merged.length - 1; i++) {
    const frag = merged[i], next = merged[i + 1]
    const last = frag.segments[frag.segments.length - 1]
    if (!last || TERMINAL.test(last.text) || !frag.marks.length) continue
    const onNext = frag.marks.some(m => Math.abs(m.t - next.t) < SAME_FRAME_S || next.marks.some(n => Math.abs(m.t - n.t) < SAME_FRAME_S))
    if (!onNext) continue
    join(next, frag, next.t, true)
    merged.splice(i, 1)
    i--
  }
  return merged
}

/** The dictation as the API stores it, for the notes `notesFromDictation` returned (same order = `segment_index`). */
export function dictationPayload(id: string, r: { text: string; raw_text?: string; lang?: string; segments?: DictationSegment[]; words?: DictationWord[] }, parts: NotePart[]): DictationPayload {
  return {
    id, text: r.text.trim(), ...(r.raw_text ? { raw_text: r.raw_text } : {}), ...(r.lang ? { lang: r.lang } : {}),
    words: (r.words ?? []).map(w => ({ w: w.word.trim(), start_s: w.start, end_s: w.end })),
    segments: parts.flatMap((p, i) => p.segments.map(s => ({ ...s, segment_index: i }))).sort((a, b) => a.start_s - b.start_s),
  }
}

/** Fragments closer than this in video time join one note. */
const SAME_FRAME_S = 0.5
