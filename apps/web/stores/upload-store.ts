import { create, type StateCreator } from 'zustand'
import { persist } from 'zustand/middleware'
import { api, ApiError } from '@/lib/api'
import type { AssetResponse } from '@/types'

const CHUNK_SIZE = 10 * 1024 * 1024 // 10 MB
const HISTORY_PAGE_SIZE = 20
const PART_MAX_ATTEMPTS = 8 // per part, including the first try
const PART_RETRY_BASE_MS = 2000 // 2s, 4s, 8s … ≈254s of total tolerance per part

/**
 * Parts in flight per upload.
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

/** Uploads one part exactly once. Returns its ETag. */
async function uploadPartOnce(
  file: File,
  s3Key: string,
  uploadId: string,
  partNumber: number,
  controller: AbortController,
  chunkSize: number,
): Promise<string> {
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

  const putResponse = await fetch(presigned_url, {
    method: 'PUT',
    body: chunk,
    signal: controller.signal,
  })

  if (!putResponse.ok) {
    const error: PartUploadError = new Error(`Part ${partNumber} failed: ${putResponse.statusText}`)
    error.permanent = isPermanentStatus(putResponse.status)
    throw error
  }

  return putResponse.headers.get('ETag') ?? ''
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
 */
async function uploadPart(
  file: File,
  s3Key: string,
  uploadId: string,
  partNumber: number,
  controller: AbortController,
  chunkSize: number,
): Promise<string> {
  let lastError: unknown

  for (let attempt = 1; attempt <= PART_MAX_ATTEMPTS; attempt++) {
    try {
      return await uploadPartOnce(file, s3Key, uploadId, partNumber, controller, chunkSize)
    } catch (err) {
      if (controller.signal.aborted) throw err
      if (err instanceof DOMException && err.name === 'AbortError') throw err
      if ((err as PartUploadError)?.permanent) throw err

      lastError = err
      if (attempt === PART_MAX_ATTEMPTS) break

      const delay = PART_RETRY_BASE_MS * 2 ** (attempt - 1) + Math.random() * 250
      await delayUnlessAborted(delay, controller.signal)
      // Waking early means the upload is over — the user cancelled, or a sibling
      // part failed for good. Another attempt would spend a presign round-trip
      // and 10 MB of uplink on a part nothing will ever complete.
      if (controller.signal.aborted) break
    }
  }

  throw lastError
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
 * Parts are sent by a small pool of workers rather than strictly one after the
 * other. A single PUT does not saturate a connection — most of a sequential
 * upload is spent waiting on round-trips — so a handful in flight multiplies
 * throughput on exactly the long-haul links where large uploads hurt most.
 *
 * Ordering is preserved by writing each result to its own index: parts finish
 * out of order, but `parts` is indexed by part number, and progress counts
 * completions rather than the highest number seen.
 *
 * When a part finally fails the whole upload is lost, so the other workers are
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
 */
export async function uploadAllParts(
  file: File,
  s3Key: string,
  uploadId: string,
  controller: AbortController,
  onProgress: (percent: number) => void,
  concurrency: number = UPLOAD_CONCURRENCY,
  opts?: { chunkSize?: number; alreadyHeld?: readonly number[] },
): Promise<Array<{ PartNumber: number; ETag: string }>> {
  const chunkSize = opts?.chunkSize ?? CHUNK_SIZE
  const held = new Set(opts?.alreadyHeld ?? [])
  const totalChunks = Math.ceil(file.size / chunkSize)
  const parts: Array<{ PartNumber: number; ETag: string }> = new Array(totalChunks)

  // Workers run against their own signal, so a part failing for good can stop
  // its siblings without being mistaken for a user cancel: `controller` keeps
  // meaning "the user pressed Cancel", `pool` means "stop, for any reason".
  const pool = new AbortController()
  const stopPool = () => pool.abort()
  if (controller.signal.aborted) stopPool()
  else controller.signal.addEventListener('abort', stopPool, { once: true })

  let nextIndex = 0
  // Parts the backend already holds are done before this starts, and progress
  // has to say so: a resume that reports 0% and then jumps is indistinguishable
  // from one that is re-sending everything.
  let completed = held.size
  let firstError: unknown = null
  if (completed > 0) onProgress(Math.round((completed / totalChunks) * 95))

  async function worker(): Promise<void> {
    while (true) {
      if (controller.signal.aborted) {
        throw new DOMException('Upload cancelled', 'AbortError')
      }
      if (firstError) return // another worker failed; stop taking new parts

      const index = nextIndex++
      if (index >= totalChunks) return

      const partNumber = index + 1
      if (held.has(partNumber)) continue
      try {
        const etag = await uploadPart(file, s3Key, uploadId, partNumber, pool, chunkSize)
        parts[index] = { PartNumber: partNumber, ETag: etag }
        completed += 1
        onProgress(Math.round((completed / totalChunks) * 95))
      } catch (err) {
        // Not `??=`: an error is only ever recorded once, since every worker
        // returns immediately after, and assigning plainly means a falsy
        // rejection can never leave `firstError` unset while a part is missing.
        if (firstError === null) firstError = err
        stopPool()
        return
      }
    }
  }

  try {
    const workerCount = Math.max(1, Math.min(concurrency, totalChunks))
    const results = await Promise.allSettled(Array.from({ length: workerCount }, () => worker()))

    // A user cancel outranks whatever errors it caused in the parts it
    // interrupted, so it is resolved before `firstError` rather than after —
    // otherwise cancelling shows the row flipping from Cancelled back to Failed.
    // The abort error a part actually raised is preferred over a synthesized
    // one, so its reason survives; the fallback covers a cancel that landed
    // between parts, where no request was in flight to reject.
    if (controller.signal.aborted) {
      const raised = [firstError, ...results.map((r) => (r.status === 'rejected' ? r.reason : null))]
      throw raised.find(isAbortError) ?? new DOMException('Upload cancelled', 'AbortError')
    }
    if (firstError !== null) throw firstError

    const rejected = results.find((r) => r.status === 'rejected')
    if (rejected && rejected.status === 'rejected') throw rejected.reason

    // Dense, because a skipped part leaves its slot empty and a sparse array
    // serialises as nulls. On a resume this is therefore what was sent now, not
    // what the upload consists of -- the caller has to know the difference, and
    // the one that does sends no list at all.
    return parts.filter(Boolean)
  } finally {
    controller.signal.removeEventListener('abort', stopPool)
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
  | 'pending' | 'uploading' | 'processing' | 'complete' | 'failed' | 'cancelled' | 'interrupted'

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
  createdAt: number // timestamp for grouping
}

interface InitiateResponse {
  upload_id: string
  s3_key: string
  asset_id: string
  version_id: string
}

interface VersionInitiateResponse {
  upload_id: string
  s3_key: string
  asset_id: string
  version_id: string
}

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

// AbortControllers for cancellation
const abortControllers: Record<string, AbortController> = {}

interface UploadStore {
  files: UploadFile[]
  panelOpen: boolean
  historyLoaded: boolean
  historyHasMore: boolean
  historyLoading: boolean
  historySkip: number
  setPanelOpen: (open: boolean) => void
  togglePanel: () => void
  startUpload: (file: File, projectId: string, assetName: string, projectName?: string, folderId?: string | null) => string
  startVersionUpload: (file: File, assetId: string, assetName: string, projectId: string) => string
  resumeUpload: (fileId: string, file: File) => void
  discardUpload: (fileId: string) => Promise<void>
  cancelUpload: (fileId: string) => void
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
      const status = mapProcessingStatus(v.processing_status)
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
        progress: status === 'interrupted' ? 0 : 100,
        processingProgress: v.processing_status === 'ready' ? 100 : 0,
        status,
        assetId: a.id,
        versionId: v.id,
        createdAt: new Date(v.created_at).getTime(),
      }
    })
  return [...existing, ...newFiles]
}

