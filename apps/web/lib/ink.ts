// Talk + Draw ink, ported from gen-aditor CutReview (H69/H70). Coordinates are normalised to the
// source picture: 0..1, origin top-left, no letterbox bars (contract Nachtrag 1).

export const INK_MS = 1200
export const DOT_PX = 8
export type MarkKind = 'stroke' | 'dot'
export interface InkMark { k: MarkKind; points: [number, number][]; /** video seconds, ms precision */ t: number; /** ms since the recording started */ offset_ms: number }

export const clamp01 = (n: number) => Math.min(1, Math.max(0, n))
export const normalizePoint = (r: { left: number; top: number; width: number; height: number }, x: number, y: number): [number, number] =>
  [clamp01((x - r.left) / r.width), clamp01((y - r.top) / r.height)]
export const classifyMark = (farPx: number): MarkKind => (farPx < DOT_PX ? 'dot' : 'stroke')

export function buildDrawingData(marks: InkMark[]): Record<string, unknown> | null {
  if (!marks.length) return null
  return {
    format: 'ink.v1',
    mark_offset_ms: marks[0].offset_ms,
    marks: marks.map(m => ({ ...m, t: Math.round(m.t * 1000) / 1000 })),
  }
}
export const isInk = (d: unknown): d is { format: 'ink.v1'; marks: InkMark[] } =>
  !!d && typeof d === 'object' && (d as { format?: string }).format === 'ink.v1' && Array.isArray((d as { marks?: unknown }).marks)

/** Where a `videoW:videoH` picture sits when letterboxed (object-contain) inside a container. */
export function containedRect(cw: number, ch: number, videoW: number, videoH: number) {
  if (!videoW || !videoH || !cw || !ch) return { left: 0, top: 0, width: cw, height: ch }
  const scale = Math.min(cw / videoW, ch / videoH)
  const width = videoW * scale
  const height = videoH * scale
  return { left: (cw - width) / 2, top: (ch - height) / 2, width, height }
}
