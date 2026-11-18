/**
 * A tab-wide pool of part-upload slots.
 *
 * Every part attempt of every uploading file takes a slot here before it asks
 * the server for a presigned URL, so the number of parts in flight across the
 * whole tab never exceeds `size`, however many files are active. The module is
 * plain data and promises: no store, no React, no timers.
 *
 * How a part attempt uses it (this is the contract the part upload loop relies on):
 *
 *   const release = await budget.acquire(fileKey, signal, 'fresh')   // before presign
 *   try {
 *     // presign, PUT, record the ETag
 *   } catch (err) {
 *     if (retryable) budget.sleeping(fileKey)   // the part is about to back off
 *     throw err
 *   } finally {
 *     release()                                  // the slot is free during the backoff
 *   }
 *   // ... sleep, with no slot held ...
 *   budget.woke(fileKey)                         // always, even if the sleep was aborted
 *   const again = await budget.acquire(fileKey, signal, 'retry')   // no await before this
 *
 * and, when the file's runner ends for any reason, `budget.forget(fileKey)`:
 * only once every part attempt of the run has settled and every sleeper has
 * woken or been aborted, never at the first error while siblings are still in
 * flight, because `forget` counts the slots it takes back as free.
 *
 * `fileKey` names one run of a file, not the file: a caller passes a key unique
 * to the run (for example `${rowId}:${runCounter}`), so that a late call from a
 * run that has ended can never land on a new run of the same row.
 *
 * Words used below:
 *
 * - dispatched: slots of one file that have been granted and whose release
 *   function has not been called yet. It rises at the moment of the grant (not
 *   when the caller's `await` resumes) and falls at the first call of the
 *   release function. A request still waiting for a grant is not dispatched.
 *   A part asleep in backoff is not dispatched either: it released its slot.
 * - sleeping: parts of one file between `sleeping(fileKey)` and `woke(fileKey)`.
 *   The two calls must be balanced one for one; they hold no slot.
 *
 * Granting, whenever a slot is free:
 *
 * 1. Candidates are the waiting requests that may be granted: any `retry`, and a
 *    `fresh` one only while its file's dispatched + sleeping < size. That cap is
 *    the anti-storm rule. When storage is failing, every part fails and sleeps; if
 *    each freed slot went to a new part of the same file, that part would fail
 *    too and join the retry ladder, and the whole file would end up in backoff
 *    at once. A file with a part asleep may not refill the slot it left; the
 *    slot goes to another file or stays free until the sleeper comes back.
 * 2. Among the candidates, the file with the lowest rank goes first (a file
 *    that was never ranked comes after every ranked file, and equal ranks go in
 *    the order the files were first seen by this budget).
 * 3. Within that file, a `retry` goes before a `fresh` request, and requests of
 *    the same kind go first come, first served.
 *
 * Grants are made on a microtask, not inside the call that freed the slot. Two
 * orders matter all the same, because a caller's own `await` lets that
 * microtask run in between:
 *
 * - call `sleeping()` before `release()`, inside the attempt that holds the
 *   slot (the `catch` and `finally` above). A `sleeping()` made a microtask
 *   after the release, in some outer catch, comes after a grant pass that has
 *   already handed the slot to a fresh part of the same file: the storm the
 *   cap exists to stop;
 * - call `woke()` and `acquire(..., 'retry')` back to back, with no `await`
 *   between, so the pass that sees the sleeper gone also sees its retry
 *   waiting, and a fresh part of the same file cannot slip in ahead of it.
 *
 * Each pass scans every waiter once per grant, which is fine for tens of files.
 */

export type PartKind = 'fresh' | 'retry'

export interface PartBudget {
  readonly size: number
  /** Resolves with a release function once a slot is granted; rejects with AbortError when `signal` aborts first. */
  acquire(fileKey: string, signal: AbortSignal, kind: PartKind): Promise<() => void>
  /** A part of `fileKey` went to sleep in backoff (its slot was released) / woke from it. */
  sleeping(fileKey: string): void
  woke(fileKey: string): void
  /** Lower rank = served first. Called by the queue when a file becomes active. */
  setRank(fileKey: string, rank: number): void
  /**
   * Drop all state for a file whose runner ended; rejects its waiters with AbortError.
   * Its slots still dispatched count as free from here, so call it only once
   * every attempt of the run has settled.
   */
  forget(fileKey: string): void
}

interface Grant {
  released: boolean
}

interface FileState {
  rank: number
  /** When this budget first saw the file; breaks ties between equal ranks. */
  order: number
  dispatched: number
  sleeping: number
  grants: Set<Grant>
}

