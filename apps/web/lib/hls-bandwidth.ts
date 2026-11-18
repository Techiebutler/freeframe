import type { HlsConfig } from 'hls.js'

/**
 * Where playback starts in Auto for a returning viewer.
 *
 * Before a segment has loaded, hls.js guesses the bandwidth from the first
 * rendition in the manifest (our largest), capped at `abrEwmaDefaultEstimateMax`
 * -- 5 Mbps by default. Our rungs are constant-quality encodes, and the
 * manifest's BANDWIDTH is their peak segment bitrate, so whenever a rung peaks
 * above 5 Mbps playback starts below it and climbs once segments have been
 * measured, even on a link that could carry it from the start.
 *
 * A viewer who has played something here recently starts from the bandwidth
 * measured then. Nothing else changes: a first-time viewer gets hls.js's own
 * capped guess, as before. Raising that cap was tried and made first frames
 * several times slower on ordinary links, because the first segment then
 * loads at the top rung, and hls.js can't abandon it: its emergency switch
 * down doesn't run until the video has data to play (`readyState` > 0), so an
 * over-high first segment always downloads in full.
 */

const STORAGE_KEY = 'ff-hls-bandwidth'

/** A measurement older than this says little about the connection now. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * Above any rung we encode (1080p peaks around 15 Mbps), so a higher saved
 * value buys nothing. Holding it here keeps a measurement from a very fast
 * network from counting as proof that the next one is fast too.
 */
const MAX_SAVED_BPS = 20_000_000

/** Clock skew allowed before a saved time counts as being in the future. */
const FUTURE_SKEW_MS = 60 * 1000

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
    // A time ahead of now came from a wrong clock, so its age is unknown.
    if (saved.at > now + FUTURE_SKEW_MS) return undefined
    if (now - saved.at > MAX_AGE_MS) return undefined
    return Math.min(saved.bps, MAX_SAVED_BPS)
  } catch {
    return undefined
  }
}

export function saveBandwidth(bps: number, now = Date.now()): void {
  if (!isUsable(bps)) return
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ bps: Math.min(bps, MAX_SAVED_BPS), at: now }),
    )
  } catch {
    // Storage full or blocked: the next playback just guesses again.
  }
}

/** hls.js settings for where Auto starts. */
export function hlsStartConfig(): Partial<HlsConfig> {
  const bps = savedBandwidth()
  // Left unset with nothing saved: hls.js then makes its own first guess from
  // the first rendition, which it only does while this is unconfigured.
  return bps !== undefined ? { abrEwmaDefaultEstimate: bps } : {}
}
