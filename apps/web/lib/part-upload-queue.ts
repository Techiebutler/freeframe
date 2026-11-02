/**
 * Shared per-screen queue: separate file drops still share the same uplink budget.
 * A slot is the uplink, so work hands it back through `release` as soon as its bytes are up;
 * whatever it still waits for after that (the uploader's details) must not hold other files back.
 */
export function createUploadQueue(limit = 2) {
  let active = 0
  const waiting: (() => void)[] = []
  const free = () => { const next = waiting.shift(); if (next) next(); else active-- }
  return async <T>(work: (release: () => void) => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>(resolve => waiting.push(resolve))
    else active++
    let held = true
    const release = () => { if (held) { held = false; free() } }
    try { return await work(release) }
    finally { release() }
  }
}
