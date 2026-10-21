'use client'

import * as React from 'react'
import { useUploadStore, type UploadFile } from '@/stores/upload-store'

/**
 * The part of a row's status the asset grid can see, or null for none.
 *
 * The grid shows assets, and an asset exists from the moment initiate answers:
 * a row that is `uploading` with an `assetId` has one, and `processing` and
 * `complete` change what the grid shows for it. Rows that are waiting or
 * starting have nothing on the server yet, so their moves -- every file of a
 * 500-file drop passes through both -- must not refetch the project.
 */
function gridState(f: UploadFile): string | null {
  if (f.status === 'uploading') return f.assetId ? 'uploading' : null
  if (f.status === 'processing' || f.status === 'complete') return f.status
  return null
}

/**
 * Calls `refetch` when one of this project's uploads changes what the asset
 * grid shows while one of them is complete, which is when the grid can be out
 * of date. A row leaving one of those states (a cancel, an interruption)
 * changes it too.
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
      .flatMap((f) => {
        const state = gridState(f)
        return state ? [`${f.id}:${state}`] : []
      })
      .join('\n'),
  )
  const anyComplete = useUploadStore((s) =>
    s.files.some((f) => f.projectId === projectId && f.status === 'complete'),
  )

  React.useEffect(() => {
    if (anyComplete) refetch()
  }, [statusKey, anyComplete, refetch])
}
