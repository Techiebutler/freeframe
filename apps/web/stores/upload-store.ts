import { create, type StateCreator } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { mutate as globalMutate } from 'swr'
import { api, ApiError } from '@/lib/api'
import { createSpeedMeter, type SpeedMeter } from '@/lib/upload-speed'
import { createPartBudget, type PartBudget } from '@/lib/upload-budget'
import { createUploadQueue, type ActiveInfo, type QueueEntry } from '@/lib/upload-queue'
import { classifyInitiateError, type InitiateOutcome } from '@/lib/upload-initiate-outcome'
import { useUploadSpeedStore } from './upload-speed-store'
import type { AssetResponse } from '@/types'

const CHUNK_SIZE = 10 * 1024 * 1024 // 10 MB
const HISTORY_PAGE_SIZE = 20
const PART_MAX_ATTEMPTS = 8 // per part, including the first try
const PART_RETRY_BASE_MS = 2000 // 2s, 4s, 8s … ≈254s of total tolerance per part

/**
 * How often a tab that is transferring says so, and how long that is believed.
 *
 * Rows are persisted to `localStorage`, which every tab of the origin shares, so
 * a second tab reads the first tab's in-flight rows. Whether one of them is
 * still moving is not something the row itself can say -- it says `uploading`
 * whether or not anything is behind it -- so the tab doing the work stamps it.
 *
 * The window is long against the beat on purpose. A hidden tab's timers are
 * throttled to about once a minute, and a transfer in a background tab is the
 * ordinary case rather than the odd one. The cost of the long window is only
 * that a tab that has really gone takes this long to be believed gone.
 */
const HEARTBEAT_MS = 15_000
export const LIVE_WINDOW_MS = 150_000

