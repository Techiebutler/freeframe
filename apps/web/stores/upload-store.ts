import { create, type StateCreator } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { useShallow } from 'zustand/react/shallow'
import { mutate as globalMutate } from 'swr'
import { api, ApiError } from '@/lib/api'
import { createSpeedMeter, type SpeedMeter } from '@/lib/upload-speed'
import { createPartBudget, type PartBudget } from '@/lib/upload-budget'
import { createUploadQueue, usableRetryAfter, type ActiveInfo, type QueueEntry } from '@/lib/upload-queue'
import { classifyInitiateError, type InitiateOutcome } from '@/lib/upload-initiate-outcome'
import { currentSubject, watchSubject } from '@/lib/upload-owner'
import {
  assertReadable, FileUnreadableError, FILE_READ_FAILED_MESSAGE,
} from '@/lib/upload-readable'
import { useUploadSpeedStore } from './upload-speed-store'
import type { AssetResponse } from '@/types'

const CHUNK_SIZE = 10 * 1024 * 1024 // 10 MB
const HISTORY_PAGE_SIZE = 20
const PART_MAX_ATTEMPTS = 8 // per part, including the first try
const PART_RETRY_BASE_MS = 2000 // 2s, 4s, 8s … ≈254s of total tolerance per part
/**
 * The part watchdog (spec goal 5). A part PUT is aborted, and retried, when it
 * stops moving:
 *
 * - once it has sent its first byte, when no upload progress has come for
 *   `PART_STALL_MS` while bytes remain. A browser reports progress every 50 ms
 *   or so while bytes move, so 90 s of silence from a part that was moving is
 *   a stopped part, not a slow uplink;
 * - before its first byte, only when the whole tab has sent nothing for a full
 *   `PART_STALL_MS`, or when the part itself has waited `PART_RESPONSE_WAIT_MS`.
 *   Silence before the first byte is not proof of anything: a request the
 *   browser holds for a socket gets no progress at all, and over HTTP/1.1 a
 *   browser opens at most 6 connections per host, shared by every tab. Parts
 *   past the sixth wait for a socket while the first six send (measured: about
 *   12.5 s for 24 MiB parts on a local server in Chromium and WebKit, so
 *   minutes for large parts on an ordinary uplink). While another part of the
 *   tab is moving, the link is busy, not dead; the 5 min cap still ends a part
 *   that will never start, such as a WebKit PUT of a file that changed on disk,
 *   which hangs with no event at all;
 * - after its last byte, when `PART_RESPONSE_WAIT_MS` passes with no answer. A
 *   large part can legitimately sit with storage, or with a proxy that buffers
 *   the whole body, before the answer comes.
 */
const PART_STALL_MS = 90_000
const PART_RESPONSE_WAIT_MS = 300_000

/**
 * When any part in this tab last reported upload progress, on the
 * `performance.now()` clock, so a part that has not sent its first byte can
 * tell a busy link from a dead one (see `PART_STALL_MS`). One timestamp every
 * part writes, read only when a waiting part's watchdog fires. That clock is
 * monotonic, so a change of the wall clock cannot make the tab look silent.
 */
let tabProgressAt = -Infinity

/**
 * How long this tab has sent nothing, counting from `since` at the latest.
 *
 * The stamp lives as long as the module, which in a page is the page, on the
 * one clock that never runs backwards. Tests share the module across tests and
 * install a fresh fake clock for each, so a stamp left by one test would be
 * read by the next as progress on its own clock: `__uploadQueueTesting.reset()`
 * clears it.
 */
function tabQuietFor(since: number, now: number): number {
  return now - Math.max(tabProgressAt, since)
}

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

/** Who is sending the row, as shared storage holds it right now: what the tab
 *  doing the work last wrote, not the copy this tab read when it loaded. */
function storedRow(fileId: string): { ownerTab?: string; heartbeatAt?: number } | undefined {
  try {
    const raw = window.localStorage.getItem('ff-uploads')
    const files = (JSON.parse(raw ?? '{}') as { state?: { files?: UploadFile[] } }).state?.files
    const found = files?.find((f) => f.id === fileId)
    return found ? { ownerTab: found.ownerTab, heartbeatAt: found.heartbeatAt } : undefined
  } catch {
    return undefined
  }
}

/** The heartbeat the row carries in shared storage right now. */
function storedHeartbeat(fileId: string): number | undefined {
  return storedRow(fileId)?.heartbeatAt
}

/** Whether shared storage says another tab of this browser is sending the row now. */
function beatingInAnotherTab(fileId: string, now: number): boolean {
  const stored = storedRow(fileId)
  return (
    stored?.ownerTab !== undefined &&
    stored.ownerTab !== currentTabId() &&
    stored.heartbeatAt !== undefined &&
    now - stored.heartbeatAt < LIVE_WINDOW_MS
  )
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
 * and the skew in `liveUntil` is not made worse. A Resume that waited in the
 * queue is judged as of its click, and whether the server saw the upload move
 * after that click is read from two durations, each on one clock (see
 * `movedSinceClick`), so that adds no comparison across clocks either.
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
  click?: ResumeClick,
): boolean {
  // `attempt` is the caller's own controller, where the caller is the one
  // trying to start a transfer: `resumeUpload` registers it before it asks the
  // server anything, so without excluding it here every resume would count as
  // this tab already sending and the guard would never refuse.
  if (isSendingHere(row.id, attempt)) return false
  // Another tab of this browser is stamping it. The server's
  // `last_activity_at` cannot say so: it records that bytes moved, and a tab
  // that has just taken the upload up has not moved any yet. Read before the
  // exemption below, because a row this tab sent until a moment ago may have
  // been taken up by another tab since.
  if (beatingInAnotherTab(row.id, now)) return true
  if (ownAndRecentAt(row, now)) return false
  // A Resume this tab queued waits for its turn, and nothing stamps the row
  // while it waits, so judged at the turn a click made inside the grace was
  // refused as soon as the wait outlasted it: the tab's own last parts read as
  // somebody else's. It is judged as of the click instead, as it would have
  // been with nothing ahead of it, and only if the server has seen nothing
  // move since: a device that took the upload up during the wait has
  // presigned, which moves `last_activity_at` past the click.
  if (
    click !== undefined &&
    ownAndRecentAt(row, click.requestedAt) &&
    !movedSinceClick(info, click)
  ) {
    return false
  }
  const until = liveUntil(info.last_activity_at)
  return until !== undefined && now < until
}

/** Whether this tab stopped sending the row less than the grace before `at`. */
function ownAndRecentAt(row: UploadFile, at: number): boolean {
  return (
    row.ownerTab === currentTabId() &&
    row.heartbeatAt !== undefined &&
    at - row.heartbeatAt < OWN_STOP_GRACE_MS
  )
}

