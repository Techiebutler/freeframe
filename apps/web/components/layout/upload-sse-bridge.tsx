'use client'

import { useEffect, useMemo } from 'react'
import { useUploadStore } from '@/stores/upload-store'
import { useSSE } from '@/hooks/use-sse'

/**
 * Bridges SSE transcode events to the upload store.
 * Renders one SSE connection per project that has processing uploads.
 * Also polls every 5s as a fallback for missed SSE events (e.g. fast-processing files).
 */
export function UploadSSEBridge() {
  const files = useUploadStore((s) => s.files)
  const refreshProcessingItems = useUploadStore((s) => s.refreshProcessingItems)

  const processingProjectIds = useMemo(() => {
    const ids = new Set<string>()
    for (const f of files) {
      if (f.status === 'processing' && f.projectId) {
        ids.add(f.projectId)
      }
    }
    return Array.from(ids)
  }, [files])

  // Fallback poll, for rows the store can reconcile against the server.
  //
  // The gate used to be the SSE list above, which is `processing` only, so a
  // panel whose one stopped upload is `interrupted` was never polled at all --
  // and noticing that the same upload was resumed in another tab is the reason
  // interrupted rows are reconciled in the first place.
  //
  // They get a slower cadence than processing rows. A transcode can finish
  // between two SSE events, which is a five-second question; being resumed
  // elsewhere is not. And an interrupted row survives a reload by design, so a
  // stale one on the 5s timer would poll for as long as the tab stays open.
  const pollInterval = useMemo(() => {
    if (files.some((f) => f.status === 'processing' && f.assetId)) return 5000
    if (files.some((f) => f.status === 'interrupted' && f.assetId)) return 30000
    return 0
  }, [files])

  useEffect(() => {
    if (!pollInterval) return
    const timer = setInterval(() => { refreshProcessingItems() }, pollInterval)
    return () => clearInterval(timer)
  }, [pollInterval, refreshProcessingItems])

  return (
    <>
      {processingProjectIds.map((pid) => (
        <SSEListener key={pid} projectId={pid} />
      ))}
    </>
  )
}

function SSEListener({ projectId }: { projectId: string }) {
  const { updateProcessingProgress, markProcessingComplete, markProcessingFailed } = useUploadStore()

  useSSE(projectId, {
    onTranscodeProgress: (data) => {
      updateProcessingProgress(data.asset_id, data.percent)
    },
    onTranscodeComplete: (data) => {
      markProcessingComplete(data.asset_id)
    },
    onTranscodeFailed: (data) => {
      markProcessingFailed(data.asset_id, data.error)
    },
  })

  return null
}
