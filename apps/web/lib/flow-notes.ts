import type { InkMark } from './ink'
import type { DictationSegment } from './agents'

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
}

export type NoteAction =
  | { type: 'add'; id: string; t: number; status?: NoteStatus }
  | { type: 'transcribing'; id: string; audio: Blob }
  | { type: 'done'; id: string; text: string }
  | { type: 'failed'; id: string }
  | { type: 'edit'; id: string; text: string }
  | { type: 'marks'; id: string; marks: InkMark[] }
  | { type: 'split'; id: string; parts: { id: string; t: number; text: string; marks: InkMark[] }[] }
  | { type: 'remove'; id: string }
  | { type: 'clear' }

export function notesReducer(state: FlowNote[], a: NoteAction): FlowNote[] {
  switch (a.type) {
    case 'add':
      return [...state, { id: a.id, t: a.t, text: '', status: a.status ?? 'recording', marks: [] }].sort((x, y) => x.t - y.t)
    case 'transcribing':
      return state.map(n => (n.id === a.id ? { ...n, status: 'transcribing', audio: a.audio } : n))
    case 'done':
      return state.map(n => (n.id === a.id ? { ...n, status: 'ready', text: a.text, audio: undefined } : n))
    case 'failed':
      return state.map(n => (n.id === a.id ? { ...n, status: 'failed' } : n))
    case 'edit':
      // Typing over a failed transcription makes the note sendable without the audio.
      return state.map(n => (n.id === a.id ? { ...n, text: a.text, status: n.status === 'failed' && a.text.trim() ? 'ready' : n.status } : n))
    case 'marks':
      return state.map(n => (n.id === a.id ? { ...n, marks: a.marks } : n))
    case 'split': {
      const rest = state.filter(n => n.id !== a.id)
      return [...rest, ...a.parts.map(p => ({ id: p.id, t: p.t, text: p.text, status: 'ready' as const, marks: p.marks }))].sort((x, y) => x.t - y.t)
    }
    case 'remove':
      return state.filter(n => n.id !== a.id)
    case 'clear':
      return []
  }
}

export const sendable = (notes: FlowNote[]) => notes.filter(n => n.status === 'ready' && n.text.trim())
/** Send must wait while any note is still being recorded, transcribed or empty. */
export const sendBlocked = (notes: FlowNote[]) => notes.some(n => n.status === 'recording' || n.status === 'transcribing' || (n.status === 'failed' && !n.text.trim()) || (n.status === 'ready' && !n.text.trim()))

export interface NotePart { t: number; text: string; marks: InkMark[] }

/**
 * One note per spoken segment (H69), at the playhead the recording started on plus the segment start.
 * A mark belongs to the last segment that had started when it was drawn. No segments: one note with everything.
 */
export function notesFromDictation(baseT: number, text: string, segments: DictationSegment[], marks: InkMark[]): NotePart[] {
  const spoken = segments.filter(s => s.text.trim()).sort((a, b) => a.start - b.start)
  if (!spoken.length) return [{ t: baseT, text: text.trim(), marks }]
  const parts: NotePart[] = spoken.map(s => ({ t: Math.round((baseT + s.start) * 1000) / 1000, text: s.text.trim(), marks: [] }))
  for (const m of marks) {
    let i = 0
    spoken.forEach((s, idx) => { if (s.start * 1000 <= m.offset_ms) i = idx })
    parts[i].marks.push(m)
  }
  return parts
}