const TAB_KEY = 'ff-upload-tab'
const newTabId = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`

/**
 * Which tab this is, kept across a reload of the same tab.
 *
 * A reload is the case the persisted rows exist for: the transfer died with
 * the page, and the row has to come back as `interrupted` straight away, not
 * after a window of looking live. `sessionStorage` survives a reload and is not
 * shared between tabs, which is exactly that distinction.
 *
 * Except that "Duplicate tab" copies `sessionStorage`, so the copy starts out
 * with the original's id and would take its live rows for its own. The copy
 * asks on a channel whether the id is taken; the original answers, and the
 * copy picks a new one.
 */
let tabId: string = (() => {
  if (typeof window === 'undefined') return newTabId()
  try {
    const kept = window.sessionStorage.getItem(TAB_KEY)
    if (kept) return kept
    const fresh = newTabId()
    window.sessionStorage.setItem(TAB_KEY, fresh)
    return fresh
  } catch {
    return newTabId()
  }
})()

export function currentTabId(): string {
  return tabId
}

/**
 * Where a row read out of storage stands, judged from this tab.
 *
 * Nothing in this tab is pushing bytes for it, whatever it said when it was
 * written. If this tab wrote it, the transfer died with the page and the row is
 * `interrupted`. If another tab wrote it and stamped it recently, that tab is
 * very likely still sending, and the row is `elsewhere`: shown, but offering
 * nothing, because Discard would destroy the transfer and a second Resume would
 * write the same part numbers into one multipart upload.
 */
function standingOfStoredRow(f: UploadFile, now: number): UploadFile {
  if (f.status !== 'uploading' && f.status !== 'elsewhere') return f
  // No version to come back to: the transfer broke before initiate answered.
  // Only a row this browser was sending can be in that state. An `elsewhere`
  // row may have come from history, which never carries an upload id -- the
  // resume asks the server for it -- and failing that row turned an upload
  // still running on another device into a dead "Failed" on the next load.
  if (!f.versionId || (f.status === 'uploading' && !f.uploadId)) {
    return { ...f, status: 'failed', error: 'Upload interrupted' }
  }
  const beating = f.heartbeatAt !== undefined && now - f.heartbeatAt < LIVE_WINDOW_MS
  const held = f.elsewhereUntil !== undefined && now < f.elsewhereUntil
  if ((f.ownerTab !== currentTabId() && beating) || held) {
    return { ...f, status: 'elsewhere', error: undefined }
  }
  return { ...f, status: 'interrupted', error: undefined }
}

/** The heartbeat the row carries in shared storage right now, as the tab doing
 *  the work last wrote it -- not the copy this tab read when it loaded. */
function storedHeartbeat(fileId: string): number | undefined {
  try {
    const raw = window.localStorage.getItem('ff-uploads')
    const files = (JSON.parse(raw ?? '{}') as { state?: { files?: UploadFile[] } }).state?.files
    return files?.find((f) => f.id === fileId)?.heartbeatAt
  } catch {
    return undefined
  }
}

/**
 * How long after this tab's own last heartbeat its row still counts as its
 * own business, rather than something the server has to be asked about.
 *
 * Two heartbeats. Long enough to cover the case it exists for -- this tab was
 * sending a moment ago and the transfer dropped -- and short enough that it
 * has passed by the time anyone could plausibly have picked the upload up
 * somewhere else.
 */
const OWN_STOP_GRACE_MS = HEARTBEAT_MS * 2

/**
 * Whether the server has seen this upload move too recently to be touched from
 * here.
 *
 * The exemption is for an upload this tab is responsible for, and that is a
 * fact about this tab's own memory rather than about a persisted id. Keying it
 * on `ownerTab` alone was wrong in a way that costs data: a tab whose transfer
 * died still carries its own id on the row, so when the user picked the upload
 * up on their phone, the laptop tab -- never reloaded -- went on offering
 * Discard and the server had no guard of its own. The multipart upload was
 * aborted, the objects deleted, the version soft-deleted, and the phone then
 * got a 403 on its next presign.
 *
 * So: this tab is sending it now, or it stopped sending it just now. Both are
 * read from this browser's own clock (`heartbeatAt` is written here, by the
 * tab doing the work), so no server timestamp is compared against a local one
 * and the skew in `liveUntil` is not made worse.
 *
 * What this cannot do is tell "my own transfer dropped five seconds ago" from
 * "my transfer dropped and another device has already taken over", because
 * from one snapshot those are the same row. The grace above is where that
 * trade sits: inside it the user keeps control of an upload that has just
 * stopped under them, outside it the server decides.
 */
function activeElsewhere(
  row: UploadFile,
  info: ResumeInfo,
  now: number,
  attempt?: AbortController,
): boolean {
  // `attempt` is the caller's own controller, where the caller is the one
  // trying to start a transfer: `resumeUpload` registers it before it asks the
  // server anything, so without excluding it here every resume would count as
  // this tab already sending and the guard would never refuse.
  if (isSendingHere(row.id, attempt)) return false
  const ownAndRecent =
    row.ownerTab === currentTabId() &&
    row.heartbeatAt !== undefined &&
    now - row.heartbeatAt < OWN_STOP_GRACE_MS
  if (ownAndRecent) return false
  const until = liveUntil(info.last_activity_at)
  return until !== undefined && now < until
}

/** Until when an upload that last moved at `lastActivity` counts as running. */
function liveUntil(lastActivity: string | null | undefined): number | undefined {
  if (!lastActivity) return undefined
  const at = Date.parse(lastActivity)
  return Number.isNaN(at) ? undefined : at + LIVE_WINDOW_MS
}

const ELSEWHERE_MESSAGE = 'Still uploading in another tab or on another device'

/**
 * Parts in flight across the whole tab, however many files are uploading.
 *
 * Five hides the per-part presign round-trip without opening more sockets than
 * a browser grants one origin (HTTP/1.1 allows six, and the SSE stream holds
 * one of them when the object store shares the API's origin).
 *
 * Operator-tunable because a storage backend may throttle concurrent part PUTs
 * and there is no way for us to know which one an instance points at. Read at
 * build time like every other `NEXT_PUBLIC_*` value here, so changing it needs
 * a web image rebuild — the same upgrade path as `NEXT_PUBLIC_API_URL`.
 */
const UPLOAD_CONCURRENCY = (() => {
  const configured = Number(process.env.NEXT_PUBLIC_UPLOAD_CONCURRENCY)
  if (!Number.isFinite(configured) || configured < 1) return 5
  return Math.min(Math.floor(configured), 16)
})()

/**
 * The slots every part of every upload in this tab takes turns on. One budget,
 * so three files uploading at once send as many parts between them as one file
 * did alone, rather than three times as many.
 */
let partBudget = createPartBudget(UPLOAD_CONCURRENCY)

let partRuns = 0
/**
 * The key one run of an upload goes by in `partBudget`. A row can run more than
 * once -- a resume after a stop -- and a call left over from the earlier run
 * must not count against the later one, so the key names the run, not the row.
 */
function partRunKey(rowId: string): string {
  partRuns += 1
  return `${rowId}:${partRuns}`
}

/**
 * A failure that repeating cannot fix — a 4xx from the storage backend means the
 * request itself was rejected (bad signature, expired policy, wrong length), and
 * every further attempt is rejected identically.
 */
interface PartUploadError extends Error {
  permanent?: boolean
}

/** A cancellation, as opposed to a failure: the caller reports the two differently. */
function isAbortError(err: unknown): err is DOMException {
  return err instanceof DOMException && err.name === 'AbortError'
}

/** 408 Request Timeout and 429 Too Many Requests explicitly invite a later attempt. */
function isPermanentStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429
}

/**
 * Uploads one part exactly once. Returns its ETag. The caller holds a budget
 * slot for the whole call.
 */
async function uploadPartOnce(
  file: File,
  s3Key: string,
  uploadId: string,
  partNumber: number,
  controller: AbortController,
  chunkSize: number,
  onBytes: (sent: number) => void,
): Promise<string> {
  // A slot can be granted in the same turn as the upload stops: the grant is
  // delivered on a microtask, and the abort that came first cannot take it back.
  // Asking for a URL then would be a round trip for a part nothing will send.
  if (controller.signal.aborted) {
    throw new DOMException(`Part ${partNumber} cancelled`, 'AbortError')
  }

  const start = (partNumber - 1) * chunkSize
  const chunk = file.slice(start, Math.min(start + chunkSize, file.size))

  // The presigned URL is fetched per attempt, not cached across retries:
  // presign_upload_part expires after an hour and a large upload can outlive
  // that, so a URL obtained before a long backoff may already be dead.
  const { presigned_url } = await api.post<{ presigned_url: string }>('/upload/presign-part', {
    s3_key: s3Key,
    upload_id: uploadId,
    part_number: partNumber,
  })

  return putPart(presigned_url, chunk, partNumber, controller.signal, onBytes)
}

/**
 * The ETag of a part PUT, or '' when the bucket's CORS rule does not expose it.
 *
 * Read from the full header list rather than with getResponseHeader('ETag'),
 * which logs "Refused to get unsafe header" for every part when the header is
 * not exposed. docs/deployment.md allows such a bucket, and fetch was silent.
 */
function etagOf(xhr: XMLHttpRequest): string {
  for (const line of xhr.getAllResponseHeaders().split('\r\n')) {
    const colon = line.indexOf(':')
    if (colon > 0 && line.slice(0, colon).trim().toLowerCase() === 'etag') {
      return line.slice(colon + 1).trim()
    }
  }
  return ''
}

/**
 * PUTs one part and resolves with its ETag.
 *
 * XMLHttpRequest rather than fetch because fetch has no upload progress, and a
 * part is 10 MB: on a slow uplink that is minutes in which the bar could not
 * move. Everything else is kept to the shape the fetch call had, because the
 * callers depend on it:
 *
 * - a cancel rejects with an `AbortError` DOMException, which is how
 *   `uploadPart` and `uploadAllParts` tell a cancel from a failure;
 * - a network error, a timeout or an abort the browser started itself rejects
 *   with a plain error, which is retried, as fetch's TypeError was;
 * - a non-2xx rejects with `permanent` set for a 4xx, so a status of 0 never
 *   counts as one;
 * - no Content-Type is set. `chunk` is a slice taken without a type, so the
 *   browser sends none, and the presigned URL signs none.
 *
 * The pool signal lives for the whole upload, so the abort listener is removed
 * again whichever way the request settles.
 */
function putPart(
  url: string,
  chunk: Blob,
  partNumber: number,
  signal: AbortSignal,
  onBytes: (sent: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException(`Part ${partNumber} cancelled`, 'AbortError'))
      return
    }

    const xhr = new XMLHttpRequest()
    const abort = () => xhr.abort()
    const settle = () => signal.removeEventListener('abort', abort)

    xhr.upload.onprogress = (event) => onBytes(event.loaded)
    xhr.onload = () => {
      settle()
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(etagOf(xhr))
        return
      }
      const error: PartUploadError = new Error(`Part ${partNumber} failed: ${xhr.statusText}`)
      error.permanent = isPermanentStatus(xhr.status)
      reject(error)
    }
    xhr.onerror = () => {
      settle()
      reject(new TypeError(`Part ${partNumber} failed: network error`))
    }
    // No timeout is set, as fetch had none: a 10 MB part on a slow uplink can
    // take minutes and must not be cut off. The handler stays so that one set
    // later, here or by a browser, fails the part retryably instead of leaving
    // the promise unsettled, since a timeout fires neither load nor error.
    xhr.ontimeout = () => {
      settle()
      reject(new TypeError(`Part ${partNumber} failed: timed out`))
    }
    // Not every abort is a cancel. A browser aborts an in-flight XHR on its
    // own, on window.stop() or when Stop or Esc cancels a pending navigation,
    // where fetch rejected with a TypeError and the part was retried. Only an
    // abort of the signal may come out as an AbortError: the caller takes that
    // for a user cancel and discards every part the backend holds.
    xhr.onabort = () => {
      settle()
      reject(
        signal.aborted
          ? new DOMException(`Part ${partNumber} cancelled`, 'AbortError')
          : new TypeError(`Part ${partNumber} failed: aborted`),
      )
    }

    xhr.open('PUT', url)
    signal.addEventListener('abort', abort, { once: true })
    xhr.send(chunk)
  })
}

/** Where a part takes its slots, and who hears that it got its first one. */
interface PartSlots {
  budget: PartBudget
  fileKey: string
  /** Runs once, when the part's first attempt is granted a slot. */
  onFirstGrant?: () => void
}

/**
 * Uploads one part, retrying with exponential backoff and jitter.
 *
 * A multi-gigabyte file is several hundred requests. Previously the first
 * non-OK response aborted the entire upload without a second attempt, so a
 * single transient 500/503 from the storage backend — or a brief network drop —
 * discarded everything already transferred.
 *
 * Only failures that can plausibly recover are repeated: network errors and 5xx.
 * A 4xx is thrown straight through, because retrying it eight times over four
 * minutes would delay the error message without ever changing the outcome.
 *
 * Jitter keeps concurrent uploads from retrying in lockstep. A user-initiated
 * cancel is never retried.
 *
 * Every attempt holds a slot of the tab-wide budget from before its presign
 * until it settles, and none is held during the backoff between attempts: a
 * part waiting out a 2-minute rung would otherwise keep a slot that another
 * file could be sending on. The order of the calls is the budget's contract
 * (see lib/upload-budget.ts), and two of them are easy to break by moving a
 * line, so they are written where they have to be:
 *
 * - `sleeping()` is called in the `catch` and `release()` in the `finally` of
 *   the same attempt, so the part is counted asleep before its slot is free.
 *   The budget grants on a microtask; a part that gave its slot back and said
 *   it was asleep only a microtask later would let the grant pass hand the slot
 *   to a fresh part of the same file, which is the retry storm the budget's cap
 *   exists to stop.
 * - `woke()` and the retry's `acquire()` follow each other with no `await`
 *   between, so the pass sees the retry waiting when it sees the sleeper gone.
 *   `woke()` runs however the sleep ended, a cancel included, because every
 *   `sleeping()` has to be matched.
 */
async function uploadPart(
  file: File,
  s3Key: string,
  uploadId: string,
  partNumber: number,
  controller: AbortController,
  chunkSize: number,
  onBytes: (sent: number) => void,
  slots: PartSlots,
): Promise<string> {
  const { budget, fileKey } = slots
  const signal = controller.signal
  let lastError: unknown

  // Rejects with an AbortError if the upload stops while this waits.
  let release = await budget.acquire(fileKey, signal, 'fresh')

  for (let attempt = 1; ; attempt++) {
    try {
      // Inside the attempt, so the `finally` below gives the slot back even if
      // the hook throws.
      if (attempt === 1) slots.onFirstGrant?.()
      return await uploadPartOnce(file, s3Key, uploadId, partNumber, controller, chunkSize, onBytes)
    } catch (err) {
      // The next attempt sends the part from its first byte again, so what
      // this one got across no longer counts.
      onBytes(0)
      if (signal.aborted) throw err
      if (isAbortError(err)) throw err
      if ((err as PartUploadError)?.permanent) throw err
      if (attempt === PART_MAX_ATTEMPTS) throw err

      lastError = err
      // Before `release()` below, in this same synchronous run. See above.
      budget.sleeping(fileKey)
    } finally {
      release()
    }

    const delay = PART_RETRY_BASE_MS * 2 ** (attempt - 1) + Math.random() * 250
    await delayUnlessAborted(delay, signal)
    budget.woke(fileKey)
    // Waking early means the upload is over — the user cancelled, or a sibling
    // part failed for good. Another attempt would spend a presign round-trip
    // and 10 MB of uplink on a part nothing will ever complete.
    if (signal.aborted) throw lastError
    release = await budget.acquire(fileKey, signal, 'retry')
  }
}

/**
 * Sleeps for `ms`, or until `signal` aborts, whichever comes first.
 *
 * A plain `setTimeout` cannot be interrupted, so a worker part-way up the
 * backoff ladder would keep sleeping long after the upload it belongs to was
 * lost — up to 128s on the last rung, while the user waits on an error that has
 * already happened.
 */
function delayUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    let timer: ReturnType<typeof setTimeout>
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
  })
}

/**
 * Uploads every part of a multipart upload and returns the part list for
 * /upload/complete. Exported for tests.
 *
 * Several parts are in flight at once rather than strictly one after the
 * other. A single PUT does not saturate a connection — most of a sequential
 * upload is spent waiting on round-trips — so a handful in flight multiplies
 * throughput on exactly the long-haul links where large uploads hurt most.
 *
 * How many is not this upload's to decide. Every attempt at a part takes a slot
 * from `opts.budget`, which every upload in the tab shares, before it asks for
 * a presigned URL, and gives it back when the attempt settles; the budget also
 * decides which file a free slot goes to (see lib/upload-budget.ts). This
 * function keeps up to `budget.size` of its parts asking for their first slot,
 * enough to take every slot the budget offers it at once, without queueing a
 * request for each of the thousands of parts a large file can have.
 *
 * `opts.fileKey` names this run to the budget. It must be unique to the run,
 * not just to the row -- the store uses `${rowId}:${n}`, with `n` counting runs
 * -- so that a late call from a run that has ended can never land on a new run
 * of the same row. The key is forgotten when this returns, for whatever reason,
 * and not before: only once every attempt has settled and every part asleep in
 * backoff has woken, because forgetting a key treats its slots as free, and a
 * part still waiting on its presign is still using one.
 *
 * Ordering is preserved by writing each result to its own index: parts finish
 * out of order, but `parts` is indexed by part number, and progress counts
 * bytes sent rather than the highest number seen.
 *
 * When a part finally fails the whole upload is lost, so the other parts are
 * stopped rather than left to run their own retry ladders out: every error after
 * the first is discarded anyway, so cancelling them costs nothing and turns a
 * four-minute wait for an error that has already happened into an immediate one.
 *
 * `opts.alreadyHeld` names parts the storage backend is already holding, from a
 * previous attempt at this same upload. They are skipped and counted as done.
 * `opts.chunkSize` is the size that upload was cut on, which the server pins per
 * upload — a resume must place part N at exactly the byte range the parts
 * already in the bucket were cut on, and that is not necessarily the range
 * today's CHUNK_SIZE would give.
 *
 * `opts.onPartDone` runs once for every part that finishes. It is the
 * heartbeat from #312, not a progress report: `onProgress` only fires when the
 * percent moves, and on a large file that can be many minutes apart, longer
 * than the window another tab gives a row before it offers Discard.
 *
 * `opts.onUnfinished` hears how many parts are not finished yet: waiting for a
 * slot, in flight, or asleep in backoff. Held parts are finished. It is called
 * once at the start and then each time a part finishes, which is every time
 * the count changes; the queue reads it to judge how much of the budget this
 * upload can still use.
 *
 * `opts.onAllSent` runs when the browser has handed over the file's last byte.
 * That is not the end of the transfer: each part still waits for storage to
 * answer for it, after writing it, and behind a buffering proxy after
 * forwarding it too. The bar is already at 95 by then, so this is where the
 * wait the user sees begins.
 *
 * `opts.onResend` undoes it: a part that fails after every byte was sent gives
 * its bytes back, and its retry is a transfer again, one a user may cancel.
 * `onAllSent` runs again once the retry has sent them.
 *
 * `opts.onBytes` hears every byte count, not just whole-percent moves, for the
 * speed meter. It must not write to this store: see `useUploadSpeedStore`.
 */
export async function uploadAllParts(
  file: File,
  s3Key: string,
  uploadId: string,
  controller: AbortController,
  onProgress: (percent: number) => void,
  opts: {
    budget: PartBudget
    fileKey: string
    chunkSize?: number
    alreadyHeld?: readonly number[]
    onPartDone?: () => void
    onUnfinished?: (n: number) => void
    onAllSent?: () => void
    onResend?: () => void
    onBytes?: (sent: number) => void
  },
): Promise<Array<{ PartNumber: number; ETag: string }>> {
  const { budget, fileKey } = opts
  const chunkSize = opts.chunkSize ?? CHUNK_SIZE
  const held = new Set(opts.alreadyHeld ?? [])
  const totalChunks = Math.ceil(file.size / chunkSize)
  const parts: Array<{ PartNumber: number; ETag: string }> = new Array(totalChunks)
  const toSend: number[] = []
  for (let partNumber = 1; partNumber <= totalChunks; partNumber++) {
    if (!held.has(partNumber)) toSend.push(partNumber)
  }

  // Parts run against their own signal, so a part failing for good can stop
  // its siblings without being mistaken for a user cancel: `controller` keeps
  // meaning "the user pressed Cancel", `pool` means "stop, for any reason".
  // A part waiting for a slot is turned away by the same signal.
  const pool = new AbortController()
  const stopPool = () => pool.abort()
  if (controller.signal.aborted) stopPool()
  else controller.signal.addEventListener('abort', stopPool, { once: true })

  // Parts the backend already holds are done before this starts, and progress
  // has to say so: a resume that reports 0% and then jumps is indistinguishable
  // from one that is re-sending everything. They are a set, not a prefix, so
  // the last part -- shorter than the rest -- can be among them, and each is
  // counted at its own length.
  const partLength = (partNumber: number) =>
    Math.min(chunkSize, file.size - (partNumber - 1) * chunkSize)
  let doneBytes = 0
  held.forEach((partNumber) => {
    doneBytes += partLength(partNumber)
  })

  // Progress is counted in bytes, so the bar moves while a part is in flight
  // rather than once per finished part, which on a slow uplink is minutes.
  // Every call writes the row through `persist` into localStorage and
  // re-renders the panel, so it is only made when the whole percent changes:
  // at most 96 times an upload, however many progress events there are. It
  // never goes back down either. A part that fails gives up its bytes, and the
  // bar waits at its mark until the retry has caught up, rather than jumping
  // back. And it never passes 95, which the panel would print as it is.
  const inFlightBytes = new Map<number, number>()
  // Every caller sets the row to 0 before this starts, so 0 is never reported
  // again: a part that fails before its first progress event would otherwise
  // write a 0 into a row that has just stopped, and stamp its heartbeat.
  let reported = 0
  let allSent = false
  const report = () => {
    let sent = doneBytes
    inFlightBytes.forEach((bytes) => {
      sent += bytes
    })
    // Before onBytes, so the drop is the first count a restarted meter sees.
    if (allSent && sent < file.size) {
      allSent = false
      opts.onResend?.()
    }
    opts.onBytes?.(sent)
    if (!allSent && sent >= file.size) {
      allSent = true
      opts.onAllSent?.()
    }
    const percent = Math.min(95, Math.round((sent / file.size) * 95))
    if (percent <= reported) return
    reported = percent
    onProgress(percent)
  }
  if (doneBytes > 0) report()

  let unfinished = toSend.length
  opts.onUnfinished?.(unfinished)

  // The first error a part raised, and every error a part raised: a flag
  // rather than `firstError !== null`, so a falsy rejection still counts.
  let failed = false
  let firstError: unknown = null
  const raised: unknown[] = []

  let nextToSend = 0
  /** Parts asking for their first slot. */
  let waitingFirst = 0
  /** Parts started and not yet settled, in any state: waiting, in flight, asleep. */
  let running = 0
  let allSettled!: () => void
  const settled = new Promise<void>((resolve) => {
    allSettled = resolve
  })

  // Tops the parts asking for a first slot back up to the budget's size, and
  // says when there is nothing left to wait for. A part starts only here, so
  // with none running after this, none ever will be.
  function startParts() {
    while (
      !pool.signal.aborted &&
      !failed &&
      waitingFirst < budget.size &&
      nextToSend < toSend.length
    ) {
      void sendPart(toSend[nextToSend++])
    }
    if (running === 0) allSettled()
  }

  async function sendPart(partNumber: number): Promise<void> {
    running += 1
    waitingFirst += 1
    let granted = false
    try {
      const etag = await uploadPart(
        file, s3Key, uploadId, partNumber, pool, chunkSize,
        (sent) => {
          inFlightBytes.set(partNumber, sent)
          report()
        },
        {
          budget,
          fileKey,
          onFirstGrant: () => {
            granted = true
            waitingFirst -= 1
            startParts()
          },
        },
      )
      parts[partNumber - 1] = { PartNumber: partNumber, ETag: etag }
      inFlightBytes.delete(partNumber)
      doneBytes += partLength(partNumber)
      unfinished -= 1
      opts.onUnfinished?.(unfinished)
      opts.onPartDone?.()
      report()
    } catch (err) {
      if (!granted) {
        waitingFirst -= 1
        // Turned away while it waited for its first slot, because the upload
        // had already stopped. Nothing of it was sent, and the reason is
        // whatever stopped the upload, not this.
        if (isAbortError(err)) return
      }
      raised.push(err)
      if (!failed) {
        failed = true
        firstError = err
      }
      stopPool()
    } finally {
      running -= 1
      startParts()
    }
  }

  try {
    startParts()
    await settled

    // A user cancel outranks whatever errors it caused in the parts it
    // interrupted, so it is resolved before `firstError` rather than after —
    // otherwise cancelling shows the row flipping from Cancelled back to Failed.
    // The abort error a part actually raised is preferred over a synthesized
    // one, so its reason survives; the fallback covers a cancel that landed
    // while no part was in flight to reject.
    if (controller.signal.aborted) {
      throw raised.find(isAbortError) ?? new DOMException('Upload cancelled', 'AbortError')
    }
    if (failed) throw firstError

    // Dense, because a skipped part leaves its slot empty and a sparse array
    // serialises as nulls. On a resume this is therefore what was sent now, not
    // what the upload consists of -- the caller has to know the difference, and
    // the one that does sends no list at all.
    return parts.filter(Boolean)
  } finally {
    controller.signal.removeEventListener('abort', stopPool)
    // Every part has settled by now (`settled` waits for the last of them), so
    // no slot of this run is still in use and no part is still asleep.
    budget.forget(fileKey)
    // And none will be sent: a run that stopped part-way leaves parts it never
    // finished, but it is not going to use the budget for them. Said, so the
    // queue does not go on counting them while the row settles.
    if (unfinished !== 0) {
      unfinished = 0
      opts.onUnfinished?.(0)
    }
  }
}

/**
 * Keeps the machine awake while an upload is running.
 *
 * An upload lives entirely in the browser tab. If the machine suspends
 * mid-transfer the loop pushing chunks dies with it — and unlike a failed part,
 * nothing runs afterwards: the `catch` that calls `/upload/abort` never
 * executes, so the version is left at `processing_status = 'uploading'` and
 * looks in the UI like a stalled transcode rather than a dead upload.
 *
 * Best-effort by design: without HTTPS, in low-power mode, or in a browser
 * without the API there is no lock — none of which is a reason to refuse the
 * upload.
 *
 * Reference-counted because several uploads can run at once; the lock is only
 * released when the last one finishes.
 */
let wakeLock: WakeLockSentinel | null = null
let wakeLockPending: Promise<void> | null = null
let wakeLockHolders = 0

function acquireWakeLock(): void {
  // Dropping several files starts several uploads in the same tick, so this
  // runs again long before the first request has resolved. Without the pending
  // guard each one would request its own sentinel and only the last would be
  // tracked, leaving the rest held for the life of the page.
  if (wakeLock || wakeLockPending) return
  if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return

  wakeLockPending = (async () => {
    try {
      const sentinel = await navigator.wakeLock.request('screen')
      if (wakeLockHolders === 0) {
        // Every upload finished while the request was still in flight.
        void sentinel.release().catch(() => {})
        return
      }
      wakeLock = sentinel
      // The browser drops the lock by itself when the tab is hidden.
      sentinel.addEventListener('release', () => {
        if (wakeLock === sentinel) wakeLock = null
      })
    } catch {
      // Not having a wake lock is not an upload error.
    } finally {
      wakeLockPending = null
    }
  })()
}

/** Exported for tests. */
export function retainWakeLock(): void {
  wakeLockHolders += 1
  acquireWakeLock()
}

/** Exported for tests. */
export function releaseWakeLock(): void {
  wakeLockHolders = Math.max(0, wakeLockHolders - 1)
  if (wakeLockHolders > 0) return
  const held = wakeLock
  wakeLock = null
  void held?.release().catch(() => {})
}

// Coming back to the foreground needs a fresh lock: the one dropped on hide is
// dead and cannot be reused.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && wakeLockHolders > 0) acquireWakeLock()
  })
}

/**
 * Where a row stands. The queue's states (spec "Row lifecycle") are encoded as a
 * status plus flags, so every place that already branches on status keeps
 * working for the states it knew:
 *
 * - `queued`: added, never initiated, nothing on the server. In memory only:
 *   it holds the `File`, which a reload cannot bring back. With `holdReason` it
 *   is the hold's probe, waiting to try its initiate again.
 * - `starting`: its turn has come and an initiate is out (no `versionId` yet),
 *   or, with `resuming`, a resume whose turn has come and whose `/parts` call
 *   is out.
 * - `interrupted` with `queuedResume`: the user clicked Resume and it waits for
 *   its turn. Saved as plain `interrupted`. With `holdReason` it is the probe.
 * - `uploading`: sending, or with `finalizing`, waiting on storage.
 * - `failed` with `failedBeforeStart`: refused before anything was created.
 *   `retryable` offers Retry while this tab still holds the `File`.
 *
 * `interrupted` is a transfer that stopped without the user asking it to.
 *
 * It is deliberately not `failed`: the multipart upload is still open and every
 * part already transferred is still held by the storage backend, so the work is
 * recoverable rather than lost. It is deliberately not `uploading` either --
 * nothing is running, so a row in this state must not offer Cancel, must not
 * count towards the active badge, and must not sit in the Active tab claiming
 * progress it is not making.
 */
export type UploadStatus =
  | 'queued' | 'starting' | 'uploading' | 'processing' | 'complete' | 'failed' | 'cancelled'
  | 'interrupted' | 'elsewhere'

export interface UploadFile {
  id: string
  fileName: string
  fileSize: number
  fileType: string
  projectId: string
  projectName?: string
  assetName: string
  progress: number
  processingProgress: number
  status: UploadStatus
  error?: string
  assetId?: string
  versionId?: string
  uploadId?: string
  /**
   * The storage key of the multipart upload, recorded wherever `uploadId` is.
   *
   * `/upload/abort` needs it beside the upload id, and Discard used to learn
   * both from `/upload/{version}/parts` -- which answers 404 once the version
   * is gone, at exactly the moment the multipart upload still needs aborting.
   * Absent on rows written before it was recorded and on rows rebuilt from
   * history, which never see it.
   */
  s3Key?: string
  createdAt: number // timestamp for grouping
  /**
   * The account that added the row: the access token's `sub` when it was
   * added. Views and starts are scoped to it (spec goal 9); until that lands
   * it is recorded by tests only.
   */
  ownerId?: string
  /** The tab that is transferring this row, see `currentTabId`. */
  ownerTab?: string
  /** When that tab last said it still is, see `HEARTBEAT_MS`. */
  heartbeatAt?: number
  /** Set when the server refused to let this tab touch the upload because it
   *  had just moved. Kept `elsewhere` at least until then, since a transfer on
   *  another device leaves no heartbeat in this browser's storage. */
  elsewhereUntil?: number
  /**
   * True for a row rebuilt from `/me/assets` rather than started here.
   *
   * These rows are the user's own assets now that the panel asks with
   * `filter=owned`, but being an asset's creator is not proof of the `editor`
   * role that renaming needs. That filter carries no membership term at all, so
   * an asset comes back long after the role that created it was demoted or the
   * membership removed, and the rename would answer 403. A row this session
   * started is proof, because starting it required the same role.
   */
  fromHistory?: boolean
  /** Why a rename that happened without the user watching was refused. The
   *  interactive path reports upwards through `renameUpload`'s return value;
   *  the correction sent during `/upload/initiate`'s round trip has nobody to
   *  return to, so it leaves the reason here. */
  renameError?: string
  /**
   * The browser has sent every byte and is waiting on storage: first for it to
   * answer for the last parts, then for `/upload/complete`, where it assembles
   * them. Either can take minutes with the bar at 95. The status stays
   * `uploading` -- recovery, the heartbeat and the Active tab all treat this as
   * the transfer it still is -- and the panel reads this only alongside that
   * status, so a stale value on any other is inert.
   */
  finalizing?: boolean
  /** One per drop or pick, and per Resume or Retry. A counter, never a time. */
  dropSeq?: number
  /** The row's place in the queue when it was last enqueued; orders rows within a drop. */
  queueSeq?: number
  /** On the hold's probe row only: why the queue is waiting. Never saved. */
  holdReason?: 'connection' | 'storage'
  /** An `interrupted` row the user resumed, waiting for its turn. Never saved. */
  queuedResume?: true
  /** A `starting` row that is a resume rather than a new upload. Never saved. */
  resuming?: true
  /** Refused before anything was created on the server. */
  failedBeforeStart?: true
  /** A `failedBeforeStart` row this tab can start again. Never saved: the `File` is not. */
  retryable?: boolean
}

/** POST /upload/initiate and POST /assets/{id}/versions — both answer with this.
 *
 *  `chunk_size_bytes` is the size the server records against the upload, so it
 *  is the size the browser has to cut on: `_pinned_chunk_size` trusts that
 *  record over the parts actually held, and a browser cutting on a constant of
 *  its own would make every held part the wrong size the first time the two
 *  disagree -- stranding exactly the upload the pinning exists to rescue. */
interface InitiateResponse {
  upload_id: string
  s3_key: string
  asset_id: string
  version_id: string
  chunk_size_bytes: number
}

type VersionInitiateResponse = InitiateResponse

/** GET /upload/{version_id}/parts — where to carry on, and what is already there. */
interface ResumeInfo {
  state: 'resumable' | 'assembled'
  upload_id: string
  s3_key: string
  asset_id: string
  version_id: string
  chunk_size_bytes: number
  file_size_bytes: number
  original_filename: string
  mime_type: string
  held_part_numbers: number[]
  /** When the upload last moved before this request; see `activeElsewhere`. */
  last_activity_at?: string | null
}

/**
 * A refusal the server will repeat, as opposed to one worth trying again.
 *
 * 404 and 409 from the resume endpoint are statements about the upload itself --
 * the version is gone, or it is no longer `uploading` -- so the row is finished
 * and offering another resume would send the user round the same loop. Anything
 * else (a 503, a dropped connection) says nothing about the upload, and the row
 * stays resumable.
 */
function isFinalRefusal(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 404 || err.status === 409)
}

const ASSET_GONE_MESSAGE = 'This file is no longer available.'

/**
 * An answer to `GET /assets/{id}` that will not change.
 *
 * An asset in the trash answers 404, and one in a deleted project answers 403
 * (since v1.19.0). Both say the file is not there for this user, which no amount
 * of asking again alters, so the row is finished. Anything else -- a dropped
 * connection, a 5xx -- says nothing about the asset and is simply asked again.
 */
function isAssetGone(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 403 || err.status === 404)
}

// AbortControllers for cancellation
const abortControllers: Record<string, AbortController> = {}

/**
 * Whether this tab is pushing bytes for this row right now.
 *
 * The one signal that cannot be stale. Every transfer removes its controller in
 * a `finally`, so the entry exists for exactly as long as the transfer does --
 * unlike `ownerTab`, which a row keeps carrying after the transfer behind it
 * has died, and across a reload that killed it.
 */
function isSendingHere(fileId: string, except?: AbortController): boolean {
  const running = abortControllers[fileId]
  return running !== undefined && running !== except
}

/** Claims a row for this tab and keeps stamping it until the returned stop is
 *  called. Written through the store, so it reaches shared storage the same way
 *  progress does.
 *
 *  Every finished part stamps the row as well, through `onPartDone` rather
 *  than progress, which only reports when the percent moves. A hidden tab's
 *  timers are held to about once a minute while its requests are not, so on
 *  the timer alone the stamp fell behind the transfer, and another tab took a
 *  live upload for a stopped one before the server did. */
function beatFor(
  update: (patch: Partial<UploadFile>) => void,
): () => void {
  update({ ownerTab: currentTabId(), heartbeatAt: Date.now() })
  const timer = setInterval(() => update({ heartbeatAt: Date.now() }), HEARTBEAT_MS)
  return () => clearInterval(timer)
}

/** Measures a row's transfer rate into `useUploadSpeedStore`, which the panel
 *  shows beside its percentage. Stopped once every byte is sent, and whenever
 *  the transfer ends. */
function meterFor(fileId: string, totalBytes: number): SpeedMeter {
  return createSpeedMeter(totalBytes, (rate) => useUploadSpeedStore.getState().setRate(fileId, rate))
}

/**
 * The `uploadAllParts` hooks that keep a row's `finalizing` flag and speed
 * figure in step with its transfer: both end when the last byte is sent, and
 * both come back if a part has to be sent again. `stop` ends the measurement
 * for good, whichever way the transfer ended.
 */
function transferWatch(
  fileId: string,
  totalBytes: number,
  patchRow: (patch: Partial<UploadFile>) => void,
) {
  let meter = meterFor(fileId, totalBytes)
  return {
    onBytes: (sent: number) => meter.sample(sent),
    onAllSent: () => {
      meter.stop()
      patchRow({ finalizing: true })
    },
    onResend: () => {
      meter.stop()
      meter = meterFor(fileId, totalBytes)
      patchRow({ finalizing: false })
    },
    stop: () => meter.stop(),
  }
}

interface UploadStore {
  files: UploadFile[]
  /** Bumped when something here has changed an asset's versions server-side in
   *  a way no transcode event announces -- today, discarding an upload, which
   *  deletes the version. A screen showing a version list watches this so it
   *  does not go on offering a version that is gone.
   *
   *  A counter and not a timestamp: two discards inside one millisecond are a
   *  real thing, and `Date.now()` reports them as no change at all. */
  versionsRevision: number
  panelOpen: boolean
  historyLoaded: boolean
  historyHasMore: boolean
  historyLoading: boolean
  historySkip: number
  setPanelOpen: (open: boolean) => void
  togglePanel: () => void
  /**
   * Adds one file to the back of the upload queue as its own drop, and returns
   * its row id. It starts at its turn, which is at once only when the start
   * rule allows it at that moment.
   */
  startUpload: (file: File, projectId: string, assetName: string, projectName?: string, folderId?: string | null) => string
  /** The same for a new version of `assetId`. */
  startVersionUpload: (file: File, assetId: string, assetName: string, projectId: string, projectName?: string) => string
  /** Adds a whole drop or pick, in order, as one drop. Returns the row ids in the order given. */
  startUploads: (items: Array<{ file: File; assetName: string }>, projectId: string, projectName?: string, folderId?: string | null) => string[]
  /** Queues an interrupted row to carry on with `file`, ahead of every file not yet started. */
  resumeUpload: (fileId: string, file: File) => void
  /** Resolves to a message saying why nothing was discarded, or null. */
  discardUpload: (fileId: string) => Promise<string | null>
  cancelUpload: (fileId: string) => void
  /** Rename the asset a row is uploading. Resolves to an error message, or
   *  null when the new name is stored. */
  renameUpload: (fileId: string, name: string) => Promise<string | null>
  removeFile: (fileId: string) => void
  clearCompleted: () => void
  fetchHistory: () => Promise<void>
  fetchMoreHistory: () => Promise<void>
  // SSE-driven processing updates
  updateProcessingProgress: (assetId: string, percent: number) => void
  markProcessingComplete: (assetId: string) => void
  markProcessingFailed: (assetId: string, error: string) => void
  // Fallback poll: re-check processing items from backend (catches missed SSE events)
  refreshProcessingItems: () => Promise<void>
}

/**
 * A server-reported `processing_status` as this panel should render it.
 *
 * `uploading` maps to `interrupted` rather than to `uploading` because of who is
 * asking. Every caller here is reconciling a row against the server, and a
 * transfer this tab is currently running is never among them: the live row is
 * driven by its own upload loop, and `mergeHistoryAssets` skips assets already
 * in the list. So a version the server still has at `uploading` is one nobody in
 * this tab is pushing bytes to — which is the definition of `interrupted`, and
 * why such a row used to sit at "Uploading 100%" indefinitely.
 */
function mapProcessingStatus(status: string): UploadStatus {
  switch (status) {
    case 'uploading': return 'interrupted'
    case 'processing': return 'processing'
    case 'ready': return 'complete'
    case 'failed': return 'failed'
    default: return 'complete'
  }
}

/**
 * What the server says this version reached, or null if the completion never landed.
 *
 * A request that throws is not the same thing as an upload that failed: a
 * completion whose response was lost on the way back has already moved the
 * version past `uploading` and started its transcode. Only the server can tell
 * those apart, and it matters, because the caller's other branch marks the
 * upload failed and asks the backend to discard it.
 *
 * Keyed on the version id rather than the status alone. `GET /assets/{id}`
 * reports `_display_version`, which skips `uploading` and `failed`, so an asset
 * whose new version did not land answers with the PREVIOUS version sitting at
 * `ready` — which would read as success for an upload that never happened.
 */
async function completedVersionStatus(
  assetId: string,
  versionId: string,
): Promise<'processing' | 'complete' | null> {
  const asset = await api.get<AssetResponse>(`/assets/${assetId}`).catch(() => null)
  if (!asset?.latest_version || asset.latest_version.id !== versionId) return null
  const status = mapProcessingStatus(asset.latest_version.processing_status)
  return status === 'processing' || status === 'complete' ? status : null
}

/**
 * Finishes an upload whose object is already whole, without the user asking.
 *
 * The case: CompleteMultipartUpload succeeded on the storage side and the status
 * write behind it did not, so the version is still `uploading` with a full-size
 * object sitting at its key. Nothing needs re-sending, only the completion needs
 * repeating -- and `/upload/complete` recognises this and finishes the version.
 *
 * This used to be a side effect of `/upload/abort`, which found the object while
 * discarding the upload and promoted the version on its way past. That abort is
 * gone, so the question is asked directly instead of as a consequence of a
 * destructive call.
 *
 * Returns whether the version was finished. Never throws: this runs from a catch
 * that has already decided what to report.
 */
async function finishAssembledUpload(versionId: string): Promise<boolean> {
  try {
    const info = await api.get<ResumeInfo>(`/upload/${versionId}/parts`)
    if (info.state !== 'assembled') return false
    await api.post('/upload/complete', {
      s3_key: info.s3_key,
      upload_id: info.upload_id,
      asset_id: info.asset_id,
      version_id: info.version_id,
      parts: [],
    })
    return true
  } catch {
    return false
  }
}

function mimeFromAssetType(assetType: string): string {
  switch (assetType) {
    case 'video': return 'video/mp4'
    case 'audio': return 'audio/mpeg'
    case 'image':
    case 'image_carousel': return 'image/jpeg'
    default: return 'application/octet-stream'
  }
}

function mergeHistoryAssets(existing: UploadFile[], assets: AssetResponse[]): UploadFile[] {
  const existingAssetIds = new Set(existing.map((f) => f.assetId).filter(Boolean))
  const newFiles: UploadFile[] = assets
    .filter((a) => a.latest_version && !existingAssetIds.has(a.id))
    .map((a) => {
      const v = a.latest_version!
      const file = v.files?.[0]
      // History is all a browser has for an upload started somewhere else, and
      // an `uploading` version there used to come back as Interrupted even
      // while the other device was still sending it.
      const until = v.processing_status === 'uploading' ? liveUntil(v.last_activity_at) : undefined
      const status = until !== undefined && Date.now() < until
        ? 'elsewhere' as const
        : mapProcessingStatus(v.processing_status)
      return {
        id: `history-${a.id}`,
        fileName: file?.original_filename ?? a.name,
        fileSize: file?.file_size_bytes ?? 0,
        fileType: file?.mime_type ?? mimeFromAssetType(a.asset_type),
        projectId: a.project_id,
        assetName: a.name,
        // How much of the transfer is done is not something the history endpoint
        // knows, and 100 was a guess that happened to be right for every status
        // except the one that mattered: an interrupted upload rendered as
        // "Uploading 100%" forever. Resuming replaces this with the real figure
        // as soon as the parts already held come back from the server.
        progress: status === 'interrupted' || status === 'elsewhere' ? 0 : 100,
        processingProgress: v.processing_status === 'ready' ? 100 : 0,
        status,
        assetId: a.id,
        versionId: v.id,
        createdAt: new Date(v.created_at).getTime(),
        elsewhereUntil: status === 'elsewhere' ? until : undefined,
        fromHistory: true,
      }
    })
  return [...existing, ...newFiles]
}

/** The row stays, saying why. What the server managed before it stopped
 *  answering is not knowable from here, so the version list is told to refetch. */
function reportDiscardFailure(
  set: (fn: (s: UploadStore) => Partial<UploadStore>) => void,
  fileId: string,
  err: unknown,
): string {
  const message = err instanceof Error ? err.message : 'Discard failed'
  set((s) => ({
    files: s.files.map((f) => (f.id === fileId ? { ...f, error: message } : f)),
    versionsRevision: s.versionsRevision + 1,
  }))
  return message
}

/**
 * Throw away an upload the user cancelled, and tell the version list.
 *
 * Sent as a discard. A plain abort records the version as `failed`, which left
 * a red badge in the version switcher for an upload somebody deliberately
 * stopped -- the same thing Discard was fixed for, and cancel is the far more
 * common of the two. The server takes the flag only for a version still
 * `uploading`, so a cancel that lost a race with its own completion is left
 * alone. The switcher refetches on the revision, after the server answers.
 */
async function abortCancelled(
  set: (fn: (s: UploadStore) => Partial<UploadStore>) => void,
  ids: { s3_key: string; upload_id: string; version_id: string },
): Promise<void> {
  await api.post('/upload/abort', { ...ids, discard: true }).catch(() => {})
  set((s) => ({ versionsRevision: s.versionsRevision + 1 }))
}

// ─── The queue ────────────────────────────────────────────────────────────────
//
// Every file dropped, picked or resumed in this tab waits here for its turn, and
// a file's turn is when it may touch the server (spec goals 1-4): until then it
// has no initiate, no heartbeat, no speed meter, no abort controller and no
// wake lock. `lib/upload-queue.ts` decides who is next; this section owns the
// files, the timers and the runs.

/** The tab-wide queue. A `let` only so tests can start from an empty one. */
let queue = createUploadQueue()

/**
 * One running file: from its turn (`startRun`) until its run's `finally`.
 *
 * This, and never a row's status, is the active set the start rule counts
 * (`activeInfos`). A cancelled row says `cancelled` at once while its run is
 * still settling -- an initiate still out may yet have created an upload that
 * has to be thrown away -- and it still uses a place until it has.
 */
interface Runner {
  sizeBytes: number
  /** Parts not yet finished; 'unknown' until the initiate or `/parts` answers. */
  unfinished: number | 'unknown'
}

const runners = new Map<string, Runner>()

/** The `File` behind every row that may still start: queued, held, a queued resume, or refused with Retry. */
const fileRefs = new Map<string, File>()

/** Where a new upload goes: a new asset (in a folder, or the project root), or a new version of an asset. */
type StartTarget = { kind: 'asset'; folderId: string | null } | { kind: 'version'; assetId: string }
const startTargets = new Map<string, StartTarget>()

/**
 * The hold probe's retry. One at a time, since there is one probe; kept here so
 * that whatever takes the probe away (a cancel, a discard) can clear it.
 */
let probeTimer: ReturnType<typeof setTimeout> | null = null

let dropSeqs = 0

/** A row id. Two drops of the same `File` are two rows. */
const newRowId = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`

