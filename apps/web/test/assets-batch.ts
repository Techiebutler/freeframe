/**
 * `GET /assets/batch`, as the uploads panel's poll asks it, for tests that mock
 * `api.get`.
 */

/** The asset ids a `GET /assets/batch` path asks about, or null for any other path. */
export function batchIds(path: string): string[] | null {
  const [base, query] = path.split('?')
  if (base !== '/assets/batch') return null
  return new URLSearchParams(query).getAll('ids')
}

/**
 * An `api.get` answer for a poll: the batch gets back whichever of `assets` it
 * asked about, and any other path gets `other`.
 */
export function answerBatch<T extends { id: string }>(assets: T[], other: unknown = []) {
  return async (path: string) => {
    const ids = batchIds(path)
    return ids === null ? other : assets.filter((a) => ids.includes(a.id))
  }
}
