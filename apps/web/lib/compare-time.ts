/** Pure time math for the version-compare overlay. All times in seconds. */

export interface SideTiming {
  /** Leading padding before this side starts on the shared timeline (>= 0). */
  offset: number
  /** Media duration of this side. */
  duration: number
}

export function tMax(a: SideTiming, b: SideTiming): number {
  return Math.max(a.offset + a.duration, b.offset + b.duration)
}

/** Transport time -> this side's local media time (holds first/last frame). */
export function localTime(t: number, side: SideTiming): number {
  return Math.min(Math.max(t - side.offset, 0), side.duration)
}

export function sideNotStarted(t: number, side: SideTiming): boolean {
  return t < side.offset
}

export function sideEnded(t: number, side: SideTiming): boolean {
  return t >= side.offset + side.duration
}

/** Position of a comment marker on the shared scrubber, clamped to [0, 1]. */
export function markerPosition(tc: number, side: SideTiming, total: number): number {
  if (total <= 0) return 0
  return Math.min(Math.max((tc + side.offset) / total, 0), 1)
}

/** Seconds per frame; 0.04 (~25fps) when fps is unknown (pre-backfill files). */
export function frameStep(fps?: number | null): number {
  return fps && fps > 0 ? 1 / fps : 0.04
}

/** True when a slaved video has drifted past the correction threshold. */
export function driftedBeyond(expected: number, actual: number, thresholdSec = 0.05): boolean {
  return Math.abs(actual - expected) > thresholdSec
}

export function parseOffsetParam(v: string | null): number {
  const n = v === null ? NaN : Number.parseFloat(v)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

/** Compare button gating: video/image asset with >= 2 ready versions. */
export function canCompare(
  assetType: string,
  versions: Array<{ processing_status: string }>,
): boolean {
  if (assetType !== 'video' && assetType !== 'image') return false
  return versions.filter((v) => v.processing_status === 'ready').length >= 2
}