const REFUSED_MESSAGE = 'The server refused this upload.'

function rowById(id: string): UploadFile | undefined {
  return useUploadStore.getState().files.find((f) => f.id === id)
}

function patchRow(id: string, patch: Partial<UploadFile>): void {
  useUploadStore.setState((s) => ({
    files: s.files.map((f) => (f.id === id ? { ...f, ...patch } : f)),
  }))
}

function activeInfos(): ActiveInfo[] {
  return Array.from(runners.entries(), ([id, r]) => ({ id, sizeBytes: r.sizeBytes, unfinishedParts: r.unfinished }))
}

/** What kind of run a row would start now, or null when it is no longer waiting for one. */
function turnKind(row: UploadFile | undefined): 'new' | 'resume' | null {
  if (!row || !fileRefs.has(row.id)) return null
  if (row.status === 'queued') return 'new'
  if (row.status === 'interrupted' && row.queuedResume && row.versionId) return 'resume'
  return null
}

function queueEntry(row: UploadFile, kind: 'new' | 'resume'): QueueEntry {
  return {
    id: row.id,
    kind,
    sizeBytes: fileRefs.get(row.id)?.size ?? row.fileSize,
    ownerId: row.ownerId ?? '',
  }
}

let pumping = false
let pumpAgain = false

