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
 * The shortest time between two refetches of the grid, in ms.
 *
 * Every file passes through three states the grid can see, and each refetch is
 * two GETs on the project page, so refetching on every move costs six reads a
 * file. A drop of 300 small files finishes in under half a minute, which made
 * that over 2 000 reads and spent the API's per-account limit (600 reads a
 * minute) inside the drop: the grid's own reads, and every other read of the
 * account's, were then refused with 429 until the minute ran out (e2e Q2,
 * APP-BUG-3). At one refetch per gap the same drop reads about 30 times, and
 * the grid is never more than this far behind.
 */
export const GRID_REFETCH_GAP_MS = 2_000

/**
 * Calls `refetch` when one of this project's uploads changes what the asset
 * grid shows while one of them is complete, which is when the grid can be out
 * of date. A row leaving one of those states (a cancel, an interruption)
 * changes it too.
 *
 * At most once per `GRID_REFETCH_GAP_MS`: the first change after a quiet spell
 * refetches at once, and changes inside the gap are folded into one refetch at
 * its end, so the last change is always fetched.
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

  const refetchRef = React.useRef(refetch)
  React.useEffect(() => {
    refetchRef.current = refetch
  }, [refetch])
  const lastAt = React.useRef(Number.NEGATIVE_INFINITY)
  const due = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  React.useEffect(() => {
    if (!anyComplete) return
    // A refetch is already due at the end of the gap; it will read the state as it is then.
    if (due.current) return
    const fire = () => {
      due.current = null
      lastAt.current = Date.now()
      refetchRef.current()
    }
    const wait = lastAt.current + GRID_REFETCH_GAP_MS - Date.now()
    if (wait <= 0) fire()
    else due.current = setTimeout(fire, wait)
  }, [statusKey, anyComplete])

  React.useEffect(() => () => {
    if (due.current) clearTimeout(due.current)
    due.current = null
  }, [])
}
