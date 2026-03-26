import { create, type StateCreator } from 'zustand'
import { persist } from 'zustand/middleware'
import { api } from '@/lib/api'
import type { AssetResponse } from '@/types'

const CHUNK_SIZE = 10 * 1024 * 1024 // 10 MB
const HISTORY_PAGE_SIZE = 20

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

      // Track initiate response fields so catch block can call /upload/abort
      let upload_id: string | undefined
      let s3_key: string | undefined
      let version_id: string | undefined

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
        const asset_id = initRes.asset_id

        updateFile(id, { uploadId: upload_id, assetId: asset_id, versionId: version_id })

        const totalChunks = Math.ceil(file.size / CHUNK_SIZE)
        const parts: Array<{ PartNumber: number; ETag: string }> = []

        for (let partNumber = 1; partNumber <= totalChunks; partNumber++) {
          if (controller.signal.aborted) {
            throw new DOMException('Upload cancelled', 'AbortError')
          }

          const start = (partNumber - 1) * CHUNK_SIZE
          const end = Math.min(start + CHUNK_SIZE, file.size)
          const chunk = file.slice(start, end)

          const { presigned_url } = await api.post<{ presigned_url: string }>('/upload/presign-part', {
            s3_key,
            upload_id,
            part_number: partNumber,
          })

          const putResponse = await fetch(presigned_url, {
            method: 'PUT',
            body: chunk,
            signal: controller.signal,
          })

          if (!putResponse.ok) {
            throw new Error(`Part ${partNumber} failed: ${putResponse.statusText}`)
          }

          const etag = putResponse.headers.get('ETag') ?? ''
          parts.push({ PartNumber: partNumber, ETag: etag })

          updateFile(id, { progress: Math.round((partNumber / totalChunks) * 95) })
        }

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
        if (err instanceof DOMException && err.name === 'AbortError') {
          updateFile(id, { status: 'cancelled', progress: 0 })
        } else {
          const message = err instanceof Error ? err.message : 'Upload failed'
          updateFile(id, { status: 'failed', error: message })
        }
        // Notify backend so the version is marked failed (not stuck at uploading).
        // This ensures post-refresh history shows the item in "Failed", not "Active".
        if (upload_id && s3_key && version_id) {
          api.post('/upload/abort', { s3_key, upload_id, version_id }).catch(() => {})
        }
      } finally {
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

        const totalChunks = Math.ceil(file.size / CHUNK_SIZE)
        const parts: Array<{ PartNumber: number; ETag: string }> = []
        for (let partNumber = 1; partNumber <= totalChunks; partNumber++) {
          if (controller.signal.aborted) throw new DOMException('Upload cancelled', 'AbortError')
          const start = (partNumber - 1) * CHUNK_SIZE
          const chunk = file.slice(start, Math.min(start + CHUNK_SIZE, file.size))
          const { presigned_url } = await api.post<{ presigned_url: string }>('/upload/presign-part', {
            s3_key, upload_id, part_number: partNumber,
          })
          const putResponse = await fetch(presigned_url, { method: 'PUT', body: chunk, signal: controller.signal })
          if (!putResponse.ok) throw new Error(`Part ${partNumber} failed: ${putResponse.statusText}`)
          parts.push({ PartNumber: partNumber, ETag: putResponse.headers.get('ETag') ?? '' })
          updateFile(id, { progress: Math.round((partNumber / totalChunks) * 95) })
        }

        await api.post('/upload/complete', { s3_key, upload_id, asset_id: assetId, version_id, parts })
        const isMedia = file.type.startsWith('video/') || file.type.startsWith('audio/') || file.type.startsWith('image/')
        updateFile(id, { progress: 100, status: isMedia ? 'processing' : 'complete', processingProgress: 0 })
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          updateFile(id, { status: 'cancelled', progress: 0 })
        } else {
          updateFile(id, { status: 'failed', error: err instanceof Error ? err.message : 'Upload failed' })
        }
        if (upload_id && s3_key && version_id) {
          api.post('/upload/abort', { s3_key, upload_id, version_id }).catch(() => {})
        }
      } finally {
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
