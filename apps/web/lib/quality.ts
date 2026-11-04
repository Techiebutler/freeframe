/** Index of the highest rendition up to `maxHeight` (default 1080p); -1 (auto) when the manifest has no usable heights. */
export function pickDefaultLevel(levels: { index: number; height?: number }[], maxHeight = 1080): number {
  const known = levels.filter(l => (l.height ?? 0) > 0)
  if (!known.length) return -1
  const within = known.filter(l => l.height! <= maxHeight)
  const pool = within.length ? within : known
  const best = pool.reduce((a, b) => ((within.length ? b.height! > a.height! : b.height! < a.height!) ? b : a))
  return best.index
}
