import { buildDrawingData, clamp01, isInk, type InkMark } from '@/lib/ink'
import type { DictationSegment } from '@/lib/agents'
import { sentencesFromDictation, type DictationWord } from '@/lib/dictation-sentences'

/** A pin on a static ad is the same `ink.v1` dot a video note carries, in the picture's own 0..1 frame, with no time. */
export const pinDrawing = (x: number, y: number): Record<string, unknown> =>
  buildDrawingData([{ k: 'dot', points: [[clamp01(x), clamp01(y)]], t: 0, offset_ms: 0 }])!

/** Where a comment points on the picture, or null for a note on the whole ad. A drawn stroke pins at its first point. */
export function pinOf(drawing: unknown): [number, number] | null {
  if (!isInk(drawing)) return null
  const p = drawing.marks[0]?.points?.[0]
  return p && Number.isFinite(p[0]) && Number.isFinite(p[1]) ? [clamp01(p[0]), clamp01(p[1])] : null
}

/** Natural order, so "Ad 2" comes before "Ad 10". */
export const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })

export interface StaticMemoNote { fileId: string; text: string; marks: InkMark[] }

/**
 * One voice memo across several ads: every sentence goes to the ad that was on screen when it was said, and every
 * tap / stroke to the ad it was drawn on. Back-to-back sentences on the same ad become one note; a drawing joins the
 * note of its ad that was running when it was drawn (else the nearest one), or stands alone when that ad got no words.
 * `views` = when each ad came on screen (ms into the recording, first at 0).
 */
export function staticNotesFromMemo(
  views: { fileId: string; at: number }[],
  marks: { fileId: string; mark: InkMark }[],
  text: string,
  segments: DictationSegment[],
  words: DictationWord[] = [],
): StaticMemoNote[] {
  const fileAt = (ms: number) => views.reduce((cur, v) => (v.at <= ms ? v.fileId : cur), views[0].fileId)
  const spoken = sentencesFromDictation(segments, words)
  const groups: (StaticMemoNote & { from: number; to: number })[] = []
  if (!spoken.length && text.trim()) groups.push({ fileId: views[0].fileId, text: text.trim(), marks: [], from: 0, to: Infinity })
  for (const s of spoken) {
    const fileId = fileAt(s.start * 1000)
    const last = groups[groups.length - 1]
    if (last?.fileId === fileId) { last.text += ` ${s.text.trim()}`; last.to = s.end * 1000 }
    else groups.push({ fileId, text: s.text.trim(), marks: [], from: s.start * 1000, to: s.end * 1000 })
  }
  for (const { fileId, mark } of marks) {
    const own = groups.filter(g => g.fileId === fileId)
    if (!own.length) { groups.push({ fileId, text: '', marks: [mark], from: mark.offset_ms, to: mark.offset_ms }); continue }
    const dist = (g: { from: number; to: number }) => (mark.offset_ms < g.from ? g.from - mark.offset_ms : Math.max(0, mark.offset_ms - g.to))
    own.reduce((best, g) => (dist(g) < dist(best) ? g : best)).marks.push(mark)
  }
  return groups.map(({ fileId, text: t, marks: m }) => ({ fileId, text: t, marks: m.sort((a, b) => a.offset_ms - b.offset_ms) }))
}