/**
 * Starts every waiting row the start rule allows now. Called on every change
 * that can allow one (spec goal 2): a row added, a part finished, a run ended,
 * an initiate or `/parts` answer, a hold ended.
 *
 * Re-entrant calls are folded into the running one, so a run that ends inside
 * a start cannot start the same row twice.
 */
function pump(): void {
  if (pumping) {
    pumpAgain = true
    return
  }
  pumping = true
  try {
    do {
      pumpAgain = false
      for (;;) {
        const ids = queue.nextToStart(activeInfos(), partBudget.size)
        if (ids.length === 0) break
        let skipped = false
        for (const id of ids) {
          const row = rowById(id)
          const kind = turnKind(row)
          if (!row || !kind) {
            // Gone, cancelled or already changed by something else: it gives up its place.
            queue.remove(id)
            skipped = true
            continue
          }
          startRun(row, kind)
        }
        // A row that gave up its place may have left room for the next one.
        if (!skipped) break
      }
    } while (pumpAgain)
  } finally {
    pumping = false
  }
}

/** A row's turn: it leaves the waiting list, becomes active, and its run begins. */
function startRun(row: UploadFile, kind: 'new' | 'resume'): void {
  const rank = queue.markStarted(row.id)
  const runKey = partRunKey(row.id)
  const runner: Runner = { sizeBytes: fileRefs.get(row.id)?.size ?? row.fileSize, unfinished: 'unknown' }
  runners.set(row.id, runner)
  // On the key `uploadAllParts` will use, so this run's parts are served in turn order.
  partBudget.setRank(runKey, rank)
  // A run settles its own failures and always ends through `endRun`; anything
  // still thrown is a bug, and is reported rather than left unhandled.
  const run = kind === 'new' ? runNew(row.id, runner, runKey) : runResume(row.id, runner, runKey)
  run.catch((err: unknown) => console.error('Upload run ended with an error', err))
}