interface Waiter {
  file: FileState
  kind: PartKind
  signal: AbortSignal
  resolve: (release: () => void) => void
  reject: (reason: unknown) => void
  onAbort: () => void
}

function abortError(): DOMException {
  return new DOMException('Upload cancelled', 'AbortError')
}

export function createPartBudget(size: number): PartBudget {
  if (!Number.isInteger(size) || size < 1) {
    // A budget of 0 would leave every upload waiting for a slot that never comes.
    throw new RangeError(`Part budget size must be a whole number of at least 1, got ${size}`)
  }

  const files = new Map<string, FileState>()
  /** In the order requests were made, so a scan that keeps the first of equals is first come, first served. */
  let waiters: Waiter[] = []
  let inUse = 0
  let nextFileOrder = 0
  let passScheduled = false

  function stateFor(fileKey: string): FileState {
    let file = files.get(fileKey)
    if (!file) {
      file = {
        rank: Number.POSITIVE_INFINITY,
        order: nextFileOrder++,
        dispatched: 0,
        sleeping: 0,
        grants: new Set(),
      }
      files.set(fileKey, file)
    }
    return file
  }

  function grantable(waiter: Waiter): boolean {
    if (waiter.kind === 'retry') return true
    return waiter.file.dispatched + waiter.file.sleeping < size
  }

  /** True when `a` should be served before `b`. Equal requests keep their queue order. */
  function precedes(a: Waiter, b: Waiter): boolean {
    if (a.file !== b.file) {
      if (a.file.rank !== b.file.rank) return a.file.rank < b.file.rank
      return a.file.order < b.file.order
    }
    return a.kind === 'retry' && b.kind === 'fresh'
  }

  function pickNext(): Waiter | null {
    let best: Waiter | null = null
    for (const waiter of waiters) {
      if (!grantable(waiter)) continue
      if (best === null || precedes(waiter, best)) best = waiter
    }
    return best
  }

  function grant(waiter: Waiter) {
    waiters = waiters.filter((w) => w !== waiter)
    waiter.signal.removeEventListener('abort', waiter.onAbort)
    const { file } = waiter
    const slot: Grant = { released: false }
    file.grants.add(slot)
    file.dispatched += 1
    inUse += 1
    waiter.resolve(() => {
      // Idempotent, and a no-op for a slot `forget` already took back.
      if (slot.released) return
      slot.released = true
      file.grants.delete(slot)
      file.dispatched -= 1
      inUse -= 1
      schedulePass()
    })
  }

  function runPass() {
    passScheduled = false
    while (inUse < size) {
      const next = pickNext()
      if (!next) return
      grant(next)
    }
  }

  function schedulePass() {
    if (passScheduled) return
    passScheduled = true
    // A promise job rather than queueMicrotask: test fake timers leave it alone.
    void Promise.resolve().then(runPass)
  }

  return {
    size,

    acquire(fileKey, signal, kind) {
      if (signal.aborted) return Promise.reject(abortError())
      const file = stateFor(fileKey)
      return new Promise<() => void>((resolve, reject) => {
        const waiter: Waiter = {
          file,
          kind,
          signal,
          resolve,
          reject,
          onAbort: () => {
            waiters = waiters.filter((w) => w !== waiter)
            reject(abortError())
          },
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
        waiters.push(waiter)
        schedulePass()
      })
    },

    sleeping(fileKey) {
      // A runner that already ended must not leave a count behind for a later run of the key.
      const file = files.get(fileKey)
      if (file) file.sleeping += 1
    },

    woke(fileKey) {
      const file = files.get(fileKey)
      if (!file) return
      file.sleeping = Math.max(0, file.sleeping - 1)
      // The cap may have lifted for a fresh request that was waiting with a slot free.
      schedulePass()
    },

    setRank(fileKey, rank) {
      stateFor(fileKey).rank = Number.isNaN(rank) ? Number.POSITIVE_INFINITY : rank
    },

    forget(fileKey) {
      const file = files.get(fileKey)
      if (!file) return
      files.delete(fileKey)
      const mine = waiters.filter((w) => w.file === file)
      waiters = waiters.filter((w) => w.file !== file)
      for (const waiter of mine) {
        waiter.signal.removeEventListener('abort', waiter.onAbort)
        waiter.reject(abortError())
      }
      file.grants.forEach((slot) => {
        slot.released = true
      })
      inUse -= file.dispatched
      file.grants.clear()
      file.dispatched = 0
      schedulePass()
    },
  }
}
