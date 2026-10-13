import type { HlsConfig } from 'hls.js'

/**
 * Where playback starts in Auto.
 *
 * Before a segment has loaded, hls.js guesses the bandwidth from the first
 * rendition in the manifest (our largest), capped at `abrEwmaDefaultEstimateMax`
 * -- 5 Mbps by default. Our rungs are constant-quality encodes, and the
 * manifest's BANDWIDTH is their peak segment bitrate, so 720p and up regularly
 * exceed 5 Mbps and every video started on 360p, then climbed once segments had
 * been measured.
 *
 * Two fixes: a returning viewer starts from the bandwidth measured on their last
 * playback, and a first-time viewer's guess may go up to 20 Mbps. A guess that
 * turns out too high costs little -- hls.js abandons a fragment that is loading
 * too slowly and drops a rung.
 */

const STORAGE_KEY = 'ff-hls-bandwidth'

/** Allows the first-rendition guess to pick 1080p (or 2160p) on a fast link. */
const FIRST_GUESS_MAX_BPS = 20_000_000

/** A measurement older than this says little about the connection now. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

interface SavedEstimate {
  bps: number
  at: number
}

function isUsable(bps: unknown): bps is number {
  return typeof bps === 'number' && Number.isFinite(bps) && bps > 0
}

/** The bandwidth measured on this browser's last playback, if recent. */
export function savedBandwidth(now = Date.now()): number | undefined {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return undefined
    const saved = JSON.parse(raw) as Partial<SavedEstimate>
    if (!isUsable(saved.bps) || typeof saved.at !== 'number') return undefined
    if (now - saved.at > MAX_AGE_MS) return undefined
    return saved.bps
  } catch {
    return undefined
  }
}

export function saveBandwidth(bps: number, now = Date.now()): void {
  if (!isUsable(bps)) return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ bps, at: now }))
  } catch {
    // Storage full or blocked: the next playback just guesses again.
  }
}

/** hls.js settings for where Auto starts. */
export function hlsStartConfig(): Partial<HlsConfig> {
  const bps = savedBandwidth()
  return {
    abrEwmaDefaultEstimateMax: FIRST_GUESS_MAX_BPS,
    // Left unset with nothing saved: hls.js then guesses from the first
    // rendition, which it only does while this is unconfigured.
    ...(bps !== undefined && { abrEwmaDefaultEstimate: bps }),
  }
}
