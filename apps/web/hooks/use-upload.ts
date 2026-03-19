'use client'

import * as React from 'react'
import { api } from '@/lib/api'

const CHUNK_SIZE = 10 * 1024 * 1024 // 10 MB

export type UploadStatus = 'pending' | 'uploading' | 'complete' | 'failed' | 'cancelled'

export interface UploadFile {
  id: string
  file: File
  projectId: string
  assetName: string
  progress: number // 0–100
  status: UploadStatus
  error?: string
  assetId?: string
  uploadId?: string
}

interface InitiateResponse {
  upload_id: string
  s3_key: string
  asset_id: string
  version_id: string
}

interface PresignPartResponse {
  url: string
}

interface UploadState {
  files: UploadFile[]
  startUpload: (file: File, projectId: string, assetName: string) => string
  cancelUpload: (fileId: string) => Promise<void>
  removeFile: (fileId: string) => void
  clearCompleted: () => void
}

// Map of fileId → AbortController so we can cancel in-flight requests
const abortControllers: Record<string, AbortController> = {}

export function useUpload(): UploadState {
  const [files, setFiles] = React.useState<UploadFile[]>([])

  const updateFile = React.useCallback(
    (id: string, patch: Partial<UploadFile>) => {
      setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)))
    },
    [],
  )

  const startUpload = React.useCallback(
    (file: File, projectId: string, assetName: string): string => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`

      const entry: UploadFile = {
        id,
        file,
        projectId,
        assetName,
        progress: 0,
        status: 'pending',
      }

      setFiles((prev) => [...prev, entry])

      // Start the actual upload asynchronously
      ;(async () => {
        const controller = new AbortController()
        abortControllers[id] = controller

        try {
          updateFile(id, { status: 'uploading' })

          // 1. Initiate multipart upload
          const { upload_id, s3_key, asset_id, version_id } = await api.post<InitiateResponse>(
            '/upload/initiate',
            {
              project_id: projectId,
              asset_name: assetName,
              original_filename: file.name,
              file_size_bytes: file.size,
              mime_type: file.type,
            },
          )

          updateFile(id, { uploadId: upload_id, assetId: asset_id })

          // 2. Upload chunks
          const totalChunks = Math.ceil(file.size / CHUNK_SIZE)
          const parts: Array<{ PartNumber: number; ETag: string }> = []

          for (let partNumber = 1; partNumber <= totalChunks; partNumber++) {
            if (controller.signal.aborted) {
              throw new DOMException('Upload cancelled', 'AbortError')
            }

            const start = (partNumber - 1) * CHUNK_SIZE
            const end = Math.min(start + CHUNK_SIZE, file.size)
            const chunk = file.slice(start, end)

            // Get presigned URL for this part
            const { presigned_url } = await api.post<{ presigned_url: string }>('/upload/presign-part', {
              s3_key,
              upload_id,
              part_number: partNumber,
            })

            // PUT chunk to S3
            const putResponse = await fetch(presigned_url, {
              method: 'PUT',
              body: chunk,
              signal: controller.signal,
            })

            if (!putResponse.ok) {
              throw new Error(`Part ${partNumber} upload failed: ${putResponse.statusText}`)
            }

            const etag = putResponse.headers.get('ETag') ?? ''
            parts.push({ PartNumber: partNumber, ETag: etag })

            const progress = Math.round((partNumber / totalChunks) * 95)
            updateFile(id, { progress })
          }

          // 3. Complete upload
          await api.post('/upload/complete', {
            s3_key,
            upload_id,
            asset_id,
            version_id,
            parts,
          })

          updateFile(id, { progress: 100, status: 'complete' })
        } catch (err) {
          if (
            err instanceof DOMException && err.name === 'AbortError'
          ) {
            updateFile(id, { status: 'cancelled', progress: 0 })
          } else {
            const message = err instanceof Error ? err.message : 'Upload failed'
            updateFile(id, { status: 'failed', error: message })
          }
        } finally {
          delete abortControllers[id]
        }
      })()

      return id
    },
    [updateFile],
  )

  const cancelUpload = React.useCallback(
    async (fileId: string) => {
      const controller = abortControllers[fileId]
      if (controller) {
        controller.abort()
      }

      updateFile(fileId, { status: 'cancelled', progress: 0 })
    },
    [updateFile],
  )

  const removeFile = React.useCallback((fileId: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== fileId))
  }, [])

  const clearCompleted = React.useCallback(() => {
    setFiles((prev) => prev.filter((f) => f.status !== 'complete'))
  }, [])

  return { files, startUpload, cancelUpload, removeFile, clearCompleted }
}
