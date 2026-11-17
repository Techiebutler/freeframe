// The frame the reviewer drew on, as a picture: video frame + ink -> JPEG, uploaded as the comment image
// `drawn-frame.jpg` (the API turns that name into feedback.v1 drawing.frame_url, so the brand loop sees the real drawing).
// It is a nicety: every step falls back to "no picture" and never throws into comment saving.
import { CONTOUR_WIDTH, DOT_PX, INK_FRAME_TOL, STROKE_WIDTHS, containedRect, thinPoints, type InkMark } from './ink'

export const DRAWN_FRAME_NAME = 'drawn-frame.jpg'
export const MAX_SIDE = 1280
const QUALITY = 0.85
/** Ink widths are screen px on a ~360 px wide player; scale them to the picture. */
const REF_SHORT_SIDE = 360

export interface FrameShot { t: number; canvas: HTMLCanvasElement }

const canvasFor = (w: number, h: number): HTMLCanvasElement | null => {
  if (!w || !h || typeof document === 'undefined') return null
  const k = Math.min(1, MAX_SIDE / Math.max(w, h))
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k))
  return c
}

/** The picture a <video> shows right now. null = nothing to draw or a tainted canvas (the video came without CORS): ink-only. */
export function snapshotVideo(video: HTMLVideoElement | null | undefined): HTMLCanvasElement | null {
  try {
    if (!video || !video.videoWidth || !video.videoHeight || video.readyState < 2) return null
    const c = canvasFor(video.videoWidth, video.videoHeight)
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return null
    ctx.drawImage(video, 0, 0, c.width, c.height)
    ctx.getImageData(0, 0, 1, 1) // drawImage never throws on a tainted canvas; reading pixels does
    return c
  } catch (e) {
    console.warn('drawn-frame: video frame not readable (canvas tainted by a cross-origin video), sending the ink only', e)
    return null
  }
}

/** The shot taken closest to `t`, if it was within the ink's frame tolerance. */
export function nearestShot(shots: FrameShot[], t: number): FrameShot | null {
  let best: FrameShot | null = null
  for (const s of shots) if (Math.abs(s.t - t) <= INK_FRAME_TOL && (!best || Math.abs(s.t - t) < Math.abs(best.t - t))) best = s
  return best
}

type Mark = Pick<InkMark, 'k' | 'points'>

/** Same look as the live ink (white line, dark contour, ring for a dot); points are 0..1 of the picture. */
export function drawMarks(ctx: CanvasRenderingContext2D, w: number, h: number, marks: Mark[]) {
  const s = Math.min(w, h) / REF_SHORT_SIDE
  const avg = STROKE_WIDTHS.reduce((a, b) => a + b, 0) / STROKE_WIDTHS.length
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'
  for (const m of marks) {
    if (m.k === 'dot') {
      const [x, y] = m.points[0] ?? [0, 0]
      ctx.beginPath(); ctx.arc(x * w, y * h, (DOT_PX + 2) * s, 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(15,23,42,.55)'; ctx.lineWidth = 6.5 * s; ctx.stroke()
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 4 * s; ctx.stroke()
      continue
    }
    const p = thinPoints(m.points).map(([x, y]) => [x * w, y * h] as const)
    if (!p.length) continue
    ctx.beginPath(); ctx.moveTo(p[0][0], p[0][1])
    if (p.length === 1) ctx.lineTo(p[0][0], p[0][1])
    for (let i = 1; i < p.length - 1; i++) ctx.quadraticCurveTo(p[i][0], p[i][1], (p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2)
    if (p.length > 1) ctx.lineTo(p[p.length - 1][0], p[p.length - 1][1])
    ctx.strokeStyle = 'rgba(15,23,42,.55)'; ctx.lineWidth = CONTOUR_WIDTH * s; ctx.stroke()
    ctx.strokeStyle = '#fff'; ctx.lineWidth = avg * s; ctx.stroke()
  }
}

const toFile = (c: HTMLCanvasElement): Promise<File | null> => new Promise(resolve => {
  try { c.toBlob(b => resolve(b ? new File([b], DRAWN_FRAME_NAME, { type: 'image/jpeg' }) : null), 'image/jpeg', QUALITY) }
  catch (e) { console.warn('drawn-frame: could not encode the frame', e); resolve(null) }
})

/** Frame + ink strokes (Talk + Draw, ink.v1) -> drawn-frame.jpg. null when there is no frame or it cannot be read. */
export async function drawnFrameFile(shot: FrameShot | null, marks: Mark[]): Promise<File | null> {
  try {
    if (!shot || !marks.length) return null
    const c = canvasFor(shot.canvas.width, shot.canvas.height)
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return null
    ctx.drawImage(shot.canvas, 0, 0, c.width, c.height)
    drawMarks(ctx, c.width, c.height, marks)
    return await toFile(c)
  } catch (e) { console.warn('drawn-frame: render failed, sending the ink only', e); return null }
}

/** Classic comments: the drawing lives on an overlay canvas that covers the player (picture letterboxed inside it). */
export async function drawnFrameFromOverlay(video: HTMLVideoElement | null | undefined, overlay: HTMLCanvasElement | null | undefined): Promise<File | null> {
  try {
    const frame = snapshotVideo(video)
    if (!frame || !video || !overlay || !overlay.width || !overlay.height) return null
    const r = containedRect(overlay.width, overlay.height, video.videoWidth, video.videoHeight)
    const ctx = frame.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(overlay, r.left, r.top, r.width, r.height, 0, 0, frame.width, frame.height)
    return await toFile(frame)
  } catch (e) { console.warn('drawn-frame: render failed, sending the ink only', e); return null }
}