/** A queued Resume's click, and the `/parts` request its turn made, all on this browser's clock. */
interface ResumeClick {
  /** When the user clicked Resume. */
  requestedAt: number
  /** When the turn sent `GET /parts`. */
  askedAt: number
  /** How long `/parts` took to answer. */
  rtt: number
}

/**
 * Whether the server saw the upload move after the Resume click.
 *
 * `last_activity_at` is on the server's clock and the click on this one, and
 * the two need not agree: a VM clock left behind by a host's sleep is off by
 * minutes, and comparing the stamps directly would move the line between
 * "before the click" and "after it" by that much. So two durations are
 * compared, each read on one clock: how long before its answer the server last
 * saw the upload move (`server_time - last_activity_at`), and how long before
 * the answer arrived the click was (`askedAt - requestedAt + rtt`). The server
 * may have read its clock at any moment of the round trip; counting the whole
 * round trip takes the latest, where an activity after the click is hardest
 * to see, so a doubt reads as moved.
 *
 * Anything missing or unreadable also reads as moved, which leaves the
 * decision to `liveUntil` as before: an older server sends no `server_time`.
 * Nothing on record means nothing moved.
 *
 * One case reads as moved that is not: a `/parts` of this tab's own that timed
 * out here after the server, idle for `RESUME_TOUCH_INTERVAL` (5 min), had
 * already recorded it as activity. The row goes `elsewhere` for the window,
 * which is the safe way to be wrong, and it is rare.
 */
function movedSinceClick(info: ResumeInfo, click: ResumeClick): boolean {
  if (!info.last_activity_at) return false
  if (!info.server_time) return true
  const moved = Date.parse(info.last_activity_at)
  const serverNow = Date.parse(info.server_time)
  if (Number.isNaN(moved) || Number.isNaN(serverNow)) return true
  const sinceMoved = serverNow - moved
  const sinceClick = click.askedAt - click.requestedAt + click.rtt
  return sinceMoved < sinceClick
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

/**
 * A part PUT the watchdog gave up on (see `PART_STALL_MS`). Retryable: the
 * next attempt reads the file first, so a file that changed fails clearly
 * there, and a connection that merely stopped gets a fresh request. Not an
 * `AbortError`, which the caller would take for a user cancel.
 */
export class PartStalledError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PartStalledError'
  }
}

/** A cancellation, as opposed to a failure: the caller reports the two differently. */
function isAbortError(err: unknown): err is DOMException {
  return err instanceof DOMException && err.name === 'AbortError'
}

/**
 * A pinned request found another account signed in, or none (see
 * `RequestOptions.pinSubject`). Nothing is wrong with the upload: it is its
 * owner's to carry on with once they are signed in again, and nobody else's.
 */
function isAccountChange(err: unknown): err is ApiError {
  return err instanceof ApiError && (err.code === 'identity_changed' || err.code === 'session_ended')
}

/**
 * The server refused to presign a part for the upload's own owner: the owner
 * lost access to the project, the asset was trashed, the project deleted, or
 * the upload is no longer open (#510). Nothing will change that, so the row
 * fails with the server's reason and offers no Resume. Retrying it used to run
 * the whole ladder, four minutes, and then offer a Resume that could never work.
 */
class UploadAccessGoneError extends Error {
  readonly permanent = true

  constructor(message: string) {
    super(message)
    this.name = 'UploadAccessGoneError'
  }
}

const ACCESS_GONE_MESSAGE = 'This upload can no longer be sent.'

/**
 * What a failed presign means for its part.
 *
 * A 403, 404 or 409, or a 401 that came back again after a refresh as the same
 * account (a 401 with no code), is the server refusing the owner for good. An
 * account change is final for the row too, and `uploadPart` stops on it. A 401
 * whose refresh got no answer, a 408, a 429, a 5xx or a network error is the
 * moment, not the upload, and is retried like any part failure.
 */
function presignFailure(err: unknown): unknown {
  if (!(err instanceof ApiError)) return err
  const refused =
    err.status === 403 || err.status === 404 || err.status === 409 ||
    (err.status === 401 && err.code === undefined)
  if (!refused) return err
  return new UploadAccessGoneError(err.detail.trim() === '' ? ACCESS_GONE_MESSAGE : err.detail)
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
  ownerId: string | undefined,
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
  // that, so a URL obtained before a long backoff may already be dead. As the
  // upload's owner only: a URL signed for whoever else is signed in now would
  // send this file into their account.
  let presigned_url: string
  try {
    ;({ presigned_url } = await api.post<{ presigned_url: string }>(
      '/upload/presign-part',
      { s3_key: s3Key, upload_id: uploadId, part_number: partNumber },
      { pinSubject: ownerId },
    ))
  } catch (err) {
    throw presignFailure(err)
  }

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
 * - a part that stops moving is aborted by the watchdog and rejects with a
 *   `PartStalledError`, which is retried too. Before the part's first byte,
 *   it ends when no part of the tab has sent anything for `PART_STALL_MS`
 *   (counted from the send at the earliest), or `PART_RESPONSE_WAIT_MS` after
 *   the send. After it, the clock runs `PART_STALL_MS`
 *   from every progress event while bytes remain, and `PART_RESPONSE_WAIT_MS`
 *   from the one that reports the last byte. Progress is measured against the
 *   chunk's own size, since a progress event's `total` is 0 when the length
 *   is not computable;
 * - a non-2xx rejects with `permanent` set for a 4xx, so a status of 0 never
 *   counts as one;
 * - no Content-Type is set. `chunk` is a slice taken without a type, so the
 *   browser sends none, and the presigned URL signs none.
 *
 * The pool signal lives for the whole upload, so the abort listener is removed
 * again whichever way the request settles, and the watchdog's timer with it.
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
    let watchdog: ReturnType<typeof setTimeout> | undefined
    // Set only by the watchdog, just before its own abort, so `onabort` can
    // tell that abort from a cancel and from one the browser started.
    let stalled: PartStalledError | null = null
    // Once set, nothing arms the watchdog again: a stray progress event after
    // the request settled must not leave a timer behind.
    let settled = false
    const settle = () => {
      settled = true
      clearTimeout(watchdog)
      signal.removeEventListener('abort', abort)
    }
    const giveUp = (why: string) => {
      stalled = new PartStalledError(`Part ${partNumber} failed: ${why}`)
      xhr.abort()
      // `abort` fires synchronously on the hung request (measured in WebKit),
      // and `onabort` rejects with `stalled`. Rejecting here too keeps the
      // part from hanging should some browser not fire it.
      settle()
      reject(stalled)
    }
    // Before the first byte: the part ends when the whole tab has sent
    // nothing for `PART_STALL_MS`, or when it has waited the cap itself.
    // Otherwise it looks again when the tab's silence or the cap could next
    // be reached, whichever is sooner.
    const sentAt = performance.now()
    const armBeforeStart = (delay: number) => {
      watchdog = setTimeout(() => {
        const now = performance.now()
        const quiet = tabQuietFor(sentAt, now)
        if (now - sentAt >= PART_RESPONSE_WAIT_MS) {
          giveUp(`not started in ${PART_RESPONSE_WAIT_MS / 60_000} min`)
        } else if (quiet >= PART_STALL_MS) {
          giveUp(`no progress for ${PART_STALL_MS / 1000} s`)
        } else {
          armBeforeStart(Math.min(PART_STALL_MS - quiet, sentAt + PART_RESPONSE_WAIT_MS - now))
        }
      }, delay)
    }
    // After it: every byte sent re-arms the stall clock, and the last one
    // swaps it for the longer wait on the answer.
    const arm = (sent: number) => {
      if (settled) return
      clearTimeout(watchdog)
      const done = sent >= chunk.size
      watchdog = setTimeout(
        () => giveUp(
          done
            ? `no answer ${PART_RESPONSE_WAIT_MS / 60_000} min after its last byte`
            : `no progress for ${PART_STALL_MS / 1000} s`,
        ),
        done ? PART_RESPONSE_WAIT_MS : PART_STALL_MS,
      )
    }

    xhr.upload.onprogress = (event) => {
      onBytes(event.loaded)
      // An event that reports nothing sent says nothing moved.
      if (event.loaded <= 0) return
      tabProgressAt = performance.now()
      arm(event.loaded)
    }
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
    // take minutes and must not be cut off, and `timeout` bounds the whole
    // request, not the silence in it -- that is the watchdog's job. The
    // handler stays so that one set later, here or by a browser, fails the
    // part retryably instead of leaving the promise unsettled, since a timeout
    // fires neither load nor error.
    xhr.ontimeout = () => {
      settle()
      reject(new TypeError(`Part ${partNumber} failed: timed out`))
    }
    // Not every abort is a cancel. A browser aborts an in-flight XHR on its
    // own, on window.stop() or when Stop or Esc cancels a pending navigation,
    // where fetch rejected with a TypeError and the part was retried. Only an
    // abort of the signal may come out as an AbortError: the caller takes that
    // for a user cancel and discards every part the backend holds.
    //
    // The watchdog's own abort is a failure too, and comes out as the
    // `PartStalledError` it set. A cancel wins over it.
    xhr.onabort = () => {
      settle()
      reject(
        signal.aborted
          ? new DOMException(`Part ${partNumber} cancelled`, 'AbortError')
          : stalled ?? new TypeError(`Part ${partNumber} failed: aborted`),
      )
    }

    xhr.open('PUT', url)
    signal.addEventListener('abort', abort, { once: true })
    // An empty part has nothing to send, so it waits only on its answer.
    if (chunk.size === 0) arm(0)
    else armBeforeStart(PART_STALL_MS)
    try {
      xhr.send(chunk)
    } catch (err) {
      settle()
      reject(err)
    }
  })
}

