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
 * How soon after a refetch a change that leaves nothing on its way may refetch
 * again, in ms, without waiting out `GRID_REFETCH_GAP_MS`.
 */
export const GRID_SETTLE_GAP_MS = 500

/**
 * Whether the row is still on its way to the grid's final state: waiting,
 * starting, sending or transcoding, or a Resume waiting for its turn.
 */
function onItsWay(f: UploadFile): boolean {
  return (
    f.status === 'queued' || f.status === 'starting' || f.status === 'uploading' ||
    f.status === 'processing' || (f.status === 'interrupted' && f.queuedResume === true)
  )
}

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
 * The gap is for bursts. A change that leaves none of the project's uploads on
 * its way (`onItsWay`) is the end of one, or a single upload's last move, and
 * refetches at once if the last refetch was at least `GRID_SETTLE_GAP_MS` ago:
 * a single small image that goes Ready 700 ms after its first refetch was
 * otherwise shown Ready 2 s after it, later than before the gap existed. A
 * refetch already due still runs at the end of the gap. A drop's files stay on
 * their way until its last one finishes, so this adds one refetch to a drop.
 *
 * It watches the store from outside React and never re-renders its caller. The
 * caller is the project page, so a re-render of it is a re-render of the whole
 * asset grid; with selectors here, every status move of every upload did that,
 * and a 300-file drop kept the main thread busy for most of the run (e2e Q2,
 * APP-BUG-4). The grid re-renders when its refetched data changes, at most once
 * a gap.
 *
 * It compares strings derived from the rows, not the rows. Progress writes (up
 * to ~100 an upload, and every transcode progress event) leave them unchanged,
 * so they do not refetch. Watching `files` itself fired the refetch on every one
 * of those writes, two GETs each on the project page, which was enough to reach
 * the API's per-user GET limit while uploading.
 */
export function useRefetchOnUploadStatus(projectId: string, refetch: () => void): void {
  const refetchRef = React.useRef(refetch)
  React.useEffect(() => {
    refetchRef.current = refetch
  }, [refetch])

  React.useEffect(() => {
    let lastAt = Number.NEGATIVE_INFINITY
    let due: ReturnType<typeof setTimeout> | null = null
    let seenFiles: UploadFile[] | null = null
    let seenKey: string | null = null

    const refetchNow = () => {
      lastAt = Date.now()
      refetchRef.current()
    }
    const fire = () => {
      due = null
      refetchNow()
    }
    const look = (files: UploadFile[]) => {
      if (files === seenFiles) return
      seenFiles = files
      let anyComplete = false
      let anyOnItsWay = false
      const parts: string[] = []
      for (const f of files) {
        if (f.projectId !== projectId) continue
        if (f.status === 'complete') anyComplete = true
        if (onItsWay(f)) anyOnItsWay = true
        const state = gridState(f)
        if (state) parts.push(`${f.id}:${state}`)
      }
      const key = `${anyComplete}\n${parts.join('\n')}`
      if (key === seenKey) return
      seenKey = key
      if (!anyComplete) return
      // Settled: nothing is left to fold in, so the grid need not wait for the gap.
      if (!anyOnItsWay && Date.now() - lastAt >= GRID_SETTLE_GAP_MS) {
        refetchNow()
        return
      }
      // A refetch is already due at the end of the gap; it will read the state as it is then.
      if (due) return
      const wait = lastAt + GRID_REFETCH_GAP_MS - Date.now()
      if (wait <= 0) fire()
      else due = setTimeout(fire, wait)
    }

    look(useUploadStore.getState().files)
    const unsubscribe = useUploadStore.subscribe((state) => look(state.files))
    return () => {
      unsubscribe()
      if (due) clearTimeout(due)
    }
  }, [projectId])
}
