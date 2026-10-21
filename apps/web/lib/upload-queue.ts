/**
 * The tab-wide upload queue: which waiting file starts next, how many may run,
 * and what happens when storage or the connection stops answering. It is plain
 * data and plain functions: no store, no React, no timers, no clock. The store
 * owns the files and the timers; this module only answers "who is next".
 *
 * How the store drives it:
 *
 *   queue.enqueue(entries, 'back' | 'next')                  // a drop, or a Resume
 *   for (const id of queue.nextToStart(activeInfos, partBudget.size)) {
 *     const rank = queue.markStarted(id)                     // the file left the waiting list
 *     partBudget.setRank(id, rank)
 *     // ... run it
 *   }
 *
 * Order. Waiting entries start in list order. `'back'` appends. `'next'` goes
 * ahead of every waiting entry but behind the `'next'` entries that are still
 * waiting, so a run of Resumes starts first come, first served. The order is
 * decided by position in the list and by two counters, never by time, so a
 * clock that jumps backwards cannot reorder anything.
 *
 * Two sequence numbers, never mixed:
 *
 * - `queueSeq` is handed out at enqueue. It is the order the panel shows rows
 *   in within a drop, and it says nothing about who starts first.
 * - `startSeq` is handed out by `markStarted`. It is the part-budget rank (lower
 *   is served first), so a Resume that started early keeps its priority for
 *   part slots over older files that only started after it, even though its
 *   `queueSeq` is higher.
 *
 * The start rule. `nextToStart` walks the waiting list in order and, before it
 * chooses each entry, requires both of:
 *
 * - (active files + files already chosen) < MAX_ACTIVE_FILES, and
 * - parts in use < budget.
 *
 * "Parts in use" adds up what each file is expected to need:
 *
 * - an active file counts its `unfinishedParts`;
 * - an active file that is still initiating or resuming (`'unknown'`), one whose
 *   `unfinishedParts` is not a finite number of at least 0 (a corrupt count must
 *   not open the gate), and an entry chosen in this very call, count as the whole
 *   budget, because until the
 *   server answers there is no telling how many parts the file will want. The one
 *   exception is a file of at most SINGLE_PART_BYTES: it is always one part, so
 *   it counts 1.
 *
 * When both hold the entry is chosen and its count is added; when either fails
 * the walk stops (a later, smaller entry never jumps ahead of an earlier one).
 * The walk can choose at most MAX_ACTIVE_FILES entries, so the cost does not
 * depend on how many entries are waiting.
 *
 * The hold. When storage or the connection fails, one file becomes the probe:
 * `hold.begin(probeId, reason, retryAfterMs)`. While a hold is in effect
 * `nextToStart` returns nothing, so the failure is not multiplied across new
 * files. The probe is tracked only by `hold.probeId`: it is neither in the
 * waiting list nor counted as active while it waits for its retry, and the
 * store's retry re-runs it directly. Entries that arrive meanwhile, `'next'`
 * ones included, sit in the waiting list and start after the hold ends. There is
 * one probe at a time: when a second row fails while a probe is in charge,
 * `hold.begin` answers false and the caller puts that row back with
 * `enqueue([entry], 'next')`, so it runs again right after the probe succeeds. If the
 * probe is cancelled, `hold.handOff()` takes the first waiting entry out of the
 * list and makes it the new probe, with the delay the cancelled probe was
 * waiting on; when nothing is waiting it returns null and the caller calls
 * `hold.end()`. `end()` is the caller's: `handOff` never ends a hold itself.
 *
 * Backoff. `hold.nextDelayMs()` is the wait before the probe's next try:
 *
 * - a retry-after passed to `begin` is used for the first try, clamped to
 *   HOLD_MAX_DELAY_MS; a negative or NaN value counts as absent;
 * - otherwise the first wait is HOLD_INITIAL_DELAY_MS;
 * - every later wait doubles the previous one, never below HOLD_INITIAL_DELAY_MS
 *   (so a retry-after of 0 does not become a retry storm), up to HOLD_MAX_DELAY_MS.
 *
 * With no retry-after the waits are 2 s, 4 s, 8 s, 16 s, 32 s, 60 s, 60 s, ...
 * With a retry-after of 5 s they are 5 s, 10 s, 20 s, 40 s, 60 s, 60 s, ...
 * A later `begin` for the same probe with a fresh retry-after replaces the next
 * wait and the doubling carries on from it.
 */

