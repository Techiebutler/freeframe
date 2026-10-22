'use client'

import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useUploadStore, visibleFiles, type UploadFile } from '@/stores/upload-store'
import { useSSE } from '@/hooks/use-sse'

/**
 * Bridges SSE transcode events to the upload store.
 * Renders one SSE connection per project that has processing uploads.
 * Also polls every 5s as a fallback for missed SSE events (e.g. fast-processing files).
 */
/**
 * How often to fall back to polling, for rows the store can reconcile against
 * the server. 0 means not at all.
 *
 * The gate used to be the SSE list, which is `processing` only, so a panel whose
 * one stopped upload is `interrupted` was never polled -- and noticing that the
 * same upload was resumed in another tab is the reason interrupted rows are
 * reconciled in the first place. A row another tab is sending is polled for the
 * same reason: to notice when that tab stops.
 *
 * Those get a slower cadence than processing rows. A transcode can finish
 * between two SSE events, which is a five-second question; being resumed
 * elsewhere is not. And an interrupted row survives a reload by design, so a
 * stale one on the 5s timer would poll for as long as the tab stays open.
 *
 * The cadence is store-wide, so one processing row puts the others on 5s too.
 * That is bounded, since processing rows do not stay processing.
 */
export function pollIntervalFor(files: UploadFile[]): number {
  if (files.some((f) => f.status === 'processing' && f.assetId)) return 5000
  // A queued resume is left out: it asks the server itself at its turn. Rows
  // that have not started (`queued`, `starting`) have nothing to reconcile.
  if (files.some((f) => (f.status === 'interrupted' && f.assetId && !f.queuedResume) || f.status === 'elsewhere')) {
    return 30000
  }
  return 0
}

/** The projects with a row in `processing`, each once: one SSE connection apiece. */
export function processingProjectIdsOf(files: UploadFile[]): string[] {
  const ids = new Set<string>()
  for (const f of files) {
    if (f.status === 'processing' && f.projectId) {
      ids.add(f.projectId)
    }
  }
  return Array.from(ids)
}

export function UploadSSEBridge() {
  // The signed-in account's rows: another account's are neither listened for
  // nor polled. Only the project ids and the cadence are selected, so a progress
  // write, which changes neither, does not re-render the bridge (spec goal 14).
  const processingProjectIds = useUploadStore(useShallow((s) => processingProjectIdsOf(visibleFiles(s))))
  const pollInterval = useUploadStore((s) => pollIntervalFor(visibleFiles(s)))
  const refreshProcessingItems = useUploadStore((s) => s.refreshProcessingItems)

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
  const updateProcessingProgress = useUploadStore((s) => s.updateProcessingProgress)
  const markProcessingComplete = useUploadStore((s) => s.markProcessingComplete)
  const markProcessingFailed = useUploadStore((s) => s.markProcessingFailed)

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
