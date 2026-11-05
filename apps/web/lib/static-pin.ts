import { buildDrawingData, clamp01, isInk } from '@/lib/ink'

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
