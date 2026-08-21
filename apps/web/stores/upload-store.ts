import { create, type StateCreator } from 'zustand'
import { persist } from 'zustand/middleware'
import { api } from '@/lib/api'
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
): Promise<string> {
  const start = (partNumber - 1) * CHUNK_SIZE
  const chunk = file.slice(start, Math.min(start + CHUNK_SIZE, file.size))

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
): Promise<string> {
  let lastError: unknown

  for (let attempt = 1; attempt <= PART_MAX_ATTEMPTS; attempt++) {
    try {
      return await uploadPartOnce(file, s3Key, uploadId, partNumber, controller)
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
 */
export async function uploadAllParts(
  file: File,
  s3Key: string,
  uploadId: string,
  controller: AbortController,
  onProgress: (percent: number) => void,
  concurrency: number = UPLOAD_CONCURRENCY,
): Promise<Array<{ PartNumber: number; ETag: string }>> {
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE)
  const parts: Array<{ PartNumber: number; ETag: string }> = new Array(totalChunks)

  // Workers run against their own signal, so a part failing for good can stop
  // its siblings without being mistaken for a user cancel: `controller` keeps
  // meaning "the user pressed Cancel", `pool` means "stop, for any reason".
  const pool = new AbortController()
  const stopPool = () => pool.abort()
  if (controller.signal.aborted) stopPool()
  else controller.signal.addEventListener('abort', stopPool, { once: true })

  let nextIndex = 0
  let completed = 0
  let firstError: unknown = null

  async function worker(): Promise<void> {
    while (true) {
      if (controller.signal.aborted) {
        throw new DOMException('Upload cancelled', 'AbortError')
      }
      if (firstError) return // another worker failed; stop taking new parts

      const index = nextIndex++
      if (index >= totalChunks) return

      const partNumber = index + 1
      try {
        const etag = await uploadPart(file, s3Key, uploadId, partNumber, pool)
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

    return parts
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

export type UploadStatus = 'pending' | 'uploading' | 'processing' | 'complete' | 'failed' | 'cancelled'

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

function mapProcessingStatus(status: string): UploadStatus {
  switch (status) {
    case 'uploading': return 'uploading'
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
      return {
        id: `history-${a.id}`,
        fileName: file?.original_filename ?? a.name,
        fileSize: file?.file_size_bytes ?? 0,
        fileType: file?.mime_type ?? mimeFromAssetType(a.asset_type),
        projectId: a.project_id,
        assetName: a.name,
        progress: 100,
        processingProgress: v.processing_status === 'ready' ? 100 : 0,
        status: mapProcessingStatus(v.processing_status),
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

        const cancelled = err instanceof DOMException && err.name === 'AbortError'
        if (cancelled) {
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
            return
          }
          const message = err instanceof Error ? err.message : 'Upload failed'
          updateFile(id, { status: 'failed', error: message })
        }
        // Notify backend so the version is marked failed (not stuck at uploading).
        // This ensures post-refresh history shows the item in "Failed", not "Active".
        if (upload_id && s3_key && version_id) {
          const aborting = api.post('/upload/abort', { s3_key, upload_id, version_id })
            .catch(() => {})
          // The abort can change the answer we just acted on. When the object was
          // assembled but the status write never landed, the version is still
          // `uploading` -- so the read above said "not landed" and we wrote Failed --
          // and the abort then finds the object, promotes the version to
          // `processing` and dispatches the transcode. Asking again afterwards is
          // what stops us reporting Failed for a file the server just resurrected.
          if (!cancelled && completionAttempted && asset_id && version_id) {
            await aborting
            const after = await completedVersionStatus(asset_id, version_id)
            if (after) applyLanded(after)
          }
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

        const cancelled = err instanceof DOMException && err.name === 'AbortError'
        if (cancelled) {
          updateFile(id, { status: 'cancelled', progress: 0 })
        } else {
          // See startUpload: a completion that threw may still have landed.
          const landed = completionAttempted && version_id
            ? await completedVersionStatus(assetId, version_id)
            : null
          if (landed) {
            applyLanded(landed)
            return
          }
          updateFile(id, { status: 'failed', error: err instanceof Error ? err.message : 'Upload failed' })
        }
        if (upload_id && s3_key && version_id) {
          const aborting = api.post('/upload/abort', { s3_key, upload_id, version_id })
            .catch(() => {})
          // See startUpload: the abort itself can promote the version and dispatch
          // the transcode, so the answer we acted on above may already be stale.
          if (!cancelled && completionAttempted) {
            await aborting
            const after = await completedVersionStatus(assetId, version_id)
            if (after) applyLanded(after)
          }
        }
      } finally {
        releaseWakeLock()
        delete abortControllers[id]
      }
    })()

    return id
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
    const processingFiles = get().files.filter((f) => f.status === 'processing' && f.assetId)
    if (!processingFiles.length) return
    try {
      const results = await Promise.all(
        processingFiles.map((f) =>
          api.get<AssetResponse>(`/assets/${f.assetId}`).catch(() => null),
        ),
      )
      set((s) => ({
        files: s.files.map((f) => {
          if (f.status !== 'processing' || !f.assetId) return f
          const idx = processingFiles.findIndex((pf) => pf.assetId === f.assetId)
          const asset = idx >= 0 ? results[idx] : null
          if (!asset?.latest_version) return f
          const status = mapProcessingStatus(asset.latest_version.processing_status)
          if (status === 'processing') return f
          return { ...f, status, processingProgress: status === 'complete' ? 100 : 0 }
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
    // Only persist failed/cancelled items — in-progress uploads can't be resumed
    // and successful ones are fetched from the API history on panel open.
    partialize: (state: UploadStore) => ({
      files: state.files.filter(
        (f: UploadFile) => f.status === 'failed' || f.status === 'cancelled',
      ),
    }),
  }),
)