/** What every run does as it ends, however it ends. */
function endRun(id: string, runner: Runner, runKey: string): void {
  // A run that never reached its parts left only its rank behind.
  partBudget.forget(runKey)
  if (runners.get(id) === runner) runners.delete(id)
  const row = rowById(id)
  const stillWaiting = turnKind(row) !== null || queue.hold.probeId === id
  if (!stillWaiting && !row?.retryable) {
    fileRefs.delete(id)
    startTargets.delete(id)
  }
  pump()
}

function scheduleProbe(id: string): void {
  if (probeTimer !== null) clearTimeout(probeTimer)
  probeTimer = setTimeout(() => {
    probeTimer = null
    retryProbe(id)
  }, queue.hold.nextDelayMs())
}

function retryProbe(id: string): void {
  if (queue.hold.probeId !== id) return
  const row = rowById(id)
  const kind = turnKind(row)
  if (!row || !kind) {
    passOnProbe()
    return
  }
  startRun(row, kind)
}

/**
 * The probe can no longer try (it was cancelled or removed): the role, and the
 * wait it was on, pass to the next waiting row, or the hold ends when none is
 * waiting.
 */
function passOnProbe(): void {
  if (probeTimer !== null) {
    clearTimeout(probeTimer)
    probeTimer = null
  }
  const next = queue.hold.handOff()
  if (next === null) {
    queue.hold.end()
    pump()
    return
  }
  const reason = queue.hold.reason ?? 'connection'
  patchRow(next, { holdReason: reason })
  scheduleProbe(next)
}

/** A row the user no longer wants started: out of the queue, and out of the probe role if it held it. */
function forgetQueued(id: string): void {
  queue.remove(id)
  if (queue.hold.probeId === id && !runners.has(id)) passOnProbe()
}

/** Any answer that is not a hold means the way to the server is open again. */
function endHoldIfProbe(id: string): void {
  if (queue.hold.probeId !== id) return
  if (probeTimer !== null) {
    clearTimeout(probeTimer)
    probeTimer = null
  }
  queue.hold.end()
}

/**
 * The connection or storage is down. The row goes back to waiting: as the
 * probe, which alone tries again, or, when another row already is the probe,
 * first in line behind it. A resume goes back to being a queued resume, never
 * to `queued`: it has an upload on the server to come back to.
 */
function holdRow(
  id: string,
  kind: 'new' | 'resume',
  reason: 'connection' | 'storage',
  retryAfterMs: number | undefined,
): void {
  const row = rowById(id)
  if (!row) return
  const waiting: Partial<UploadFile> = kind === 'new'
    ? { status: 'queued', progress: 0 }
    : { status: 'interrupted', queuedResume: true, resuming: undefined, progress: 0 }
  if (queue.hold.begin(id, reason, retryAfterMs)) {
    patchRow(id, { ...waiting, holdReason: reason })
    scheduleProbe(id)
  } else {
    queue.enqueue([queueEntry(row, kind)], 'next')
    patchRow(id, { ...waiting, holdReason: undefined, queueSeq: queue.queueSeq(id) })
  }
}

/** The reason a refused row shows. */
function refusalMessage(outcome: InitiateOutcome, err: unknown): string {
  const said =
    outcome.kind === 'refusal' || outcome.kind === 'storage_misconfigured'
      ? outcome.message
      : err instanceof ApiError
        ? err.detail
        : ''
  return said.trim() === '' ? REFUSED_MESSAGE : said
}

/**
 * An initiate failed. A refusal fails this row, with Retry, and the queue goes
 * on; a hold puts it back to wait for the connection or storage (spec goal 6).
 * The account outcomes are refusals until owner pinning lands.
 */
function onInitiateFailed(id: string, err: unknown): void {
  const row = rowById(id)
  const wasProbe = queue.hold.probeId === id
  // The user's cancel outranks whatever the server said; the row stays cancelled.
  if (!row || row.status === 'cancelled') {
    if (wasProbe) {
      const outcome = classifyInitiateError(err)
      if (outcome.kind === 'hold') passOnProbe()
      else endHoldIfProbe(id)
    }
    return
  }

  const outcome = classifyInitiateError(err)
  if (outcome.kind === 'hold') {
    // Nothing on screen says what a non-API failure was; a bug here would
    // otherwise hold the queue with no trace. Once per row, not per retry.
    if (!(err instanceof ApiError) && !wasProbe) {
      console.warn('Upload could not start; waiting for the connection.', err)
    }
    holdRow(id, 'new', outcome.reason, outcome.retryAfterMs)
    return
  }

  endHoldIfProbe(id)
  patchRow(id, {
    status: 'failed',
    failedBeforeStart: true,
    retryable: true,
    holdReason: undefined,
    progress: 0,
    error: refusalMessage(outcome, err),
  })
}

/**
 * A new upload's turn: initiate (or create the version), then send every part
 * and complete. Everything that announces a transfer starts here, at the turn,
 * and not when the row was added.
 */
async function runNew(id: string, runner: Runner, runKey: string): Promise<void> {
  const file = fileRefs.get(id)!
  const target: StartTarget = startTargets.get(id) ?? { kind: 'asset', folderId: null }

  const controller = new AbortController()
  abortControllers[id] = controller

  // Track initiate response fields so catch block can call /upload/abort,
  // and ask the server what became of the version before it does.
  let upload_id: string | undefined
  let s3_key: string | undefined
  let version_id: string | undefined
  let asset_id: string | undefined
  let completionAttempted = false

  // Everything the run takes is taken inside the `try`, so the `finally` gives
  // it all back and ends the run whatever throws. Even the first heartbeat is a
  // write to shared storage, which can throw (a full quota), and a run that
  // threw before its `try` kept its place, its wake lock and, for a large file,
  // the whole part budget for the life of the tab.
  let stopBeat = () => {}
  let watch: ReturnType<typeof transferWatch> | null = null
  try {
    retainWakeLock()
    stopBeat = beatFor((patch) => patchRow(id, patch))
    const runWatch = transferWatch(id, file.size, (patch) => patchRow(id, patch))
    watch = runWatch
    patchRow(id, { status: 'starting', holdReason: undefined, error: undefined, progress: 0 })

    // What the asset will be called: the row's name now, at the turn, so a
    // rename made while it waited is the name it is created with.
    const startRow = rowById(id)
    const sentName = startRow?.assetName ?? file.name
    const projectId = startRow?.projectId ?? ''

    let initRes: InitiateResponse
    try {
      initRes = target.kind === 'asset'
        ? await api.post<InitiateResponse>('/upload/initiate', {
          project_id: projectId,
          asset_name: sentName,
          original_filename: file.name,
          file_size_bytes: file.size,
          mime_type: file.type,
          folder_id: target.folderId,
        })
        : await api.post<VersionInitiateResponse>(`/assets/${target.assetId}/versions`, {
          project_id: projectId,
          asset_name: sentName,
          original_filename: file.name,
          file_size_bytes: file.size,
          mime_type: file.type,
        })
    } catch (err) {
      onInitiateFailed(id, err)
      return
    }
    endHoldIfProbe(id)

    upload_id = initRes.upload_id
    s3_key = initRes.s3_key
    version_id = initRes.version_id
    asset_id = target.kind === 'asset' ? initRes.asset_id : target.assetId

    // Now the server has said how the file is cut, and the start rule can
    // count this file by its parts instead of by the whole budget.
    runner.unfinished = Math.ceil(file.size / initRes.chunk_size_bytes)
    const cancelled = controller.signal.aborted
    patchRow(id, {
      uploadId: upload_id, s3Key: s3_key, assetId: asset_id, versionId: version_id,
      // A cancel made while the initiate was out stands.
      ...(cancelled ? {} : { status: 'uploading' as const }),
    })
    pump()
    // Cancelled while the initiate was out: what it created is thrown away below.
    if (cancelled) throw new DOMException('Upload cancelled', 'AbortError')

    if (target.kind === 'asset') {
      // The round trip is the window that does exist, and the only place a
      // rename can be lost: the panel offers the pencil from the moment the
      // row appears, so an edit during it went into the row while the request
      // carrying the old name had already left. Now that the asset exists it
      // can be told. Failing here must not fail the upload -- the bytes are
      // the point.
      //
      // It must not be swallowed either. The row is put back to the name the
      // asset actually has and the reason is recorded on it, the way the
      // interactive rename path does. Keeping the refused name would leave
      // the row disagreeing with the asset, the grid, search and the share
      // link for the rest of the session -- and would also block the retry,
      // since `renameUpload` returns early when the typed name equals the
      // one already in the row.
      const nameAfterInitiate = rowById(id)?.assetName ?? sentName
      if (nameAfterInitiate !== sentName) {
        try {
          await api.patch(`/assets/${asset_id}`, { name: nameAfterInitiate })
        } catch (err) {
          patchRow(id, {
            assetName: sentName,
            renameError: err instanceof Error ? err.message : 'Rename failed',
          })
        }
      }
    }

    const parts = await uploadAllParts(
      file, s3_key, upload_id, controller,
      (percent) => patchRow(id, { progress: percent, heartbeatAt: Date.now() }),
      {
        budget: partBudget,
        fileKey: runKey,
        chunkSize: initRes.chunk_size_bytes,
        onPartDone: () => patchRow(id, { heartbeatAt: Date.now() }),
        onUnfinished: (n) => {
          runner.unfinished = n
          pump()
        },
        onBytes: runWatch.onBytes,
        onAllSent: runWatch.onAllSent,
        onResend: runWatch.onResend,
      },
    )

    completionAttempted = true
    patchRow(id, { finalizing: true })
    await api.post('/upload/complete', {
      s3_key,
      upload_id,
      asset_id,
      version_id,
      parts,
    })

    // Upload done — backend now processes (transcode/convert).
    // For non-processable types (or if SSE isn't wired), mark complete directly.
    const isMedia = file.type.startsWith('video/') || file.type.startsWith('audio/') || file.type.startsWith('image/')
    patchRow(id, isMedia
      ? { progress: 100, status: 'processing', processingProgress: 0 }
      : { progress: 100, status: 'complete' })
  } catch (err) {
    // Asking the server what happened takes a round-trip, and the row stays
    // interactive for its duration -- the panel still offers Cancel on an
    // `uploading` row. A cancel landing in that window is the user's decision
    // and outranks whatever we were about to write.
    const userCancelled = () => rowById(id)?.status === 'cancelled'
    const applyLanded = (landed: 'processing' | 'complete') => {
      if (userCancelled()) return
      patchRow(id, {
        progress: 100,
        status: landed,
        processingProgress: landed === 'complete' ? 100 : 0,
      })
    }

    if (isAbortError(err)) {
      patchRow(id, { status: 'cancelled', progress: 0 })
    } else {
      // A completion that threw may still have landed, with only its
      // response lost on the way back. Writing that off would report a
      // working upload as Failed.
      const landed = completionAttempted && asset_id && version_id
        ? await completedVersionStatus(asset_id, version_id)
        : null
      if (landed) {
        applyLanded(landed)
      } else if (!userCancelled()) {
        // Nothing was destroyed, so nothing is lost: the multipart upload is
        // still open and every part already sent is still held. `interrupted`
        // says that, where `failed` claimed the opposite. A version that never
        // got as far as a multipart upload has nothing to come back to and
        // stays `failed`.
        patchRow(id, {
          status: upload_id && version_id ? 'interrupted' : 'failed',
          error: err instanceof Error ? err.message : 'Upload failed',
        })
        // Only after a completion was attempted can the object be whole with
        // the version still `uploading`, and only then is it worth a request
        // to find out.
        if (completionAttempted && version_id && await finishAssembledUpload(version_id)) {
          applyLanded('processing')
        }
      }
    }

    // The one and only reason to abort. AbortMultipartUpload discards every
    // part the backend is holding, and this used to run from the catch of
    // *any* error -- destroying the bytes that make a resume possible at
    // exactly the moment they became worth keeping. Everything else is left
    // for the user to resume or for the reaper to reclaim.
    if (userCancelled() && upload_id && s3_key && version_id) {
      await abortCancelled(useUploadStore.setState, { s3_key, upload_id, version_id })
    }
  } finally {
    watch?.stop()
    stopBeat()
    releaseWakeLock()
    if (abortControllers[id] === controller) delete abortControllers[id]
    endRun(id, runner, runKey)
  }
}

