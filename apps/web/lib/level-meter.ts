export const METER_COLUMNS = 28
export const METER_ROWS = 7 // odd: there is a centre row

/** RMS of time-domain byte samples (128 = silence), 0..1 and eased up so normal speech fills the meter. */
export function rmsLevel(samples: Uint8Array): number {
  if (!samples.length) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) { const v = (samples[i] - 128) / 128; sum += v * v }
  return Math.min(1, Math.sqrt(sum / samples.length) * 2.2)
}
export const dotsLit = (level: number, rows = METER_ROWS): number => Math.max(1, Math.min(rows, Math.round(level * rows)))
export const pushLevel = (history: number[], level: number): number[] => [...history, level].slice(-METER_COLUMNS)

/** Which dots of a column are lit: silence is the centre dot alone, louder sound grows the column up and down in equal steps. */
export function columnRows(level: number, rows = METER_ROWS): boolean[] {
  const n = rows % 2 === 0 ? rows + 1 : rows
  const mid = (n - 1) / 2
  const reach = Math.round(Math.max(0, Math.min(1, level)) * mid)
  return Array.from({ length: n }, (_, r) => Math.abs(r - mid) <= reach)
}

// ── Perceptual level and dot look ─────────────────────────────────────────────

export const ATTACK_MS = 30
export const RELEASE_MS = 250
const DB_FLOOR = -50
const DB_CEIL = -14

/** RMS of float samples (-1..1). */
export function rmsFloat(samples: Float32Array): number {
  if (!samples.length) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / samples.length)
}

/** RMS -> dBFS, -50 dB .. -14 dB mapped to 0 .. 1 (phone mics rarely get near 0 dBFS): ears hear loudness on a log scale, so normal speech fills 60 to 90% of the height. */
export function dbLevel(rms: number): number {
  if (!(rms > 0)) return 0
  const db = 20 * Math.log10(rms)
  return Math.max(0, Math.min(1, (db - DB_FLOOR) / (DB_CEIL - DB_FLOOR)))
}

/** One step of a fast-attack, slow-release follower: syllables punch up and decay. */
export function smoothLevel(prev: number, target: number, dtMs: number, attackMs = ATTACK_MS, releaseMs = RELEASE_MS): number {
  const t = Math.max(0, Math.min(1, target))
  if (dtMs <= 0) return prev
  const tau = t > prev ? attackMs : releaseMs
  const next = prev + (t - prev) * (1 - Math.exp(-dtMs / tau))
  return Math.max(0, Math.min(1, next))
}

/** How one dot of a column looks: on/off, size, brightness, and whether it is a peak (brand orange). Symmetric around the centre row. */
export function dotStyle(level: number, row: number, rows = METER_ROWS): { on: boolean; scale: number; opacity: number; peak: boolean } {
  const lv = Math.max(0, Math.min(1, level))
  const mid = (rows - 1) / 2
  const d = Math.abs(row - mid)
  const reach = lv * mid
  const k = Math.max(0, Math.min(1, reach - d + 1))
  const on = k > 0
  return {
    on,
    scale: Math.round((0.55 + 0.45 * lv) * k * 1000) / 1000 || (on ? 0.55 : 0),
    opacity: on ? Math.round((0.28 + 0.72 * lv) * (0.4 + 0.6 * k) * 1000) / 1000 : 0.14,
    peak: on && lv > 0.9 && k > 0.8,
  }
}
