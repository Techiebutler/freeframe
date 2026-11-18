// First-frame logic for review players: the picture never goes black between "nothing yet" and "playing".
// A frame layer (poster, or the last painted frame) sits over the <video> until the new source has a decoded frame, then fades out.

export interface FrameState {
  /** Source the video is loading (null = none yet). */
  key: string | null
  /** The frame layer is over the video. */
  covered: boolean
}

export type FrameEvent = { type: 'source'; key: string | null } | { type: 'frame'; key: string | null }

export const frameInitial: FrameState = { key: null, covered: true }

export function frameReducer(s: FrameState, e: FrameEvent): FrameState {
  if (e.type === 'source') return e.key === s.key ? s : { key: e.key, covered: true }
  // A late loadeddata of a superseded source must not uncover the new one.
  return e.key === s.key && s.covered ? { ...s, covered: false } : s
}

// The last frame a player painted, handed to the next player so a module / version switch never flashes black.
let lastFrame: string | null = null
export const getLastFrame = () => lastFrame
export const setLastFrame = (url: string | null) => { lastFrame = url }

/** Snapshot of what the video shows now (small JPEG), or null while it has no frame or the canvas is tainted. */
export function snapshotFrame(video: HTMLVideoElement, maxWidth = 360): string | null {
  try {
    if (video.readyState < 2 || !video.videoWidth) return null
    const w = Math.min(maxWidth, video.videoWidth)
    const c = document.createElement('canvas')
    c.width = w
    c.height = Math.round((w * video.videoHeight) / video.videoWidth)
    const ctx = c.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(video, 0, 0, c.width, c.height)
    return c.toDataURL('image/jpeg', 0.6)
  } catch {
    return null
  }
}

/** iOS Safari paints no frame for preload=metadata unless the URL asks for one. HLS manifests are left alone. */
export function withFirstFrameHint(url: string): string {
  return url.includes('#') || url.includes('.m3u8') ? url : `${url}#t=0.001`
}