/**
 * A queued resume's turn: ask the server where the upload stands, check nobody
 * else is sending it, then send what is missing and complete (spec goal 11).
 * A `/parts` call that cannot get through holds the queue, exactly as an
 * initiate would; the row goes back to being a queued resume.
 */
async function runResume(id: string, runner: Runner, runKey: string): Promise<void> {
  const file = fileRefs.get(id)!
  // As it stood before this run touched it: `activeElsewhere` judges its stamps.
  const row = rowById(id)!
  const versionId = row.versionId!
  const updateFile = (patch: Partial<UploadFile>) => patchRow(id, patch)

  const controller = new AbortController()
  abortControllers[id] = controller
  let info: ResumeInfo | undefined
  let completionAttempted = false
  let stopBeat = () => {}
  let watch: ReturnType<typeof transferWatch> | null = null
  try {
    // Inside the `try`, as in `runNew`, so the `finally` always balances it.
    retainWakeLock()
    // A resumed row may have stopped while finalizing.
    updateFile({
      status: 'starting', resuming: true, queuedResume: undefined, holdReason: undefined,
      progress: 0, error: undefined, finalizing: false,
    })

    // Everything needed to carry on comes from the server, including the key
    // and the upload id: this row may have been rehydrated from history in a
    // browser that never saw them.
    try {
      info = await api.get<ResumeInfo>(`/upload/${versionId}/parts`)
    } catch (err) {
      const outcome = isAbortError(err) || isFinalRefusal(err) ? null : classifyInitiateError(err)
      if (outcome?.kind === 'hold' && rowById(id)?.status === 'starting') {
        if (!(err instanceof ApiError) && queue.hold.probeId !== id) {
          console.warn('Upload could not resume; waiting for the connection.', err)
        }
        holdRow(id, 'resume', outcome.reason, outcome.retryAfterMs)
        return
      }
      if (outcome?.kind === 'hold' && queue.hold.probeId === id) passOnProbe()
      else endHoldIfProbe(id)
      throw err
    }
    endHoldIfProbe(id)

    // Two tabs sending the same part numbers into one multipart upload leave
    // the completing tab with ETags that no longer match what is stored.
    if (activeElsewhere(row, info, Date.now(), controller)) {
      const refusedAt = info.last_activity_at
      info = undefined
      if (rowById(id)?.status !== 'cancelled') {
        updateFile({
          status: 'elsewhere',
          resuming: undefined,
          progress: row.progress,
          elsewhereUntil: liveUntil(refusedAt),
        })
      }
      return
    }
    stopBeat = beatFor(updateFile)

    // The upload id belongs on the row, not only in this closure. A row
    // without one is read as a transfer that broke before initiate
    // answered, so `standingOfStoredRow` fails it -- and a resumed row
    // interrupted again mid-transfer came back as "Upload interrupted"
    // with nothing but Dismiss, which is precisely the row this feature
    // exists for: one this browser only knows from `/me/assets`, or one
    // whose storage was cleared. It is recoverable by dismissing and
    // reloading, and nobody would guess that.
    //
    // The version and asset ids go with it, for the same reason: the two
    // fresh upload paths record all three in one call and this one
    // recorded none of them. So does the storage key, which Discard needs
    // to abort after `/parts` has stopped answering.
    const held = info.state === 'resumable' ? info.held_part_numbers : []
    runner.unfinished = info.state === 'resumable'
      ? Math.max(0, Math.ceil(file.size / info.chunk_size_bytes) - held.length)
      : 0
    updateFile({
      ...(rowById(id)?.status === 'cancelled' ? {} : { status: 'uploading' as const }),
      resuming: undefined,
      uploadId: info.upload_id,
      s3Key: info.s3_key,
      versionId: info.version_id,
      assetId: info.asset_id,
    })
    pump()

    // `assembled` means the object is whole and only the completion is
    // outstanding, so the file is not needed and is not checked -- refusing
    // it over a rename would strand an upload that has nothing left to send.
    let parts: Array<{ PartNumber: number; ETag: string }> = []
    if (info.state === 'resumable') {
      // A browser cannot reopen a local file on its own, so the user picks it
      // again -- and nothing makes them pick the same one. Name and size are
      // what can be checked without reading the file; they guard against an
      // accident rather than prove anything, and a mismatch here is what
      // would silently corrupt the parts already in the bucket.
      //
      // The two checks report separately because they mean different things
      // to whoever has to act on them: the wrong file is picked again, a
      // right-named file of the wrong length is a file that changed.
      //
      // Both messages lead with the instruction and stay short enough for
      // one line. The panel row truncates, and naming the file the user just
      // picked -- the one thing they already know -- used up the whole line
      // before reaching the part that says what to do about it.
      if (file.name !== info.original_filename) {
        throw new Error(`Please select ${info.original_filename}`)
      }
      if (file.size !== info.file_size_bytes) {
        throw new Error('File does not match original')
      }
      const resumeWatch = transferWatch(id, file.size, updateFile)
      watch = resumeWatch
      parts = await uploadAllParts(
        file, info.s3_key, info.upload_id, controller,
        (percent) => updateFile({ progress: percent, heartbeatAt: Date.now() }),
        {
          budget: partBudget,
          fileKey: runKey,
          chunkSize: info.chunk_size_bytes,
          alreadyHeld: held,
          onPartDone: () => updateFile({ heartbeatAt: Date.now() }),
          onUnfinished: (n) => {
            runner.unfinished = n
            pump()
          },
          onBytes: resumeWatch.onBytes,
          onAllSent: resumeWatch.onAllSent,
          onResend: resumeWatch.onResend,
        },
      )
    }

    completionAttempted = true
    updateFile({ finalizing: true })
    await api.post('/upload/complete', {
      s3_key: info.s3_key,
      upload_id: info.upload_id,
      asset_id: info.asset_id,
      version_id: info.version_id,
      // Nothing when parts were skipped. This list is only read by a backend
      // that cannot list its own parts, and a resumed upload cannot produce a
      // complete one -- it never saw the ETags of the parts it did not send.
      // Handing over the partial list would complete a truncated object with
      // no error on most backends; handing over none makes that backend
      // refuse instead, which is the failure worth having.
      parts: held.length > 0 ? [] : parts,
    })

    const isMedia = /^(video|audio|image)\//.test(info.mime_type)
    updateFile({
      progress: 100,
      status: isMedia ? 'processing' : 'complete',
      processingProgress: 0,
      assetId: info.asset_id,
    })
  } catch (err) {
    const userCancelled = () => rowById(id)?.status === 'cancelled'

    if (isAbortError(err)) {
      updateFile({ status: 'cancelled', progress: 0, resuming: undefined })
    } else {
      // See runNew: the completion may have landed with only its response
      // lost, and this is the second time round for this version.
      //
      // A refusal is asked the same question. `/parts` answers 409 for any
      // status that is not `uploading`, which includes `processing` and
      // `ready`: the upload landed and this tab is the last to hear about
      // it. Treated as final, that put a red Failed badge reading "This
      // upload is already ready." on a file that uploaded and transcoded
      // perfectly. `completedVersionStatus` compares version ids, so a
      // version that really did fail still falls through to `failed`.
      const askAbout = info?.asset_id ?? row.assetId
      const landed = (completionAttempted || isFinalRefusal(err)) && askAbout
        ? await completedVersionStatus(askAbout, versionId)
        : null
      if (landed) {
        if (!userCancelled()) {
          updateFile({
            progress: 100,
            status: landed,
            resuming: undefined,
            processingProgress: landed === 'complete' ? 100 : 0,
          })
        }
      } else if (!userCancelled()) {
        updateFile({
          // Back to resumable unless the server said this upload is over.
          // Nothing was aborted here either, so the parts sent this time are
          // held too and the next attempt starts from further along.
          status: isFinalRefusal(err) ? 'failed' : 'interrupted',
          resuming: undefined,
          progress: 0,
          error: err instanceof Error ? err.message : 'Upload failed',
        })
      }
    }

    if (userCancelled() && info) {
      await abortCancelled(useUploadStore.setState, {
        s3_key: info.s3_key,
        upload_id: info.upload_id,
        version_id: info.version_id,
      })
    }
  } finally {
    watch?.stop()
    stopBeat()
    releaseWakeLock()
    if (abortControllers[id] === controller) delete abortControllers[id]
    endRun(id, runner, runKey)
  }
}

/**
 * Adds new uploads to the back of the queue, as one drop, and starts whatever
 * may start now. Returns the row ids in the order given.
 */
function enqueueNew(
  set: (fn: (s: UploadStore) => Partial<UploadStore>) => void,
  items: Array<{ file: File; assetName: string; target: StartTarget }>,
  projectId: string,
  projectName: string | undefined,
): string[] {
  if (items.length === 0) return []
  const dropSeq = ++dropSeqs
  const createdAt = Date.now()
  const rows: UploadFile[] = items.map(({ file, assetName, target }) => {
    const id = newRowId()
    fileRefs.set(id, file)
    startTargets.set(id, target)
    return {
      id,
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type,
      projectId,
      projectName,
      assetName,
      progress: 0,
      processingProgress: 0,
      status: 'queued',
      createdAt,
      dropSeq,
      ...(target.kind === 'version' ? { assetId: target.assetId } : {}),
    }
  })
  queue.enqueue(rows.map((r) => queueEntry(r, 'new')), 'back')
  for (const r of rows) r.queueSeq = queue.queueSeq(r.id)
  try {
    // Newest first, as rows have always been listed.
    set((s) => ({ files: [...rows.slice().reverse(), ...s.files], panelOpen: true }))
  } finally {
    // The rows are in state even when saving them threw: they still get their turn.
    pump()
  }
  return rows.map((r) => r.id)
}

