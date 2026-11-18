'use client'

import { useEffect, useReducer } from 'react'
import { frameInitial, frameReducer, getLastFrame, setLastFrame, snapshotFrame } from '@/lib/first-frame'

/**
 * Keeps a frame layer over the video until `sourceKey` has a decoded frame.
 * Returns whether the layer is covering, and the image for it: the item's own poster, else the last frame painted.
 */
export function useFirstFrame(videoRef: React.RefObject<HTMLVideoElement>, sourceKey: string | null, poster?: string | null) {
  const [state, dispatch] = useReducer(frameReducer, frameInitial)

  useEffect(() => {
    dispatch({ type: 'source', key: sourceKey })
    const v = videoRef.current
    if (!v || !sourceKey) return
    const ready = () => {
      dispatch({ type: 'frame', key: sourceKey })
      const s = snapshotFrame(v)
      if (s) setLastFrame(s)
    }
    // preload=metadata decodes no picture by itself: ask for the very first one.
    const nudge = () => { if (v.paused && v.currentTime < 0.01) { try { v.currentTime = 0.001 } catch { /* not seekable yet */ } } }
    const keep = () => { const s = snapshotFrame(v); if (s) setLastFrame(s) }
    v.addEventListener('loadeddata', ready)
    v.addEventListener('seeked', ready)
    v.addEventListener('playing', ready)
    v.addEventListener('loadedmetadata', nudge)
    v.addEventListener('pause', keep)
    if (v.readyState >= 2) ready()
    else if (v.readyState >= 1) nudge()
    return () => {
      keep() // the element may already be detached (remount on module switch): its frame can still be drawn
      v.removeEventListener('loadeddata', ready)
      v.removeEventListener('seeked', ready)
      v.removeEventListener('playing', ready)
      v.removeEventListener('loadedmetadata', nudge)
      v.removeEventListener('pause', keep)
    }
  }, [videoRef, sourceKey])

  return { covered: state.covered, image: poster || getLastFrame() }
}