/** Where a part takes its slots, and who hears that it got its first one. */
interface PartSlots {
  budget: PartBudget
  fileKey: string
  /** The account the upload belongs to; every presign is sent as it. */
  ownerId?: string
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
 * minutes would delay the error message without ever changing the outcome. So
 * is a presign the server refused for good, or one that found another account
 * signed in (see `presignFailure`).
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
 *
 * Every retry reads one byte of the file before it asks for a URL (see
 * lib/upload-readable.ts): a file that changed or moved while the part backed
 * off makes `xhr.send` hang in WebKit, so a retry must find that out first.
 * The read is the first step of the attempt, after `acquire()` and before the
 * presign, so the rules above hold untouched: the slot is taken before the
 * presign as ever, and the read holds it for a few milliseconds, as the
 * presign that follows does. Reading before `acquire()` would put an `await`
 * between `woke()` and `acquire()`, which the contract forbids. A file that
 * fails the read is not retried: the attempt ends, the `finally` gives the
 * slot back, and `sleeping()` is not called because there is no sleep to
 * match. The first attempt is not read; a first attempt that hangs is for the
 * part watchdog, and its retry reads.
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
      if (attempt > 1) await assertReadable(file)
      return await uploadPartOnce(file, s3Key, uploadId, partNumber, controller, chunkSize, onBytes, slots.ownerId)
    } catch (err) {
      // The next attempt sends the part from its first byte again, so what
      // this one got across no longer counts.
      onBytes(0)
      if (signal.aborted) throw err
      if (isAbortError(err)) throw err
      // The handle stays stale however often it is tried.
      if (err instanceof FileUnreadableError) throw err
      if ((err as PartUploadError)?.permanent) throw err
      // Another account, or none, is signed in: no retry can be sent as the owner.
      if (isAccountChange(err)) throw err
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
 *
 * `opts.ownerId` is the account the upload belongs to. Every presign is pinned
 * to it, so no part is ever signed for another account.
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
    ownerId?: string
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
          ownerId: opts.ownerId,
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
   * added, never the profile in `useAuthStore`, which is fetched once and goes
   * stale when another tab signs in. Every request the row's run makes is
   * pinned to it, and only this account sees the row (`visibleFiles`). A row
   * is never added without one: with no token there is no row.
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
  /**
   * A Discard of this row could not finish, and the row was kept saying why.
   * The panel then offers Dismiss as well as Discard: a Discard that keeps
   * failing (storage down, an abort the server keeps refusing) must not leave
   * a row that can neither be resumed nor removed. Cleared when a Resume takes
   * the row up.
   */
  discardFailed?: true
}

/**
 * A row that is on its way without another click: waiting for its turn (a new
 * file, or a resume the user asked for), starting, sending, or being processed.
 * The sidebar's badge counts exactly these; the panel's Active tab adds the rows
 * another tab is sending.
 *
 * A resume waiting for its turn is `interrupted` as far as storage and the
 * server are concerned, which is why it needs saying here.
 */
