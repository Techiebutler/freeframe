/** Review playback: start on the 540p proxy, never on the top rung. */

export const REVIEW_SHORT_SIDE = 540
/** Fallback when a ladder has no 540p rung: the best rung up to ~2 Mbit/s (plus audio). */
export const REVIEW_MAX_BITRATE = 2_600_000

export const REVIEW_HLS_CONFIG = {
  maxBufferLength: 30,
  backBufferLength: 30,
  startFragPrefetch: true,
}

type LevelLike = { width?: number; height?: number; bitrate?: number }

/** Index of the level the review player starts on and is capped at; -1 when there are no levels. */
export function pickReviewLevel(levels: LevelLike[]): number {
  if (!levels.length) return -1
  const proxy = levels.findIndex(l => Math.min(l.width ?? 0, l.height ?? 0) === REVIEW_SHORT_SIDE)
  if (proxy >= 0) return proxy
  let best = -1
  levels.forEach((l, i) => {
    const b = l.bitrate ?? 0
    if (b > 0 && b <= REVIEW_MAX_BITRATE && (best < 0 || b > (levels[best].bitrate ?? 0))) best = i
  })
  if (best >= 0) return best
  // Everything is above the cap: take the lightest rung.
  return levels.reduce((a, l, i) => ((l.bitrate ?? Infinity) < (levels[a].bitrate ?? Infinity) ? i : a), 0)
}

export type PlaybackSource = { kind: 'proxy' | 'hls' | 'original'; url: string }

/** proxy MP4 first, then the HLS ladder, then the original file while the proxy is still being made. */
export function pickPlaybackSource(streamUrl: string, proxyUrl?: string | null): PlaybackSource {
  if (proxyUrl) return { kind: 'proxy', url: proxyUrl }
  if (streamUrl.includes('.m3u8')) return { kind: 'hls', url: streamUrl }
  return { kind: 'original', url: streamUrl }
}