export type QueueKind = 'new' | 'resume'

export interface QueueEntry {
  id: string
  kind: QueueKind
  sizeBytes: number
  ownerId: string
}

/** 'unknown' = Initiating/Resuming before its answer. */
export interface ActiveInfo {
  id: string
  sizeBytes: number
  /** A value that is not a finite number of at least 0 is counted like 'unknown'. */
  unfinishedParts: number | 'unknown'
}

export interface UploadQueue {
  /**
   * Entries already waiting, and the current probe, are skipped. Enqueueing an id again (a retry, a
   * row sent back to the queue) gives it a new queueSeq, so its position in the panel moves.
   */
  enqueue(entries: QueueEntry[], where: 'back' | 'next'): void
  /** A not-yet-started entry; false if absent. */
  remove(id: string): boolean
  /** Ids to start now, in order, given the current active set. Pure: does not mutate. */
  nextToStart(active: readonly ActiveInfo[], budget: number): string[]
  /**
   * Leaves the waiting list and returns its startSeq: monotonic, assigned here, the PartBudget rank.
   * Call it once per run: a second call returns a later rank, and handing that to the PartBudget
   * would demote the runner. An id that is not waiting (a handed-off probe, say) still gets one.
   */
  markStarted(id: string): number
  /** Assigned at enqueue, monotonic; panel order within a drop only. -1 for an id never enqueued. */
  queueSeq(id: string): number
  /** A snapshot, in start order. */
  waiting(): readonly QueueEntry[]
  hold: {
    readonly probeId: string | null
    readonly reason: 'connection' | 'storage' | null
    /**
     * Starts a hold with `probeId` as its probe; if it already is the probe, updates the reason and,
     * when given, the retry-after for its next wait. Returns true when `probeId` is now (or still) the
     * probe. Returns false, and changes nothing, when another probe is in charge: the caller must then
     * `enqueue([entry], 'next')` that row, so it runs again right after the probe succeeds (first come,
     * first served with the other nexts), and must NOT call `nextDelayMs()` for it or show a hold
     * reason on it.
     */
    begin(probeId: string, reason: 'connection' | 'storage', retryAfterMs: number | undefined): boolean
    /** Backoff for the probe: honours retryAfter, doubles otherwise, cap 60_000. */
    nextDelayMs(): number
    end(): void
    /** Probe cancelled: hand the role and current delay to the next waiting entry; returns its id or null. */
    handOff(): string | null
  }
}

export const MAX_ACTIVE_FILES = 3
export const SINGLE_PART_BYTES = 5 * 1024 * 1024
/** First wait of a hold that was given no retry-after, and the floor for every doubling. */
export const HOLD_INITIAL_DELAY_MS = 2_000
/** No wait between two tries of the probe is longer than this, whatever the server asks. */
export const HOLD_MAX_DELAY_MS = 60_000

/** A retry-after the server gave, made safe to use as a wait: undefined when it is unusable. */
function usableRetryAfter(retryAfterMs: number | undefined): number | undefined {
  if (typeof retryAfterMs !== 'number' || Number.isNaN(retryAfterMs) || retryAfterMs < 0) return undefined
  return Math.min(retryAfterMs, HOLD_MAX_DELAY_MS)
}