const storeCreator: StateCreator<UploadStore, [['zustand/persist', unknown]]> = (set, get) => ({
  files: [],
  panelOpen: false,
  historyLoaded: false,
  historyHasMore: true,
  historyLoading: false,
  historySkip: 0,

  setPanelOpen: (open) => set({ panelOpen: open }),
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),

  startUpload: (file, projectId, assetName, projectName, folderId) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`

    const entry: UploadFile = {
      id,
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type,
      projectId,
      projectName,
      assetName,
      progress: 0,
      processingProgress: 0,
      status: 'pending',
      createdAt: Date.now(),
    }

    set((s) => ({ files: [entry, ...s.files], panelOpen: true }))

    const updateFile = (fileId: string, patch: Partial<UploadFile>) => {
      set((s) => ({
        files: s.files.map((f) => (f.id === fileId ? { ...f, ...patch } : f)),
      }))
    }

    // Start async upload
    ;(async () => {
      const controller = new AbortController()
      abortControllers[id] = controller

      // Track initiate response fields so catch block can call /upload/abort,
      // and ask the server what became of the version before it does.
      let upload_id: string | undefined
      let s3_key: string | undefined
      let version_id: string | undefined
      let asset_id: string | undefined
      let completionAttempted = false

      retainWakeLock()
      try {
        updateFile(id, { status: 'uploading' })

        const initRes = await api.post<InitiateResponse>(
          '/upload/initiate',
          {
            project_id: projectId,
            asset_name: assetName,
            original_filename: file.name,
            file_size_bytes: file.size,
            mime_type: file.type,
            folder_id: folderId ?? null,
          },
        )
        upload_id = initRes.upload_id
        s3_key = initRes.s3_key
        version_id = initRes.version_id
        asset_id = initRes.asset_id

        updateFile(id, { uploadId: upload_id, assetId: asset_id, versionId: version_id })

        const parts = await uploadAllParts(file, s3_key, upload_id, controller, (percent) =>
          updateFile(id, { progress: percent }),
        )

        completionAttempted = true
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
        if (isMedia) {
          updateFile(id, { progress: 100, status: 'processing', processingProgress: 0 })
        } else {
          updateFile(id, { progress: 100, status: 'complete' })
        }
      } catch (err) {
        // Asking the server what happened takes a round-trip, and the row stays
        // interactive for its duration -- the panel still offers Cancel on an
        // `uploading` row. A cancel landing in that window is the user's decision
        // and outranks whatever we were about to write.
        const applyLanded = (landed: 'processing' | 'complete') => {
          if (get().files.find((f) => f.id === id)?.status === 'cancelled') return
          updateFile(id, {
            progress: 100,
            status: landed,
            processingProgress: landed === 'complete' ? 100 : 0,
          })
        }

        // Asked again after the round-trip below, not captured once: the user can
        // cancel while it is in flight, and that decision has to reach the abort.
        const userCancelled = () => get().files.find((f) => f.id === id)?.status === 'cancelled'

        if (isAbortError(err)) {
          updateFile(id, { status: 'cancelled', progress: 0 })
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
            updateFile(id, {
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
          await api.post('/upload/abort', { s3_key, upload_id, version_id }).catch(() => {})
        }
      } finally {
        releaseWakeLock()
        delete abortControllers[id]
      }
    })()

    return id
  },

  startVersionUpload: (file, assetId, assetName, projectId) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const entry: UploadFile = {
      id,
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type,
      projectId,
      assetName,
      progress: 0,
      processingProgress: 0,
      status: 'pending',
      assetId,
      createdAt: Date.now(),
    }
    set((s) => ({ files: [entry, ...s.files], panelOpen: true }))

    const updateFile = (fileId: string, patch: Partial<UploadFile>) => {
      set((s) => ({ files: s.files.map((f) => (f.id === fileId ? { ...f, ...patch } : f)) }))
    }

    ;(async () => {
      const controller = new AbortController()
      abortControllers[id] = controller
      let upload_id: string | undefined
      let s3_key: string | undefined
      let version_id: string | undefined
      let completionAttempted = false
      retainWakeLock()
      try {
        updateFile(id, { status: 'uploading' })
        const initRes = await api.post<VersionInitiateResponse>(
          `/assets/${assetId}/versions`,
          {
            project_id: projectId,
            asset_name: assetName,
            original_filename: file.name,
            file_size_bytes: file.size,
            mime_type: file.type,
          },
        )
        upload_id = initRes.upload_id
        s3_key = initRes.s3_key
        version_id = initRes.version_id
        updateFile(id, { uploadId: upload_id, versionId: version_id })

        const parts = await uploadAllParts(file, s3_key, upload_id, controller, (percent) =>
          updateFile(id, { progress: percent }),
        )

        completionAttempted = true
        await api.post('/upload/complete', { s3_key, upload_id, asset_id: assetId, version_id, parts })
        const isMedia = file.type.startsWith('video/') || file.type.startsWith('audio/') || file.type.startsWith('image/')
        updateFile(id, { progress: 100, status: isMedia ? 'processing' : 'complete', processingProgress: 0 })
      } catch (err) {
        // See startUpload for why both of these exist.
        const applyLanded = (landed: 'processing' | 'complete') => {
          if (get().files.find((f) => f.id === id)?.status === 'cancelled') return
          updateFile(id, {
            progress: 100,
            status: landed,
            processingProgress: landed === 'complete' ? 100 : 0,
          })
        }

        // See startUpload for why all three of these are shaped this way.
        const userCancelled = () => get().files.find((f) => f.id === id)?.status === 'cancelled'

        if (isAbortError(err)) {
          updateFile(id, { status: 'cancelled', progress: 0 })
        } else {
          const landed = completionAttempted && version_id
            ? await completedVersionStatus(assetId, version_id)
            : null
          if (landed) {
            applyLanded(landed)
          } else if (!userCancelled()) {
            updateFile(id, {
              status: upload_id && version_id ? 'interrupted' : 'failed',
              error: err instanceof Error ? err.message : 'Upload failed',
            })
            if (completionAttempted && version_id && await finishAssembledUpload(version_id)) {
              applyLanded('processing')
            }
          }
        }

        if (userCancelled() && upload_id && s3_key && version_id) {
          await api.post('/upload/abort', { s3_key, upload_id, version_id }).catch(() => {})
        }
      } finally {
        releaseWakeLock()
        delete abortControllers[id]
      }
    })()

    return id
  },

  resumeUpload: (fileId, file) => {
    const row = get().files.find((f) => f.id === fileId)
    if (!row || row.status !== 'interrupted' || !row.versionId) return
    const versionId = row.versionId

    const updateFile = (patch: Partial<UploadFile>) => {
      set((s) => ({ files: s.files.map((f) => (f.id === fileId ? { ...f, ...patch } : f)) }))
    }

    ;(async () => {
      const controller = new AbortController()
      abortControllers[fileId] = controller
      let info: ResumeInfo | undefined
      let completionAttempted = false
      retainWakeLock()
      try {
        updateFile({ status: 'uploading', progress: 0, error: undefined })

        // Everything needed to carry on comes from the server, including the key
        // and the upload id: this row may have been rehydrated from history in a
        // browser that never saw them.
        info = await api.get<ResumeInfo>(`/upload/${versionId}/parts`)

        // `assembled` means the object is whole and only the completion is
        // outstanding, so the file is not needed and is not checked -- refusing
        // it over a rename would strand an upload that has nothing left to send.
        const held = info.state === 'resumable' ? info.held_part_numbers : []
        let parts: Array<{ PartNumber: number; ETag: string }> = []
        if (info.state === 'resumable') {
          // A browser cannot reopen a local file on its own, so the user picks it
          // again -- and nothing makes them pick the same one. Name and size are
          // what can be checked without reading the file; they guard against an
          // accident rather than prove anything, and a mismatch here is what
          // would silently corrupt the parts already in the bucket.
          if (file.size !== info.file_size_bytes || file.name !== info.original_filename) {
            throw new Error(`Pick the same file again: ${info.original_filename}`)
          }
          parts = await uploadAllParts(
            file, info.s3_key, info.upload_id, controller,
            (percent) => updateFile({ progress: percent }),
            UPLOAD_CONCURRENCY,
            { chunkSize: info.chunk_size_bytes, alreadyHeld: held },
          )
        }

        completionAttempted = true
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
        const userCancelled = () => get().files.find((f) => f.id === fileId)?.status === 'cancelled'

        if (isAbortError(err)) {
          updateFile({ status: 'cancelled', progress: 0 })
        } else {
          // See startUpload: the completion may have landed with only its
          // response lost, and this is the second time round for this version.
          const landed = completionAttempted && info
            ? await completedVersionStatus(info.asset_id, info.version_id)
            : null
          if (landed) {
            if (!userCancelled()) {
              updateFile({
                progress: 100,
                status: landed,
                processingProgress: landed === 'complete' ? 100 : 0,
              })
            }
          } else if (!userCancelled()) {
            updateFile({
              // Back to resumable unless the server said this upload is over.
              // Nothing was aborted here either, so the parts sent this time are
              // held too and the next attempt starts from further along.
              status: isFinalRefusal(err) ? 'failed' : 'interrupted',
              progress: 0,
              error: err instanceof Error ? err.message : 'Upload failed',
            })
          }
        }

        if (userCancelled() && info) {
          await api.post('/upload/abort', {
            s3_key: info.s3_key,
            upload_id: info.upload_id,
            version_id: info.version_id,
          }).catch(() => {})
        }
      } finally {
        releaseWakeLock()
        delete abortControllers[fileId]
      }
    })()
  },

  discardUpload: async (fileId) => {
    // The counterpart to no longer aborting on failure. Without it the only way
    // to be rid of an upload the user does not want back is to wait for the
    // reaper, and the row would keep offering a resume in the meantime.
    const row = get().files.find((f) => f.id === fileId)
    if (!row) return
    set((s) => ({ files: s.files.filter((f) => f.id !== fileId) }))
    if (!row.versionId) return
    try {
      const info = await api.get<ResumeInfo>(`/upload/${row.versionId}/parts`)
      await api.post('/upload/abort', {
        s3_key: info.s3_key,
        upload_id: info.upload_id,
        version_id: info.version_id,
      })
    } catch {
      // The row is gone from the panel either way. What is left in the bucket is
      // the reaper's job, and it has the activity timestamp it needs to do it.
    }
  },

  cancelUpload: (fileId) => {
    abortControllers[fileId]?.abort()
    set((s) => ({
      files: s.files.map((f) =>
        f.id === fileId ? { ...f, status: 'cancelled' as const, progress: 0 } : f,
      ),
    }))
  },

  removeFile: (fileId) => {
    set((s) => ({ files: s.files.filter((f) => f.id !== fileId) }))
  },

  clearCompleted: () => {
    set((s) => ({ files: s.files.filter((f) => f.status !== 'complete') }))
  },

  fetchHistory: async () => {
    if (get().historyLoaded) return
    set({ historyLoading: true })
    try {
      const assets = await api.get<AssetResponse[]>(`/me/assets?skip=0&limit=${HISTORY_PAGE_SIZE}`)
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
      const assets = await api.get<AssetResponse[]>(`/me/assets?skip=${historySkip}&limit=${HISTORY_PAGE_SIZE}`)
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
    // Interrupted rows are polled alongside processing ones. The same upload can
    // be resumed from another tab or another machine, and without this the row
    // here keeps offering a resume for a version that is already transcoding.
    const watched = get().files.filter(
      (f) => (f.status === 'processing' || f.status === 'interrupted') && f.assetId,
    )
    if (!watched.length) return
    try {
      const results = await Promise.all(
        watched.map((f) =>
          api.get<AssetResponse>(`/assets/${f.assetId}`).catch(() => null),
        ),
      )
      set((s) => ({
        files: s.files.map((f) => {
          if ((f.status !== 'processing' && f.status !== 'interrupted') || !f.assetId) return f
          const idx = watched.findIndex((pf) => pf.assetId === f.assetId)
          const asset = idx >= 0 ? results[idx] : null
          if (!asset?.latest_version) return f
          const status = mapProcessingStatus(asset.latest_version.processing_status)
          if (status === f.status) return f
          return {
            ...f,
            status,
            progress: status === 'interrupted' ? f.progress : 100,
            processingProgress: status === 'complete' ? 100 : 0,
          }
        }),
      }))
    } catch {
      // SSE is the primary mechanism; ignore poll errors
    }
  },
})

export const useUploadStore = create<UploadStore>()(
  persist(storeCreator, {
    name: 'ff-uploads',
    // Terminal rows plus the resumable ones. Successful uploads are fetched from
    // the API history on panel open, so they are not kept here; an `interrupted`
    // row is, because it is an offer to carry on and the user is likely to
    // reload before taking it up. Rows still in flight are still excluded: a
    // reload kills the transfer, and the version comes back from history as
    // `interrupted` on its own.
    partialize: (state: UploadStore) => ({
      files: state.files.filter(
        (f: UploadFile) =>
          f.status === 'failed' || f.status === 'cancelled' || f.status === 'interrupted',
      ),
    }),
  }),
)
