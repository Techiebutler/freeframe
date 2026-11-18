/**
 * Measures an upload's transfer rate from the byte counts it reports.
 *
 * What it is fed is "bytes the browser has handed over so far", which is not a
 * running total of transfer: a part that fails gives its bytes back, and the
 * retry sends them again. So only increases are added up, and a drop is taken
 * as the start of a re-send rather than as negative progress.
 */

export interface UploadRate {
  bytesPerSecond: number
  /** Null while nothing is moving, when no estimate can be made. */
  secondsLeft: number | null
}

/** How far back the rate looks. Long enough to smooth over a part finishing,
 *  short enough to follow a connection that slows down. */
const WINDOW_MS = 5_000
/** No figure before this much data: the first progress events come in a burst
 *  as the browser fills its socket buffers, and would read as a spike. */
const MIN_SPAN_MS = 1_000
const PUBLISH_MS = 1_000

export interface SpeedMeter {
  /** The upload's current "bytes sent" count, as `uploadAllParts` reports it. */
  sample: (sentBytes: number) => void
  /** Ends the measurement and withdraws the figure. Safe to call twice. */
  stop: () => void
}

export function createSpeedMeter(
  totalBytes: number,
  publish: (rate: UploadRate | null) => void,
): SpeedMeter {
  // The first sample is a baseline, not progress: on a resume it already
  // counts every part the storage backend held before this transfer began.
  let lastSent: number | null = null
  let sent = 0
  let transferred = 0
  const samples: Array<{ at: number; transferred: number }> = []
  let stopped = false

  const rate = (): UploadRate | null => {
    const now = Date.now()
    while (samples.length > 1 && now - samples[0].at > WINDOW_MS) samples.shift()
    if (samples.length === 0) return null
    const first = samples[0]
    // Measured up to now, not to the last sample, so a transfer that has
    // stalled falls towards zero instead of holding its last figure.
    const span = now - first.at
    if (span < MIN_SPAN_MS) return null
    // Whole bytes: formatBytes has no unit for a fraction of one.
    const bytesPerSecond = Math.round(((transferred - first.transferred) * 1000) / span)
    const remaining = Math.max(0, totalBytes - sent)
    return {
      bytesPerSecond,
      secondsLeft: bytesPerSecond > 0 ? remaining / bytesPerSecond : null,
    }
  }

  const timer = setInterval(() => {
    if (!stopped) publish(rate())
  }, PUBLISH_MS)

  return {
    sample(sentBytes: number) {
      if (stopped) return
      if (lastSent !== null && sentBytes > lastSent) transferred += sentBytes - lastSent
      lastSent = sentBytes
      sent = sentBytes
      samples.push({ at: Date.now(), transferred })
    },
    stop() {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      publish(null)
    },
  }
}
