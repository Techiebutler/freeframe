'use client'

import * as React from 'react'
import { useUploadStore } from '@/stores/upload-store'

/**
 * Calls `refetch` when one of this project's uploads changes status while one of
 * them is complete, which is when the project's asset grid can be out of date.
 *
 * It subscribes to strings derived from the rows, not to the rows. Progress writes
 * (up to ~100 an upload, and every transcode progress event) leave both unchanged,
 * so they neither re-render the caller nor refetch. Watching `files` itself fired
 * the refetch on every one of those writes, two GETs each on the project page,
 * which was enough to reach the API's per-user GET limit while uploading.
 */
export function useRefetchOnUploadStatus(projectId: string, refetch: () => void): void {
  const statusKey = useUploadStore((s) =>
    s.files
      .filter((f) => f.projectId === projectId)
      .map((f) => `${f.id}:${f.status}`)
      .join('\n'),
  )
  const anyComplete = useUploadStore((s) =>
    s.files.some((f) => f.projectId === projectId && f.status === 'complete'),
  )

  React.useEffect(() => {
    if (anyComplete) refetch()
  }, [statusKey, anyComplete, refetch])
}