const storeCreator: StateCreator<UploadStore, [['zustand/persist', unknown]]> = (set, get) => ({
  files: [],
  versionsRevision: 0,
  panelOpen: false,
  historyLoaded: false,
  historyHasMore: true,
  historyLoading: false,
  historySkip: 0,

  setPanelOpen: (open) => set({ panelOpen: open }),
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),

  startUpload: (file, projectId, assetName, projectName, folderId) =>
    enqueueNew(set, [{ file, assetName, target: { kind: 'asset', folderId: folderId ?? null } }], projectId, projectName)[0],

  startUploads: (items, projectId, projectName, folderId) =>
    enqueueNew(
      set,
      items.map(({ file, assetName }) => ({ file, assetName, target: { kind: 'asset' as const, folderId: folderId ?? null } })),
      projectId,
      projectName,
    ),

  startVersionUpload: (file, assetId, assetName, projectId, projectName) =>
    enqueueNew(set, [{ file, assetName, target: { kind: 'version', assetId } }], projectId, projectName)[0],

  resumeUpload: (fileId, file) => {
    const row = get().files.find((f) => f.id === fileId)
    // Not while a run of this row is still settling: a run whose transfer
    // broke is still asking the server what became of it, and its answer
    // would land on the row a second run is sending.
    if (!row || row.status !== 'interrupted' || !row.versionId || row.queuedResume || runners.has(fileId)) return
    fileRefs.set(fileId, file)
    // A Resume goes ahead of every file not yet started, behind the ones
    // already running, and takes its turn like them -- so it never sends
    // beside three active files or outside the part budget.
    queue.enqueue([queueEntry(row, 'resume')], 'next')
    set((s) => ({
      files: s.files.map((f) => (f.id === fileId
        ? { ...f, queuedResume: true as const, dropSeq: ++dropSeqs, queueSeq: queue.queueSeq(fileId), error: undefined }
        : f)),
    }))
    pump()
  },

  discardUpload: async (fileId) => {
    // The counterpart to no longer aborting on failure. Without it the only way
    // to be rid of an upload the user does not want back is to wait for the
    // reaper, and the row would keep offering a resume in the meantime.
    const row = get().files.find((f) => f.id === fileId)
    if (!row) return null
    // A queued resume gives up its turn first, before any round trip: its turn
    // coming while this asks the server would start sending into the upload
    // this is about to abort.
    if (row.queuedResume) {
      forgetQueued(fileId)
      fileRefs.delete(fileId)
      set((s) => ({
        files: s.files.map((f) => (f.id === fileId ? { ...f, queuedResume: undefined, holdReason: undefined } : f)),
      }))
    }
    const drop = () => {
      forgetQueued(fileId)
      fileRefs.delete(fileId)
      startTargets.delete(fileId)
      set((s) => ({ files: s.files.filter((f) => f.id !== fileId) }))
    }
    if (!row.versionId) {
      drop()
      return null
    }

    let info: ResumeInfo
    try {
      info = await api.get<ResumeInfo>(`/upload/${row.versionId}/parts`)
    } catch (err) {
      // 404 or 409: the version is gone or no longer uploading, so the row has
      // nothing to offer. The multipart upload behind it may still be open --
      // `/parts` answering 404 says nothing about storage -- and leaving it to
      // the reaper holds every part already sent until then. A row that
      // recorded its key and upload id can abort without being told them.
      if (isFinalRefusal(err)) {
        if (row.s3Key && row.uploadId) {
          try {
            await api.post('/upload/abort', {
              s3_key: row.s3Key,
              upload_id: row.uploadId,
              version_id: row.versionId,
              discard: true,
            })
          } catch (abortErr) {
            // The upload is already gone too: the same answer from the other
            // side, and what Discard wanted to happen has happened.
            if (!(abortErr instanceof ApiError && abortErr.status === 404)) {
              return reportDiscardFailure(set, fileId, abortErr)
            }
          }
        }
        drop()
        set((s) => ({ versionsRevision: s.versionsRevision + 1 }))
        return null
      }
      return reportDiscardFailure(set, fileId, err)
    }

    // The server has seen this upload move within the window, and this tab is
    // not the one moving it. Discard succeeds on every check the server can
    // make -- the version really is still uploading -- and the tab doing the
    // transfer gets NoSuchUpload on its next part.
    if (activeElsewhere(row, info, Date.now())) {
      set((s) => ({
        files: s.files.map((f) => (f.id === fileId
          // Held until the server's window runs out rather than for a fresh
          // one from now: the poll then offers the row again the moment a
          // second attempt can succeed.
          ? { ...f, status: 'elsewhere' as const, elsewhereUntil: liveUntil(info.last_activity_at) }
          : f)),
      }))
      return ELSEWHERE_MESSAGE
    }

    try {
      // `discard` and not a plain abort. A plain abort marks the version
      // `failed`, which leaves a red badge in the version switcher for an
      // upload somebody deliberately threw away -- and it takes its own branch
      // when the object is already whole, promoting the version and dispatching
      // the transcode, so the one control that exists to throw an upload away
      // published it instead. A discard says which of the two this is, and the
      // server disposes of it the way the reaper disposes of a stale upload:
      // bytes gone, version gone, and the asset with it if that was its only
      // version.
      await api.post('/upload/abort', {
        s3_key: info.s3_key,
        upload_id: info.upload_id,
        version_id: info.version_id,
        discard: true,
      })
    } catch (err) {
      return reportDiscardFailure(set, fileId, err)
    }
    // Only now. The row used to leave the list before the request and every
    // failure was swallowed, so a 503 from unreachable storage left no row, no
    // error, and a version the reaper would not touch for a day.
    drop()
    // Said after the server has answered: a screen showing this asset's
    // versions has to refetch, and refetching while the delete is in flight
    // would fetch the version back.
    set((s) => ({ versionsRevision: s.versionsRevision + 1 }))
    return null
  },

  cancelUpload: (fileId) => {
    const row = get().files.find((f) => f.id === fileId)
    // Not started, so nothing to stop: it only gives up its place. A queued
    // resume goes back to plain `interrupted`, still resumable.
    forgetQueued(fileId)
    if (row?.status === 'interrupted') {
      if (row.queuedResume) {
        fileRefs.delete(fileId)
        set((s) => ({
          files: s.files.map((f) => (f.id === fileId ? { ...f, queuedResume: undefined, holdReason: undefined } : f)),
        }))
      }
      return
    }
    if (!runners.has(fileId)) {
      fileRefs.delete(fileId)
      startTargets.delete(fileId)
    }
    abortControllers[fileId]?.abort()
    set((s) => ({
      files: s.files.map((f) =>
        f.id === fileId ? { ...f, status: 'cancelled' as const, progress: 0 } : f,
      ),
    }))
  },

  renameUpload: async (fileId, name) => {
    const row = get().files.find((f) => f.id === fileId)
    if (!row) return null
    const trimmed = name.trim()
    if (!trimmed || trimmed === row.assetName) return null

    // A history row cannot be renamed: it came from `/me/assets` -- see
    // `fromHistory` -- so it is not proof of the role the edit needs, and
    // offering it only to answer 403 is worse than not offering it.
    if (row.fromHistory) return null

    const previous = row.assetName
    const applyName = (value: string) =>
      set((s) => ({
        files: s.files.map((f) =>
          // Any rename clears the recorded one: whatever it said is about a
          // name the row no longer carries.
          f.id === fileId ? { ...f, assetName: value, renameError: undefined } : f,
        ),
      }))

    // Optimistic. The user has just left a text field; putting the old name
    // back for the length of a round trip reads as the edit having failed.
    applyName(trimmed)

    // No asset yet, because `/upload/initiate` is what creates one. The row is
    // the only record of the name until it answers, and it is the record
    // initiate reads -- so this is stored, just not on the server yet.
    if (!row.assetId) return null

    try {
      await api.patch(`/assets/${row.assetId}`, { name: trimmed })
    } catch (err) {
      applyName(previous)
      return err instanceof Error ? err.message : 'Rename failed'
    }

    // The panel is mounted in the dashboard layout, so it has no handle on the
    // grid it is floating over and no way to tell it the name changed. Every
    // asset list is keyed by a path containing `/assets`, so revalidating that
    // set is what makes the card behind the panel agree with the row in it.
    //
    // One argument, deliberately. swr short-circuits to a pure revalidate only
    // when fewer than three are passed; with three it falls through to
    // `populateCache`, which defaults to true, and writes `undefined` into
    // every matching key before refetching. That blanks the grid behind the
    // panel into skeletons for the length of the refetch, and the review
    // screen's comment list into "No comments yet", because `use-comments`
    // does `data ?? []` and the page passes no `isLoading`. Both forms
    // revalidate; the extra arguments only buy the blank.
    void globalMutate((key) => typeof key === 'string' && key.includes('/assets'))
    return null
  },

  removeFile: (fileId) => {
    forgetQueued(fileId)
    if (!runners.has(fileId)) {
      fileRefs.delete(fileId)
      startTargets.delete(fileId)
    }
    set((s) => ({ files: s.files.filter((f) => f.id !== fileId) }))
  },

  clearCompleted: () => {
    set((s) => ({ files: s.files.filter((f) => f.status !== 'complete') }))
  },

  fetchHistory: async () => {
    if (get().historyLoaded) return
    set({ historyLoading: true })
    try {
      const assets = await api.get<AssetResponse[]>(
        `/me/assets?filter=owned&skip=0&limit=${HISTORY_PAGE_SIZE}`,
      )
      const merged = mergeHistoryAssets(get().files, assets)
      set({
        historyLoaded: true,
        historyLoading: false,
        historySkip: HISTORY_PAGE_SIZE,
        historyHasMore: assets.length >= HISTORY_PAGE_SIZE,
        files: merged,
      })
    } catch {
      set({ historyLoaded: true, historyLoading: false })
    }
  },

  fetchMoreHistory: async () => {
    const { historyHasMore, historyLoading, historySkip } = get()
    if (!historyHasMore || historyLoading) return
    set({ historyLoading: true })
    try {
      const assets = await api.get<AssetResponse[]>(
        `/me/assets?filter=owned&skip=${historySkip}&limit=${HISTORY_PAGE_SIZE}`,
      )
      const merged = mergeHistoryAssets(get().files, assets)
      set((s) => ({
        historyLoading: false,
        historySkip: s.historySkip + HISTORY_PAGE_SIZE,
        historyHasMore: assets.length >= HISTORY_PAGE_SIZE,
        files: merged,
      }))
    } catch {
      set({ historyLoading: false })
    }
  },

  updateProcessingProgress: (assetId, percent) => {
    set((s) => ({
      files: s.files.map((f) =>
        f.assetId === assetId && f.status === 'processing'
          ? { ...f, processingProgress: percent }
          : f,
      ),
    }))
  },

  markProcessingComplete: (assetId) => {
    set((s) => ({
      files: s.files.map((f) =>
        f.assetId === assetId && f.status === 'processing'
          ? { ...f, status: 'complete' as const, processingProgress: 100 }
          : f,
      ),
    }))
  },

  markProcessingFailed: (assetId, error) => {
    set((s) => ({
      files: s.files.map((f) =>
        f.assetId === assetId && f.status === 'processing'
          ? { ...f, status: 'failed' as const, error }
          : f,
      ),
    }))
  },

  refreshProcessingItems: async () => {
    // A row another tab is sending stays that way while the other tab keeps
    // stamping it in shared storage. Once it stops -- the transfer ended, or the
    // tab went -- the row is judged like any interrupted one below, which is
    // how a finished upload over there turns into processing here.
    const now = Date.now()
    if (get().files.some((f) => f.status === 'elsewhere')) {
      set((s) => ({
        files: s.files.map((f) => {
          if (f.status !== 'elsewhere') return f
          const beat = storedHeartbeat(f.id)
          const beating = beat !== undefined && now - beat < LIVE_WINDOW_MS
          const held = f.elsewhereUntil !== undefined && now < f.elsewhereUntil
          return beating || held ? f : { ...f, status: 'interrupted' as const }
        }),
      }))
    }

    // Interrupted rows are polled alongside processing ones. The same upload can
    // be resumed from another tab or another machine, and without this the row
    // here keeps offering a resume for a version that is already transcoding.
    //
    // A queued resume is not: it asks the server itself at its turn, and a
    // poll rewriting it meanwhile would leave the queue holding a row that
    // is no longer waiting.
    const watched = get().files.filter(
      (f) => (f.status === 'processing' || f.status === 'interrupted') && f.assetId && !f.queuedResume,
    )
    if (!watched.length) return
    try {
      // `null` is "no answer, ask again"; `'gone'` is an answer that is final.
      const results = await Promise.all(
        watched.map((f) =>
          api.get<AssetResponse>(`/assets/${f.assetId}`).catch((err): 'gone' | null =>
            isAssetGone(err) ? 'gone' : null,
          ),
        ),
      )
      set((s) => ({
        files: s.files.map((f) => {
          if ((f.status !== 'processing' && f.status !== 'interrupted') || !f.assetId || f.queuedResume) return f
          // Matched on the version and not the asset: two rows can watch one
          // asset -- an interrupted v2 and a processing v3 -- and on the asset
          // they both read the first one's answer.
          const idx = watched.findIndex((pf) => pf.id === f.id)
          const answer = idx >= 0 ? results[idx] : null
          // Failed is neither polled nor counted as active, so this is what
          // takes the row off the timer; the panel still offers Dismiss on it.
          if (answer === 'gone') {
            return { ...f, status: 'failed' as const, error: ASSET_GONE_MESSAGE }
          }
          const asset = answer
          if (!asset?.latest_version) return f
          // `GET /assets/{id}` answers with `_display_version`, which excludes
          // `uploading`, so for an interrupted second version it hands back the
          // previous version sitting at `ready`. Without this the row is
          // rewritten to complete: Resume and Discard disappear, the user is
          // told the upload landed, and the parts sit in the bucket until the
          // reaper. This is the guard `completedVersionStatus` carries for the
          // same reason -- the second half of #273.
          if (!f.versionId || asset.latest_version.id !== f.versionId) return f
          // An upload still running on another device reads as `uploading`
          // here, which maps to `interrupted` -- the same status the row
          // already has, so the early return below kept it there for good. The
          // row went on offering Resume and Discard for a transfer that was
          // very much alive, which is the opposite of what `elsewhere` exists
          // to say, and `last_activity_at` was sitting in the payload that had
          // just been fetched. Judged the way `mergeHistoryAssets` judges it,
          // so history and the poll cannot disagree about the same version.
          const version = asset.latest_version
          // `last_activity_at` says that bytes moved, not who moved them. On a
          // row this tab owns it is this tab's own trailing part activity
          // handed back, so it is no evidence of another sender: a transfer
          // that drops here leaves the version `uploading` with a stamp
          // seconds old, and reading that as `elsewhere` took the user's own
          // upload away from them. `elsewhere` offers no Resume, no Discard
          // and no Cancel, and such a row is not in `watched` below, so
          // nothing put it back until the stamp aged out a window later.
          // Judge only the rows this tab is not responsible for. For its own,
          // the destructive actions are still refused where they are taken,
          // by `activeElsewhere`, which is where that decision belongs.
          const ownRow = f.ownerTab === currentTabId()
          const movingUntil = !ownRow && version.processing_status === 'uploading'
            ? liveUntil(version.last_activity_at)
            : undefined
          const stillMoving = movingUntil !== undefined && Date.now() < movingUntil
          const status = stillMoving
            ? ('elsewhere' as const)
            : mapProcessingStatus(version.processing_status)
          // No `&& !stillMoving` guard here: `watched` only collects
          // `processing` and `interrupted` rows, so a `stillMoving` row is
          // always changing status and can never reach this comparison equal.
          if (status === f.status) return f
          const keepsProgress = status === 'interrupted' || status === 'elsewhere'
          return {
            ...f,
            status,
            elsewhereUntil: stillMoving ? movingUntil : f.elsewhereUntil,
            progress: keepsProgress ? f.progress : 100,
            processingProgress: status === 'complete' ? 100 : 0,
          }
        }),
      }))
    } catch {
      // SSE is the primary mechanism; ignore poll errors
    }
  },
})