export function createUploadQueue(): UploadQueue {
  /** Waiting entries in start order. */
  const list: QueueEntry[] = []
  const waitingIds = new Set<string>()
  /**
   * Waiting entries added with 'next'. They are always the first entries of `list`, so a new
   * 'next' goes in at index `nextIds.size`.
   */
  const nextIds = new Set<string>()
  /** The latest queueSeq of every id ever enqueued; a small number per id for the life of the queue. */
  const queueSeqs = new Map<string, number>()
  let queueCounter = 0
  let startCounter = 0

  let probeId: string | null = null
  let reason: 'connection' | 'storage' | null = null
  /** A wait that is due on the next `nextDelayMs()`: a retry-after, or the delay handed down by `handOff`. */
  let pendingDelay: number | undefined
  /** The wait `nextDelayMs()` returned last. */
  let lastDelay: number | undefined

  function removeWaiting(id: string): boolean {
    if (!waitingIds.has(id)) return false
    const index = list.findIndex((e) => e.id === id)
    if (index >= 0) list.splice(index, 1)
    waitingIds.delete(id)
    nextIds.delete(id)
    return true
  }

  function clearBackoff() {
    pendingDelay = undefined
    lastDelay = undefined
  }

  const hold: UploadQueue['hold'] = {
    get probeId() {
      return probeId
    },
    get reason() {
      return reason
    },

    begin(id, why, retryAfterMs) {
      if (probeId !== null && probeId !== id) return false
      probeId = id
      reason = why
      removeWaiting(id)
      const given = usableRetryAfter(retryAfterMs)
      if (given !== undefined) pendingDelay = given
      return true
    },

    nextDelayMs() {
      // No hold, no ladder: answering must not leave a rung behind for the next hold to inherit.
      if (probeId === null) return HOLD_INITIAL_DELAY_MS
      let delay: number
      if (pendingDelay !== undefined) {
        delay = pendingDelay
        pendingDelay = undefined
      } else if (lastDelay === undefined) {
        delay = HOLD_INITIAL_DELAY_MS
      } else {
        delay = Math.min(HOLD_MAX_DELAY_MS, Math.max(lastDelay * 2, HOLD_INITIAL_DELAY_MS))
      }
      lastDelay = delay
      return delay
    },

    end() {
      probeId = null
      reason = null
      clearBackoff()
    },

    handOff() {
      if (probeId === null || list.length === 0) return null
      const next = list[0]
      removeWaiting(next.id)
      probeId = next.id
      // The new probe waits what the old one was waiting, unless a newer retry-after is already due.
      if (pendingDelay === undefined && lastDelay !== undefined) pendingDelay = lastDelay
      return next.id
    },
  }

  return {
    enqueue(entries, where) {
      const accepted: QueueEntry[] = []
      for (const e of entries) {
        if (waitingIds.has(e.id) || e.id === probeId) continue
        waitingIds.add(e.id)
        queueSeqs.set(e.id, ++queueCounter)
        accepted.push(e)
      }
      if (accepted.length === 0) return

      if (where === 'back') {
        for (const e of accepted) list.push(e)
        return
      }
      const behindNexts = list.splice(nextIds.size)
      for (const e of accepted) {
        list.push(e)
        nextIds.add(e.id)
      }
      for (const e of behindNexts) list.push(e)
    },

    remove(id) {
      return removeWaiting(id)
    },

    nextToStart(active, budget) {
      if (probeId !== null) return []
      // A budget that is not a number of at least 1 can never hold a part; NaN would defeat every comparison below.
      if (!(budget >= 1)) return []

      let partsInUse = 0
      for (const a of active) {
        const parts = a.unfinishedParts
        if (typeof parts === 'number' && Number.isFinite(parts) && parts >= 0) partsInUse += parts
        else partsInUse += a.sizeBytes <= SINGLE_PART_BYTES ? 1 : budget
      }

      const chosen: string[] = []
      for (const e of list) {
        if (active.length + chosen.length >= MAX_ACTIVE_FILES || partsInUse >= budget) break
        chosen.push(e.id)
        partsInUse += e.sizeBytes <= SINGLE_PART_BYTES ? 1 : budget
      }
      return chosen
    },

    markStarted(id) {
      removeWaiting(id)
      return ++startCounter
    },

    queueSeq(id) {
      return queueSeqs.get(id) ?? -1
    },

    waiting() {
      return list.slice()
    },

    hold,
  }
}
