// Talk + Draw ink, ported from gen-aditor CutReview (H69/H70). Coordinates are normalised to the
// source picture: 0..1, origin top-left, no letterbox bars (contract Nachtrag 1).

export const INK_MS = 1200
export const DOT_PX = 8
export type MarkKind = 'stroke' | 'dot'
export interface InkMark {
  k: MarkKind
  points: [number, number][]
  /** video seconds, ms precision */
  t: number
  /** ms since the recording started */
  offset_ms: number
  /** ms since the stroke began, one per point: lets a replay draw at the original speed (additive to ink.v1) */
  times?: number[]
}

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

// ── Drawing feel: smooth curves, a gentle taper ───────────────────────────────

/** Slightly thicker at the start, thinning towards the end (screen px, the stroke has a fixed screen width). */
export const STROKE_WIDTHS = [7, 6.6, 6.2, 5.8, 5.4, 5, 4.6]

/** One width for the whole dark contour: a little wider than the average core, so the outline stays even along the taper. */
export const CONTOUR_WIDTH = Math.round((STROKE_WIDTHS.reduce((a, b) => a + b, 0) / STROKE_WIDTHS.length + 3) * 10) / 10

const r4 = (v: number) => Math.round(v * 10000) / 10000
const pt = (p: [number, number]) => `${r4(p[0])},${r4(p[1])}`

/** Drops points closer than `minDist` to the last kept one; both ends always stay. */
export function thinPoints(points: [number, number][], minDist = 0.004): [number, number][] {
  if (points.length < 3) return points
  const out: [number, number][] = [points[0]]
  for (let i = 1; i < points.length - 1; i++) {
    const last = out[out.length - 1]
    if (Math.hypot(points[i][0] - last[0], points[i][1] - last[1]) >= minDist) out.push(points[i])
  }
  out.push(points[points.length - 1])
  return out
}

const mid = (a: [number, number], b: [number, number]): [number, number] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]

/**
 * A quadratic curve through the midpoints of the captured points, so a hand-drawn line has no corners.
 * `trimStart` / `trimEnd` begin / end on the midpoint instead of the raw end point, so neighbouring chunks of one stroke
 * join with the same tangent (no kinks where the width steps).
 */
export function smoothPath(points: [number, number][], opts: { trimStart?: boolean; trimEnd?: boolean } = {}): string {
  const n = points.length
  if (n === 0) return ''
  if (n === 1) return `M${pt(points[0])}L${pt(points[0])}`
  if (n === 2) return `M${pt(points[0])}L${pt(points[1])}`
  let d = `M${pt(opts.trimStart ? mid(points[0], points[1]) : points[0])}`
  for (let i = 1; i < n - 1; i++) d += `Q${pt(points[i])} ${pt(mid(points[i], points[i + 1]))}`
  return opts.trimEnd ? d : `${d}L${pt(points[n - 1])}`
}

export interface InkChunk { points: [number, number][]; width: number; trimStart: boolean; trimEnd: boolean }

/** Splits a stroke into consecutive chunks that get the tapering widths; each carries its neighbours' points so the curve stays continuous. */
export function taperChunks(points: [number, number][]): InkChunk[] {
  const n = points.length
  const k = STROKE_WIDTHS.length
  if (n < k * 2) return [{ points, width: STROKE_WIDTHS[0], trimStart: false, trimEnd: false }]
  return STROKE_WIDTHS.map((width, i) => {
    const a = Math.floor((i * (n - 1)) / k)
    const b = Math.floor(((i + 1) * (n - 1)) / k)
    const first = i === 0
    const last = i === k - 1
    return { width, points: points.slice(a, last ? b + 1 : b + 2), trimStart: !first, trimEnd: !last }
  })
}

// ── Timed replay ──────────────────────────────────────────────────────────────

/** ms the stroke took to draw (0 when its point times were not stored). */
export const markDuration = (m: Pick<InkMark, 'times'>): number => (m.times?.length ? m.times[m.times.length - 1] : 0)

type Timed = Pick<InkMark, 'k' | 'points'> & Partial<Pick<InkMark, 'times' | 'offset_ms'>>

/** What is on screen `elapsedMs` into a replay: each stroke grows at the speed it was drawn, later strokes start after their original gap. */
export function visibleMarks(marks: Timed[], elapsedMs: number): { k: MarkKind; points: [number, number][] }[] {
  const base = marks.length ? (marks[0].offset_ms ?? 0) : 0
  const out: { k: MarkKind; points: [number, number][] }[] = []
  for (const m of marks) {
    if (!m.times?.length) { out.push({ k: m.k, points: m.points }); continue }
    const local = elapsedMs - ((m.offset_ms ?? base) - base)
    if (local < 0) continue
    let n = 0
    while (n < m.points.length && m.times[n] <= local) n++
    if (n === 0 || (m.k === 'stroke' && n < 2)) continue
    out.push({ k: m.k, points: m.k === 'dot' ? m.points : m.points.slice(0, n) })
  }
  return out
}

/** Total time a replay of these marks takes. */
export const replayDuration = (marks: Timed[]): number => {
  const base = marks.length ? (marks[0].offset_ms ?? 0) : 0
  return marks.reduce((max, m) => Math.max(max, ((m.offset_ms ?? base) - base) + (m.times?.length ? m.times[m.times.length - 1] : 0)), 0)
}

// ── Pointing words ────────────────────────────────────────────────────────────

const DEICTIC = new Set(['this', 'here', 'that', 'da', 'hier', 'das', 'dieser', 'diese'])
/** Splits a note into plain and pointing words (this, here, hier, das ...), which link to the moment and its drawing. */
export function splitDeictic(text: string): { text: string; deictic: boolean }[] {
  const out: { text: string; deictic: boolean }[] = []
  const word = /[A-Za-z0-9\u00C0-\u024F]+/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = word.exec(text))) {
    if (!DEICTIC.has(m[0].toLowerCase())) continue
    if (m.index > last) out.push({ text: text.slice(last, m.index), deictic: false })
    out.push({ text: m[0], deictic: true })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last), deictic: false })
  return out
}