/**
 * The row as it is saved, or null when it is not saved at all.
 *
 * - `queued`: never. Its `File` cannot survive a reload, and there is nothing on
 *   the server to come back to.
 * - `starting`: a resume has its upload to come back to and is saved as plain
 *   `interrupted`; a new upload whose initiate is still out has nothing yet
 *   and is not saved.
 * - `interrupted`, queued or held or not, is saved as plain `interrupted`.
 * - `failed` before start is saved without `retryable`: after a reload there is
 *   no `File` to retry with, so it offers Dismiss only.
 * - `processing` and `complete` come back from history instead.
 *
 * The queue's in-memory markers are never saved.
 */
function savedRow(f: UploadFile): UploadFile | null {
  const kept: UploadFile = { ...f }
  delete kept.queuedResume
  delete kept.resuming
  delete kept.holdReason
  switch (f.status) {
    case 'starting':
      return f.versionId ? { ...kept, status: 'interrupted' } : null
    case 'failed':
      if (f.failedBeforeStart) delete kept.retryable
      return kept
    case 'interrupted':
    case 'uploading':
    case 'elsewhere':
    case 'cancelled':
      return kept
    default:
      return null
  }
}

/**
 * Merges what this tab is about to write with what is already in storage.
 *
 * `ff-uploads` is one key shared by every tab of the origin, and zustand's
 * persist rewrites the whole of it from this tab's own `files` after every
 * `set` -- so without this, a tab that is only *watching* another tab's upload
 * publishes its own frozen copy of that row over the live one. Measured: a
 * store holding tab A's row as `elsewhere` with a three-minute-old stamp, and
 * `ff-uploads` freshly stamped by A less than two seconds ago; one ordinary
 * `setPanelOpen(true)` in tab B rolled the stored stamp back three minutes, and
 * the very next sweep called the transfer interrupted. The row left the Active
 * group for Failed, gained Resume and Discard, and never came back.
 *
 * Two rules, and both are the same idea: a row belongs to the tab that is
 * sending it.
 *
 *  * A row this tab does not own is kept as stored whenever the stored copy was
 *    stamped at least as recently. This tab has nothing newer to say about it.
 *  * A row that is in storage and not in this tab's state at all is kept, as
 *    long as another tab is still stamping it. Otherwise one tab's write erases
 *    another tab's in-flight row outright -- and if that tab then dies, history
 *    answers with the display version, which skips `uploading`, so a second
 *    version's upload has no row anywhere and no offer to resume.
 *
 * A row this tab owns is always written as this tab has it: nobody else is in a
 * position to know better.
 */
function mergeWithStored(name: string, outgoing: string): string {
  try {
    const raw = window.localStorage.getItem(name)
    if (!raw) return outgoing
    const parsed = JSON.parse(outgoing) as { state?: { files?: UploadFile[] } }
    const stored = (JSON.parse(raw) as { state?: { files?: UploadFile[] } }).state?.files
    const ours = parsed.state?.files
    if (!stored?.length || !ours) return outgoing

    const mine = currentTabId()
    const now = Date.now()
    const byId = new Map(ours.map((f) => [f.id, f]))

    for (const row of stored) {
      const here = byId.get(row.id)
      if (!here) {
        const beating = row.heartbeatAt !== undefined && now - row.heartbeatAt < LIVE_WINDOW_MS
        if (row.ownerTab && row.ownerTab !== mine && beating) byId.set(row.id, row)
        continue
      }
      if (here.ownerTab === mine) continue
      if ((row.heartbeatAt ?? 0) >= (here.heartbeatAt ?? 0)) byId.set(row.id, row)
    }

    // Array.from rather than a spread: this repo's target does not allow
    // iterating a Map without downlevelIteration.
    parsed.state!.files = Array.from(byId.values())
    return JSON.stringify(parsed)
  } catch {
    // Storage unreadable or holding something this build does not understand.
    // Writing this tab's own view is what happened before there was a merge at
    // all, and it is better than not persisting.
    return outgoing
  }
}

export const useUploadStore = create<UploadStore>()(
  persist(storeCreator, {
    name: 'ff-uploads',
    // Every write goes through the merge above. It costs one read and one parse
    // of a list that holds a handful of rows, against a `set` that has already
    // re-rendered the panel.
    storage: createJSONStorage(() => ({
      getItem: (name: string) => window.localStorage.getItem(name),
      setItem: (name: string, value: string) =>
        window.localStorage.setItem(name, mergeWithStored(name, value)),
      removeItem: (name: string) => window.localStorage.removeItem(name),
    })),
    // Terminal rows plus everything that can still be carried on. Successful
    // uploads are fetched from the API history on panel open, so they are not
    // kept here.
    //
    // Rows still in flight are kept too. They used to be dropped, on the
    // reasoning that a reload kills the transfer and the version comes back
    // from history as `interrupted` on its own -- which holds only for an asset
    // with nothing else to show. `/me/assets` reports the display version, and
    // that skips `uploading`, so reloading during the upload of a SECOND
    // version got the previous version back instead: one row, marked complete,
    // no offer to resume anywhere in the panel, and the parts left sitting in
    // the bucket until the reaper. The row is the only thing that knows the
    // upload happened, so it has to survive.
    //
    // What the queue adds is not saved, because a reload cannot keep it: the
    // `File` of a row that has not started dies with the page. See `savedRow`.
    partialize: (state: UploadStore) => ({
      files: state.files.flatMap((f: UploadFile) => {
        const saved = savedRow(f)
        return saved ? [saved] : []
      }),
    }),
    // Nothing in this tab is pushing bytes for a row that came out of storage,
    // whatever it said when it was written; `standingOfStoredRow` decides what it
    // is instead. Done in `merge` rather than after rehydration so the panel
    // never renders a row claiming to be uploading, or one offering Discard on a
    // transfer another tab is still running.
    merge: (persisted, current) => {
      const stored = (persisted as { files?: UploadFile[] } | undefined)?.files ?? []
      const now = Date.now()
      return {
        ...current,
        ...(persisted as object),
        // `savedRow` again: a row written by an older build, or by another tab
        // through `mergeWithStored`, is held to the same rules.
        files: stored.flatMap((f) => {
          const saved = savedRow(f)
          return saved ? [standingOfStoredRow(saved, now)] : []
        }),
      }
    },
  }),
)

// "Duplicate tab" copies sessionStorage, and with it this tab's id. Announce the
// id; a live tab already holding it answers, and the copy takes a new one and
// looks again at the rows it hydrated as its own.
if (typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined') {
  try {
    const channel = new BroadcastChannel('ff-upload-tabs')
    const nonce = newTabId()
    channel.onmessage = (e: MessageEvent) => {
      const msg = e.data as { type?: string; tab?: string; nonce?: string }
      if (msg.type === 'claim' && msg.tab === tabId && msg.nonce !== nonce) {
        channel.postMessage({ type: 'taken', tab: tabId, nonce: msg.nonce })
      } else if (msg.type === 'taken' && msg.nonce === nonce) {
        const inherited = tabId
        tabId = newTabId()
        try { window.sessionStorage.setItem(TAB_KEY, tabId) } catch { /* private mode */ }
        const now = Date.now()
        useUploadStore.setState((s) => ({
          files: s.files.map((f) =>
            f.status === 'interrupted' && f.ownerTab === inherited && !f.queuedResume
              ? standingOfStoredRow({ ...f, status: 'uploading' }, now)
              : f,
          ),
        }))
      }
    }
    channel.postMessage({ type: 'claim', tab: tabId, nonce })
  } catch {
    // No channel, no duplicate detection: the reload case still works.
  }
}

/**
 * For tests only. The queue is tab-wide module state, so a test that leaves a
 * run hanging would otherwise hold places in the next test's queue.
 */
export const __uploadQueueTesting = {
  /** An empty queue, no runs, no hold, and a fresh part budget. Runs still in flight are forgotten, not stopped. */
  reset(): void {
    if (probeTimer !== null) clearTimeout(probeTimer)
    probeTimer = null
    queue = createUploadQueue()
    runners.clear()
    fileRefs.clear()
    startTargets.clear()
    for (const id of Object.keys(abortControllers)) delete abortControllers[id]
    partBudget = createPartBudget(UPLOAD_CONCURRENCY)
    wakeLockHolders = 0
  },
  hasAbortController: (id: string): boolean => abortControllers[id] !== undefined,
  /** Rows whose run has begun and not yet ended. */
  runningIds: (): string[] => Array.from(runners.keys()),
  wakeLockHolders: (): number => wakeLockHolders,
}