export function isOnItsWay(f: UploadFile): boolean {
  return (
    f.status === 'queued' || f.status === 'starting' || f.status === 'uploading' ||
    f.status === 'processing' || (f.status === 'interrupted' && f.queuedResume === true)
  )
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
  /** The server's clock as it answered; see `movedSinceClick`. Absent from an older server. */
  server_time?: string | null
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

export interface UploadStore {
  files: UploadFile[]
  /**
   * The account this tab is acting as, as far as the store knows: the token's
   * `sub` when the store loaded, then whatever another tab's sign-in or
   * sign-out said, or a start or an add found. Views show only its rows. Kept
   * in state, not read from the token at render, so a change of account
   * re-renders the views even though no row changed.
   */
  subject: string | null
  /** Bumped when something here has changed an asset's versions server-side in
   *  a way no transcode event announces -- today, discarding an upload, which
   *  deletes the version. A screen showing a version list watches this so it
   *  does not go on offering a version that is gone.
   *
   *  A counter and not a timestamp: two discards inside one millisecond are a
   *  real thing, and `Date.now()` reports them as no change at all. */
  versionsRevision: number
  /**
   * Bumped when a run ends and when a Discard starts or ends, and for nothing
   * else. `canResume` reads those (the runs, the Discards in flight), which no
   * row field mirrors, so a view that selects `canResume(id)` is only told it
   * changed when something is set; this is that something. Never saved.
   */
  runsRevision: number
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
   * rule allows it at that moment. With nobody signed in nothing is added and
   * this returns null; the caller tells the user to sign in.
   */
  startUpload: (file: File, projectId: string, assetName: string, projectName?: string, folderId?: string | null) => string | null
  /** The same for a new version of `assetId`. */
  startVersionUpload: (file: File, assetId: string, assetName: string, projectId: string, projectName?: string) => string | null
  /**
   * Adds a whole drop or pick, in order, as one drop. Returns the row ids in
   * the order given, or none at all when nobody is signed in.
   */
  startUploads: (items: Array<{ file: File; assetName: string }>, projectId: string, projectName?: string, folderId?: string | null) => string[]
  /** Queues an interrupted row to carry on with `file`, ahead of every file not yet started. */
  resumeUpload: (fileId: string, file: File) => void
  /** Resolves to a message saying why nothing was discarded, or null. */
  discardUpload: (fileId: string) => Promise<string | null>
  /**
   * Cancels a row by where it stands (spec, "Row lifecycle"): one not yet
   * started leaves the list; one whose initiate is out is thrown away when it
   * answers; a resume that has sent nothing goes back to plain `interrupted`;
   * one already sending is aborted and discarded.
   */
  cancelUpload: (fileId: string) => void
  /** Cancels every row still waiting for its turn, never one whose turn has begun. */
  cancelAllQueued: () => void
  /** Puts a refused row back in the queue, next, while this tab still holds its `File`. */
  retryUpload: (fileId: string) => void
  /** Whether `retryUpload` would start this row again. */
  canRetry: (fileId: string) => boolean
  /** Whether `resumeUpload` would take this row up now; the panel offers Resume only then. */
  canResume: (fileId: string) => boolean
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
  ownerId: string | undefined,
): Promise<'processing' | 'complete' | null> {
  const asset = await api.get<AssetResponse>(`/assets/${assetId}`, { pinSubject: ownerId }).catch(() => null)
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
async function finishAssembledUpload(versionId: string, ownerId: string | undefined): Promise<boolean> {
  try {
    const info = await api.get<ResumeInfo>(`/upload/${versionId}/parts`, { pinSubject: ownerId })
    if (info.state !== 'assembled') return false
    await api.post('/upload/complete', {
      s3_key: info.s3_key,
      upload_id: info.upload_id,
      asset_id: info.asset_id,
      version_id: info.version_id,
      parts: [],
    }, { pinSubject: ownerId })
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
        // `/me/assets?filter=owned` lists the assets this account created, so
        // the creator is the owner, and the row shows to them like any other.
        ownerId: a.created_by,
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
    files: s.files.map((f) => (f.id === fileId ? { ...f, error: message, discardFailed: true as const } : f)),
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
  ownerId: string | undefined,
): Promise<void> {
  // As the owner only. Once another account is signed in the abort is not
  // sent, and the reaper reclaims the upload.
  await api.post('/upload/abort', { ...ids, discard: true }, { pinSubject: ownerId }).catch(() => {})
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
  /** Cancelled while its initiate was out: the row leaves the list once the run has settled. */
  removeWhenSettled?: true
  /** A resume cancelled while it asked `/parts`: it sends nothing and aborts nothing. */
  stoodDown?: true
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
/** When the probe's pending try is due (`Date.now()` clock); meaningful only while `probeTimer` is set. */
let probeDueAt = 0

let dropSeqs = 0

/**
 * Rows whose Discard is waiting on the server, counted per call. A Resume of
 * one would start sending into the upload the Discard is about to abort.
 */
const discarding = new Map<string, number>()

/**
 * When the user clicked Resume in this tab, for a row whose resume is waiting
 * for its turn. Tab memory, like the `File`: a reload ends the wait anyway.
 * `activeElsewhere` judges the tab's own grace from it; see there.
 */
const resumeRequestedAt = new Map<string, number>()

/** A row refused before it started, whose `File` this tab still holds. */
function retryable(row: UploadFile): boolean {
  return row.status === 'failed' && row.failedBeforeStart === true && row.retryable === true && fileRefs.has(row.id)
}

/**
 * Whether a Resume of this row would be taken up now: it is a stopped upload
 * with a version to come back to, it is not already waiting for its turn, no
 * run of it is still settling, and no Discard of it is out. The one definition
 * `resumeUpload` refuses on and the panel's `canResume` offers on.
 */
function resumableNow(row: UploadFile | undefined): row is UploadFile {
  return (
    row !== undefined && row.status === 'interrupted' && !!row.versionId && !row.queuedResume &&
    !runners.has(row.id) && !discarding.has(row.id)
  )
}

/** Tells every view of `canResume` to look again; see `UploadStore.runsRevision`. */
function noteRunsChanged(): void {
  useUploadStore.setState((s) => ({ runsRevision: s.runsRevision + 1 }))
}

/** A row id. Two drops of the same `File` are two rows. */
const newRowId = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`

const REFUSED_MESSAGE = 'The server refused this upload.'
const ACCOUNT_SWITCHED_MESSAGE = 'Another account signed in. Add these files again after signing back in.'
const SIGNED_OUT_MESSAGE = 'Signed out in another tab. Add these files again after signing in.'

/** Why a row could not start as its owner: someone else is signed in, or nobody is. */
function accountMessage(now: string | null): string {
  return now === null ? SIGNED_OUT_MESSAGE : ACCOUNT_SWITCHED_MESSAGE
}

/** A new row that cannot start because its owner is no longer signed in. */
function accountFailure(now: string | null): Partial<UploadFile> {
  return {
    status: 'failed',
    failedBeforeStart: true,
    retryable: true,
    holdReason: undefined,
    progress: 0,
    error: accountMessage(now),
  }
}

/**
 * The account change rules (spec goal 9), applied at once and before any
 * further request: every row of another account that has not started fails,
 * saved with its owner, and every resume of another account that waits for its
 * turn goes back to plain `interrupted`, still resumable. Rows whose turn has
 * begun are left to their run: each request it makes is pinned to the row's
 * owner, and its answer decides between `interrupted` and failed. Applying the
 * same account twice changes nothing.
 */
function applySubject(next: string | null): void {
  const others = (f: UploadFile) => f.ownerId !== next && !runners.has(f.id)
  const files = useUploadStore.getState().files
  const newRows = new Set(files.filter((f) => f.status === 'queued' && others(f)).map((f) => f.id))
  const resumes = new Set(files.filter((f) => f.status === 'interrupted' && f.queuedResume && others(f)).map((f) => f.id))

  const probe = queue.hold.probeId
  newRows.forEach((id) => queue.remove(id))
  resumes.forEach((id) => {
    queue.remove(id)
    fileRefs.delete(id)
    resumeRequestedAt.delete(id)
  })
  useUploadStore.setState((s) => ({
    subject: next,
    files: s.files.map((f) => (newRows.has(f.id)
      ? { ...f, ...accountFailure(next) }
      : resumes.has(f.id)
        ? { ...f, queuedResume: undefined, holdReason: undefined }
        : f)),
  }))
  // The probe was one of them: the hold passes to whoever still waits, or ends.
  if (probe !== null && (newRows.has(probe) || resumes.has(probe)) && !runners.has(probe)) passOnProbe()
  pump()
}

/**
 * The account signed in now, read from the token at the point of use. Another
 * tab's sign-in reaches this one as a `storage` event, which can arrive after a
 * start this tab is about to make, so every start reads the token again, and
 * applies a change it finds there as if the event had come.
 */
function noticeSubject(): string | null {
  const now = currentSubject()
  if (now !== useUploadStore.getState().subject) applySubject(now)
  return now
}

/**
 * A row came to its turn owned by someone other than whoever is signed in. A
 * new file fails, and a resume goes back to plain `interrupted`, its parts
 * kept for its owner. Neither asks the server anything.
 */
function refuseTurn(row: UploadFile, kind: 'new' | 'resume', now: string | null): void {
  forgetQueued(row.id)
  if (kind === 'new') {
    patchRow(row.id, accountFailure(now))
    return
  }
  fileRefs.delete(row.id)
  resumeRequestedAt.delete(row.id)
  patchRow(row.id, { queuedResume: undefined, holdReason: undefined })
}

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
          // Read for each start: a row is started only as the account that added it.
          const now = noticeSubject()
          const row = rowById(id)
          const kind = turnKind(row)
          if (!row || !kind) {
            // Gone, cancelled or already changed by something else: it gives up its place.
            queue.remove(id)
            skipped = true
            continue
          }
          if (row.ownerId === undefined || row.ownerId !== now) {
            refuseTurn(row, kind, now)
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
  noteRunsChanged()
  // Cancelled while starting: whatever the initiate created has been thrown
  // away by now, so there is nothing left for the row to say.
  if (runner.removeWhenSettled) {
    useUploadStore.setState((s) => ({ files: s.files.filter((f) => f.id !== id) }))
  }
  const row = rowById(id)
  // The hold's probe ended without a turn to come back to and without passing
  // the role on: its run threw something no branch of it settles (a refused
  // save, say). Nothing would ever try again, and `nextToStart` starts nothing
  // while a probe is set, so the role passes on here, to the next waiting row.
  if (queue.hold.probeId === id && turnKind(row) === null) passOnProbe()
  const stillWaiting = turnKind(row) !== null || queue.hold.probeId === id
  if (!stillWaiting && !row?.retryable) {
    fileRefs.delete(id)
    startTargets.delete(id)
  }
  pump()
}

/**
 * The probe's next try, after the backoff. The timer tries whichever row is the
 * probe when it fires: a row that takes the role over while it runs
 * (`holdRow`) makes the try the old probe was waiting for.
 */
function scheduleProbe(): void {
  if (probeTimer !== null) clearTimeout(probeTimer)
  const delay = queue.hold.nextDelayMs()
  probeDueAt = Date.now() + delay
  probeTimer = setTimeout(() => {
    probeTimer = null
    const id = queue.hold.probeId
    if (id !== null) retryProbe(id)
  }, delay)
}

function retryProbe(id: string): void {
  if (queue.hold.probeId !== id) return
  const now = noticeSubject()
  // An account change just failed it and passed the hold on.
  if (queue.hold.probeId !== id) return
  const row = rowById(id)
  const kind = turnKind(row)
  if (!row || !kind) {
    passOnProbe()
    return
  }
  if (row.ownerId === undefined || row.ownerId !== now) {
    refuseTurn(row, kind, now)
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
  scheduleProbe()
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
 * in line behind it among the rows the outage held back, at the place it was
 * queued in, so they start again in the order they were dropped and keep their
 * places in the panel. A resume goes back to being a queued resume, never to
 * `queued`: it has an upload on the server to come back to.
 *
 * Rows that were initiating together fail in whatever order the network gives
 * up on them, and the first to fail became the probe. When this row was queued
 * before that probe and the probe is only waiting out its backoff, this row
 * takes the role over, on the same backoff, and the probe waits in line: the
 * probe is the first to start once the way is open, and that must be the
 * earliest file. A probe whose try is already out keeps the role for that try,
 * as there is never more than one try at a time; when that try fails as well,
 * the earliest row waiting behind it takes the role over for the next one. A
 * row that takes the role over with a retry-after longer than the wait left
 * waits for the retry-after, and the backoff doubles from it.
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
    // The probe failed (again). A row that went back while its try was out,
    // queued before it, makes the next try instead.
    const first = queue.firstNext()
    if (first && queue.queueSeq(first.id) < queue.queueSeq(id)
      && queue.hold.takeOver(first.id, reason, queueEntry(row, kind))) {
      patchRow(id, { ...waiting, holdReason: undefined })
      patchRow(first.id, { holdReason: reason })
    } else {
      patchRow(id, { ...waiting, holdReason: reason })
    }
    scheduleProbe()
    return
  }
  const probe = queue.hold.probeId
  const probeRow = probe === null ? undefined : rowById(probe)
  // Waiting for its turn, so between tries: a probe whose try is out is `starting`.
  const probeKind = turnKind(probeRow)
  if (probeRow && probeKind && queue.queueSeq(id) < queue.queueSeq(probeRow.id)
    && queue.hold.takeOver(id, reason, queueEntry(probeRow, probeKind))) {
    patchRow(probeRow.id, { holdReason: undefined })
    patchRow(id, { ...waiting, holdReason: reason })
    // The try it takes over is due when the old probe's was, unless it was told to wait longer.
    const asked = usableRetryAfter(retryAfterMs)
    if (asked !== undefined && probeTimer !== null && asked > probeDueAt - Date.now()) {
      queue.hold.begin(id, reason, retryAfterMs)
      scheduleProbe()
    }
    return
  }
  queue.enqueue([queueEntry(row, kind)], 'held')
  patchRow(id, { ...waiting, holdReason: undefined, queueSeq: queue.queueSeq(id) })
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
 *
 * So does an account change: the pinned request found another account signed
 * in, or none, or the answer came after the change. The row fails saying which,
 * and keeps its `File` for a Retry should its owner sign back in here. No ids
 * came back, so there is nothing on the row to resume; anything an answer lost
 * on the way may have created is left to the reaper, as for any hold.
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
  const now = noticeSubject()
  if (outcome.kind === 'account' || outcome.kind === 'session_ended' || now !== row.ownerId) {
    // A hold it was probing has not been answered: the next row probes.
    if (outcome.kind === 'hold') handOffProbe(id)
    else endHoldIfProbe(id)
    patchRow(id, accountFailure(now))
    return
  }
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
 * A run that ends before it has asked the server anything cannot say the way to
 * the server is open, so a hold it was probing passes to the next waiting row,
 * as when its probe is cancelled. Left alone, the hold would keep a probe that
 * never tries again and no row would start.
 */
function handOffProbe(id: string): void {
  if (queue.hold.probeId === id) passOnProbe()
}

/** What a row says about a failed read: the browser's own words, or a plain fallback. */
function readFailureMessage(err: unknown): string {
  // Not `instanceof Error`: a `DOMException` need not be one in every realm.
  const message = typeof err === 'object' && err !== null ? (err as { message?: unknown }).message : undefined
  const said = typeof message === 'string' ? message.trim() : ''
  return said === '' ? FILE_READ_FAILED_MESSAGE : said
}

/**
 * A new file whose turn came could not be read (spec goal 5). Nothing was
 * created, so the row fails as any refusal at initiate does.
 *
 * A file that changed or moved (`FileUnreadableError`) stays unreadable -- its
 * `File` handle is stale -- so Retry is not offered and only adding the file
 * again helps. Any other failure to read says nothing about the file, so Retry
 * is offered, as for a refusal. Either way the row was about to ask the server
 * something it now will not, so a hold it was probing passes on. A row cancelled
 * while it was read is removed when its run ends, whatever it says until then.
 */
function failUnreadableBeforeStart(id: string, err: unknown): void {
  handOffProbe(id)
  patchRow(id, {
    status: 'failed',
    failedBeforeStart: true,
    retryable: !(err instanceof FileUnreadableError),
    holdReason: undefined,
    progress: 0,
    error: readFailureMessage(err),
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
  // Every request below is sent as this account, or not at all.
  const owner = rowById(id)?.ownerId
  const asOwner = { pinSubject: owner }

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

    // Before the server hears of the file, so a file that changed or moved
    // while it waited creates nothing (goal 4) and the queue moves on.
    try {
      await assertReadable(file)
    } catch (err) {
      failUnreadableBeforeStart(id, err)
      return
    }
    // Cancelled while it was read: nothing has been sent, and nothing will be.
    if (controller.signal.aborted) {
      handOffProbe(id)
      throw new DOMException('Upload cancelled', 'AbortError')
    }
    // The account may have changed while the file was read.
    const now = noticeSubject()
    if (now !== owner) {
      handOffProbe(id)
      patchRow(id, accountFailure(now))
      return
    }

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
        }, asOwner)
        : await api.post<VersionInitiateResponse>(`/assets/${target.assetId}/versions`, {
          project_id: projectId,
          asset_name: sentName,
          original_filename: file.name,
          file_size_bytes: file.size,
          mime_type: file.type,
        }, asOwner)
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
    // The answer came after another account signed in, or after the sign-out.
    // What it created is the owner's: kept on the row, `interrupted`, to be
    // resumed or discarded once they are signed in again. Nothing more is sent.
    const ownerGone = noticeSubject() !== owner
    patchRow(id, {
      uploadId: upload_id, s3Key: s3_key, assetId: asset_id, versionId: version_id,
      // A cancel made while the initiate was out stands.
      ...(cancelled ? {} : { status: ownerGone ? 'interrupted' as const : 'uploading' as const }),
    })
    // A new version exists on the server from this answer, and a screen
    // showing the asset's versions is told now rather than guessing at when.
    if (target.kind === 'version') {
      useUploadStore.setState((s) => ({ versionsRevision: s.versionsRevision + 1 }))
    }
    pump()
    // Cancelled while the initiate was out: what it created is thrown away below.
    if (cancelled) throw new DOMException('Upload cancelled', 'AbortError')
    if (ownerGone) return

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
          await api.patch(`/assets/${asset_id}`, { name: nameAfterInitiate }, asOwner)
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
        ownerId: owner,
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
    }, asOwner)

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
        ? await completedVersionStatus(asset_id, version_id, owner)
        : null
      if (landed) {
        applyLanded(landed)
      } else if (!userCancelled()) {
        // Nothing was destroyed, so nothing is lost: the multipart upload is
        // still open and every part already sent is still held. `interrupted`
        // says that, where `failed` claimed the opposite. A version that never
        // got as far as a multipart upload has nothing to come back to and
        // stays `failed`, as does one whose owner can no longer send to it.
        // An account change is no failure of the upload's, so says nothing.
        patchRow(id, {
          status: upload_id && version_id && !(err instanceof UploadAccessGoneError) ? 'interrupted' : 'failed',
          error: isAccountChange(err) ? undefined : err instanceof Error ? err.message : 'Upload failed',
        })
        // Only after a completion was attempted can the object be whole with
        // the version still `uploading`, and only then is it worth a request
        // to find out.
        if (completionAttempted && version_id && await finishAssembledUpload(version_id, owner)) {
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
      await abortCancelled(useUploadStore.setState, { s3_key, upload_id, version_id }, owner)
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
  // Every request below is sent as this account, or not at all.
  const owner = row.ownerId
  const asOwner = { pinSubject: owner }
  /** Back to plain `interrupted`, still resumable, as the queued resume was. */
  const standDown = (patch: Partial<UploadFile> = {}) =>
    updateFile({ status: 'interrupted', resuming: undefined, progress: row.progress, ...patch })

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
    const askedAt = Date.now()
    try {
      info = await api.get<ResumeInfo>(`/upload/${versionId}/parts`, asOwner)
    } catch (err) {
      const outcome = isAbortError(err) || isFinalRefusal(err) ? null : classifyInitiateError(err)
      // Cancelled while it asked: the row is already plain `interrupted` again,
      // whatever this answer says. Only the hold has to hear it.
      if (runner.stoodDown) {
        if (outcome?.kind === 'hold' && queue.hold.probeId === id) passOnProbe()
        else endHoldIfProbe(id)
        return
      }
      // Its owner is no longer signed in: the upload waits for them, as it was.
      const ownerGone = outcome !== null &&
        (outcome.kind === 'account' || outcome.kind === 'session_ended' || noticeSubject() !== owner)
      if (ownerGone && rowById(id)?.status === 'starting') {
        if (outcome.kind === 'hold') handOffProbe(id)
        else endHoldIfProbe(id)
        resumeRequestedAt.delete(id)
        standDown()
        return
      }
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
    // Cancelled while it asked. Nothing has been sent and nothing is thrown
    // away: the parts on the server are what a later Resume carries on from.
    if (runner.stoodDown) return
    // The answer came after another account signed in, or after the sign-out.
    // It is kept for the owner, and nothing is sent.
    if (noticeSubject() !== owner) {
      resumeRequestedAt.delete(id)
      standDown({ uploadId: info.upload_id, s3Key: info.s3_key, versionId: info.version_id, assetId: info.asset_id })
      return
    }

    // Two tabs sending the same part numbers into one multipart upload leave
    // the completing tab with ETags that no longer match what is stored.
    // Judged as of the click that queued it, which this turn now uses up.
    const answeredAt = Date.now()
    const requestedAt = resumeRequestedAt.get(id)
    const click = requestedAt === undefined ? undefined : { requestedAt, askedAt, rtt: answeredAt - askedAt }
    const elsewhere = activeElsewhere(row, info, answeredAt, controller, click)
    resumeRequestedAt.delete(id)
    if (elsewhere) {
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
      // The bytes are needed only now: after `/parts` has said so, and not for
      // an `assembled` upload, which the picked file may be unreadable for and
      // still complete. A file that changed or moved while the Resume waited
      // ends the run here, `interrupted` with the reason through the `catch`
      // below, before any presign. By now `/parts` has answered, so the hold
      // this row was probing is already over.
      try {
        await assertReadable(file)
      } catch (err) {
        throw err instanceof FileUnreadableError ? err : new Error(readFailureMessage(err))
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
          ownerId: owner,
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
    }, asOwner)

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
        ? await completedVersionStatus(askAbout, versionId, owner)
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
          // Back to resumable unless the server said this upload is over, or
          // that its owner can no longer send to it. Nothing was aborted here
          // either, so the parts sent this time are held too and the next
          // attempt starts from further along. An account change says nothing.
          status: isFinalRefusal(err) || err instanceof UploadAccessGoneError ? 'failed' : 'interrupted',
          resuming: undefined,
          progress: 0,
          error: isAccountChange(err) ? undefined : err instanceof Error ? err.message : 'Upload failed',
        })
      }
    }

    if (userCancelled() && info) {
      await abortCancelled(useUploadStore.setState, {
        s3_key: info.s3_key,
        upload_id: info.upload_id,
        version_id: info.version_id,
      }, owner)
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
 *
 * Each row belongs to the account whose token is in storage now. With no token
 * nothing is added and none is returned: an upload nobody owns could never be
 * started as anyone. A token for an account the store has not heard of yet is
 * another tab's sign-in whose `storage` event is still on its way. The views
 * follow it now, so the rows just added show; the rows of the account before
 * it are hidden, and each fails at its turn, or when the event arrives.
 */
function enqueueNew(
  set: (fn: (s: UploadStore) => Partial<UploadStore>) => void,
  items: Array<{ file: File; assetName: string; target: StartTarget }>,
  projectId: string,
  projectName: string | undefined,
): string[] {
  if (items.length === 0) return []
  const owner = currentSubject()
  if (owner === null) return []
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
      ownerId: owner,
      dropSeq,
      ...(target.kind === 'version' ? { assetId: target.assetId } : {}),
    }
  })
  queue.enqueue(rows.map((r) => queueEntry(r, 'new')), 'back')
  for (const r of rows) r.queueSeq = queue.queueSeq(r.id)
  try {
    // Newest first, as rows have always been listed.
    set((s) => ({ files: [...rows.slice().reverse(), ...s.files], panelOpen: true, subject: owner }))
  } finally {
    // The rows are in state even when saving them threw: they still get their turn.
    pump()
  }
  return rows.map((r) => r.id)
}

const storeCreator: StateCreator<UploadStore, [['zustand/persist', unknown]]> = (set, get) => ({
  files: [],
  subject: currentSubject(),
  versionsRevision: 0,
  runsRevision: 0,
  panelOpen: false,
  historyLoaded: false,
  historyHasMore: true,
  historyLoading: false,
  historySkip: 0,

  setPanelOpen: (open) => set({ panelOpen: open }),
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),

  startUpload: (file, projectId, assetName, projectName, folderId) =>
    enqueueNew(set, [{ file, assetName, target: { kind: 'asset', folderId: folderId ?? null } }], projectId, projectName)[0] ?? null,

  startUploads: (items, projectId, projectName, folderId) =>
    enqueueNew(
      set,
      items.map(({ file, assetName }) => ({ file, assetName, target: { kind: 'asset' as const, folderId: folderId ?? null } })),
      projectId,
      projectName,
    ),

  startVersionUpload: (file, assetId, assetName, projectId, projectName) =>
    enqueueNew(set, [{ file, assetName, target: { kind: 'version', assetId } }], projectId, projectName)[0] ?? null,

  resumeUpload: (fileId, file) => {
    const row = get().files.find((f) => f.id === fileId)
    // Not while a run of this row is still settling: a run whose transfer
    // broke is still asking the server what became of it, and its answer
    // would land on the row a second run is sending. Nor while a Discard of
    // it is waiting on the server, which is about to abort what it would send.
    if (!resumableNow(row)) return
    fileRefs.set(fileId, file)
    resumeRequestedAt.set(fileId, Date.now())
    // A Resume goes ahead of every file not yet started, behind the ones
    // already running, and takes its turn like them -- so it never sends
    // beside three active files or outside the part budget.
    queue.enqueue([queueEntry(row, 'resume')], 'next')
    set((s) => ({
      files: s.files.map((f) => (f.id === fileId
        ? {
            ...f,
            queuedResume: true as const,
            dropSeq: ++dropSeqs,
            queueSeq: queue.queueSeq(fileId),
            error: undefined,
            discardFailed: undefined,
          }
        : f)),
    }))
    pump()
  },

  discardUpload: async (fileId) => {
    // Counted for as long as the server is being asked: see `resumeUpload`.
    discarding.set(fileId, (discarding.get(fileId) ?? 0) + 1)
    noteRunsChanged()
    try {
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
        resumeRequestedAt.delete(fileId)
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
    } finally {
      const left = (discarding.get(fileId) ?? 1) - 1
      if (left > 0) discarding.set(fileId, left)
      else discarding.delete(fileId)
      noteRunsChanged()
    }
  },

  cancelUpload: (fileId) => {
    const row = get().files.find((f) => f.id === fileId)
    if (!row) return
    const runner = runners.get(fileId)

    // Not started, or the hold's probe between tries: nothing is on the
    // server, so the row only leaves. A probe passes the hold on as it goes.
    if (row.status === 'queued' && !runner) {
      fileRefs.delete(fileId)
      startTargets.delete(fileId)
      set((s) => ({ files: s.files.filter((f) => f.id !== fileId) }))
      forgetQueued(fileId)
      return
    }

    // A queued or held resume goes back to plain `interrupted`, still
    // resumable. Nothing is aborted: its parts on the server are the point.
    if (row.status === 'interrupted') {
      if (row.queuedResume) {
        fileRefs.delete(fileId)
        resumeRequestedAt.delete(fileId)
        set((s) => ({
          files: s.files.map((f) => (f.id === fileId ? { ...f, queuedResume: undefined, holdReason: undefined } : f)),
        }))
        forgetQueued(fileId)
      }
      return
    }

    // A resume whose turn has begun and that has sent nothing yet: the same.
    // Its run keeps its place until `/parts` answers, then ends quietly.
    if (row.status === 'starting' && row.resuming && runner) {
      runner.stoodDown = true
      resumeRequestedAt.delete(fileId)
      set((s) => ({
        files: s.files.map((f) => (f.id === fileId
          ? { ...f, status: 'interrupted' as const, resuming: undefined, holdReason: undefined }
          : f)),
      }))
      return
    }

    // Initiating: what the initiate creates is thrown away when it answers
    // (see `runNew`), and only then does the row leave.
    if (row.status === 'starting' && runner) runner.removeWhenSettled = true
    if (!runner) {
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

  cancelAllQueued: () => {
    // Each row by its own rule. A held probe hands the hold down the line as
    // it goes, and the last one out finds nobody waiting and ends it.
    const waiting = visibleFiles(get()).filter(
      (f) => (f.status === 'queued' || (f.status === 'interrupted' && f.queuedResume)) && !runners.has(f.id),
    )
    for (const f of waiting) get().cancelUpload(f.id)
  },

  retryUpload: (fileId) => {
    const row = get().files.find((f) => f.id === fileId)
    if (!row || !retryable(row) || runners.has(fileId)) return
    // Next, like a Resume: ahead of every file not yet started, and during a
    // hold behind the probe.
    queue.enqueue([queueEntry(row, 'new')], 'next')
    set((s) => ({
      files: s.files.map((f) => (f.id === fileId
        ? {
            ...f,
            status: 'queued' as const,
            progress: 0,
            error: undefined,
            failedBeforeStart: undefined,
            retryable: undefined,
            dropSeq: ++dropSeqs,
            queueSeq: queue.queueSeq(fileId),
          }
        : f)),
    }))
    pump()
  },

  canRetry: (fileId) => {
    const row = get().files.find((f) => f.id === fileId)
    return row !== undefined && retryable(row)
  },

  canResume: (fileId) => resumableNow(get().files.find((f) => f.id === fileId)),

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
    // The signed-in account's own: another account's rows are not this one's to clear.
    set((s) => ({ files: s.files.filter((f) => f.status !== 'complete' || f.ownerId !== s.subject) }))
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
    //
    // Only the signed-in account's rows: the others are hidden here, and are
    // theirs to reconcile once they are signed in again.
    const now = Date.now()
    const visible = new Set(visibleFiles(get()).map((f) => f.id))
    if (get().files.some((f) => f.status === 'elsewhere' && visible.has(f.id))) {
      set((s) => ({
        files: s.files.map((f) => {
          if (f.status !== 'elsewhere' || !visible.has(f.id)) return f
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
      (f) => (f.status === 'processing' || f.status === 'interrupted') && f.assetId && !f.queuedResume &&
        visible.has(f.id),
    )
    if (!watched.length) return
    try {
      // `null` is "no answer, ask again"; `'gone'` is an answer that is final.
      // Asked as the row's owner: sent as an account that signed in since, a
      // 403 would read as the asset gone and fail the owner's row for good.
      const results = await Promise.all(
        watched.map((f) =>
          api.get<AssetResponse>(`/assets/${f.assetId}`, { pinSubject: f.ownerId }).catch((err): 'gone' | null =>
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
 * The queue's in-memory markers are never saved, nor its sequence numbers: the
 * panel lists a row that has one before any that has none, and a number from an
 * earlier page load means nothing against this load's.
 */
function savedRow(f: UploadFile): UploadFile | null {
  const kept: UploadFile = { ...f }
  delete kept.queuedResume
  delete kept.resuming
  delete kept.holdReason
  // Sequence numbers are counters of this page load: a saved one would outrank
  // the first drop of the next load, which counts from 1 again.
  delete kept.dropSeq
  delete kept.queueSeq
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
 * A row this tab owns is written as this tab has it: nobody else is in a
 * position to know better -- unless another tab has stamped it more recently,
 * which means that tab took the upload up after this one stopped.
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
      if (here.ownerTab === mine) {
        // Unless another tab has stamped it since this one last did: that tab
        // took the upload up after this one stopped, and this copy is the
        // stale one. Written back over it, the other tab's stamp would be gone
        // by the time this tab's Resume asks who is sending it.
        const takenUp = row.ownerTab !== undefined && row.ownerTab !== mine &&
          (row.heartbeatAt ?? 0) > (here.heartbeatAt ?? 0)
        if (takenUp) byId.set(row.id, row)
        continue
      }
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

/**
 * The rows of the account signed in now (spec goal 10). Every row stays in
 * state whichever account added it, so that the owner finds it again after
 * signing back in; views, counts and polls see only these. A row with no owner
 * is nobody's and shows to nobody, and with nobody signed in nothing shows.
 */
export function visibleFiles(state: UploadStore): UploadFile[] {
  return state.files.filter((f) => f.ownerId !== undefined && f.ownerId === state.subject)
}

/**
 * `visibleFiles` for a component. Compared row by row: the filter builds a new
 * array every time, and a bare selector returning one re-renders forever.
 */
export const useVisibleFiles = (): UploadFile[] => useUploadStore(useShallow(visibleFiles))

// Another tab signed in as someone else, or signed out. Applied as the event
// arrives, before this tab can send anything more.
if (typeof window !== 'undefined') {
  watchSubject((next) => applySubject(next))
}

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
            f.status === 'interrupted' && f.ownerTab === inherited && !f.queuedResume &&
            f.ownerId !== undefined && f.ownerId === s.subject
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
  /**
   * An empty queue, no runs, no hold, a fresh part budget, and no progress
   * heard in the tab. Runs still in flight are forgotten, not stopped.
   */
  reset(): void {
    if (probeTimer !== null) clearTimeout(probeTimer)
    probeTimer = null
    queue = createUploadQueue()
    runners.clear()
    discarding.clear()
    resumeRequestedAt.clear()
    fileRefs.clear()
    startTargets.clear()
    for (const id of Object.keys(abortControllers)) delete abortControllers[id]
    partBudget = createPartBudget(UPLOAD_CONCURRENCY)
    wakeLockHolders = 0
    tabProgressAt = -Infinity
  },
  hasAbortController: (id: string): boolean => abortControllers[id] !== undefined,
  /** Rows whose run has begun and not yet ended. */
  runningIds: (): string[] => Array.from(runners.keys()),
  wakeLockHolders: (): number => wakeLockHolders,
}
