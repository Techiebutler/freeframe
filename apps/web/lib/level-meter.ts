export const METER_COLUMNS = 28
export const METER_ROWS = 5

/** RMS of time-domain byte samples (128 = silence), 0..1 and eased up so normal speech fills the meter. */
export function rmsLevel(samples: Uint8Array): number {
  if (!samples.length) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) { const v = (samples[i] - 128) / 128; sum += v * v }
  return Math.min(1, Math.sqrt(sum / samples.length) * 2.2)
}
export const dotsLit = (level: number, rows = METER_ROWS): number => Math.max(1, Math.min(rows, Math.round(level * rows)))
export const pushLevel = (history: number[], level: number): number[] => [...history, level].slice(-METER_COLUMNS)
