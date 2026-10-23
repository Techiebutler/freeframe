'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Finds the media element inside `root`.
 *
 * `<video>` is in the light DOM. AudioPlayer's element is not: WaveSurfer 7
 * creates it with `document.createElement('audio')`
 * (node_modules/wavesurfer.js/dist/player.js:45) and its renderer appends it
 * into an OPEN shadow root (renderer.js:151 `attachShadow({ mode: 'open' })`,
 * renderer.js:56-58), so it exists but a light-DOM query cannot see it.
 * `mode: 'open'` is what makes the second pass legal.
 */
function findMediaElement(root: HTMLElement): HTMLMediaElement | null {
  const direct = root.querySelector('video, audio')
  if (direct) return direct as HTMLMediaElement

  const hosts = root.querySelectorAll<HTMLElement>('*')
  for (let i = 0; i < hosts.length; i++) {
    const found = hosts[i].shadowRoot?.querySelector('audio')
    if (found) return found as HTMLMediaElement
  }
  return null
}

export interface MediaTransport {
  isPlaying: boolean
  togglePlay: () => void
  /**
   * Attach to the element containing the player — the media column.
   *
   * A CALLBACK ref, not a RefObject, and that is the whole point. Both review
   * wrappers early-return a loading spinner before the media column exists
   * (`if (isLoading || !asset)`), and ReviewProvider starts with
   * `isLoading = true`. An effect keyed on a RefObject therefore runs exactly
   * once, during the loader commit, sees `.current === null`, and never runs
   * again — leaving the sheet's play/pause button permanently dead on every
   * real load. A callback ref is driven by the DOM node arriving instead, so
   * it fires precisely when the column mounts, however late that is.
   */
  mediaRootRef: (node: HTMLElement | null) => void
}

export interface MediaTransportOptions {
  /**
   * The video player's own toggle (ReviewProvider's `togglePlayback`). A
   * `<video>` goes through it rather than the element, because the player is
   * where the iOS first-tap retry lives (#404): a play() rejected with nothing
   * buffered is retried on `canplay`, and a pause disarms that retry and ends
   * the intent to play. Driven directly, the first tap did nothing on iOS, and
   * a pause while the player's own play() was pending let its retry resume the
   * video anyway.
   */
  toggleVideo?: () => void
}

/**
 * Playback state for a surface that does not own the player — the mobile
 * comment sheet's handle row, which must keep playback reachable while it
 * covers the transport bar.
 *
 * An `<audio>` is driven directly, which keeps WaveSurfer in sync too: its
 * Player subscribes to the element's own `play`/`pause` events, so
 * `ws.on('pause')` fires and AudioPlayer's button updates with us. A `<video>`
 * goes through `toggleVideo` when given (see MediaTransportOptions).
 * `isPlaying` follows the element's events either way.
 *
 * Image assets have no media element: `isPlaying` stays false and `togglePlay`
 * is a no-op. Callers signal that to MobileCommentSheet by passing
 * `currentTime=""`, which suppresses the mini transport entirely.
 */
export function useMediaTransport({ toggleVideo }: MediaTransportOptions = {}): MediaTransport {
  const [isPlaying, setIsPlaying] = useState(false)
  const elRef = useRef<HTMLMediaElement | null>(null)
  const rootRef = useRef<HTMLElement | null>(null)
  const observerRef = useRef<MutationObserver | null>(null)

  // Stable identities so `mediaRootRef` below is stable too: React calls a
  // callback ref with null and then the node again whenever its identity
  // changes, which would tear down and rebuild the observer every render.
  const onPlay = useCallback(() => setIsPlaying(true), [])
  const onPause = useCallback(() => setIsPlaying(false), [])

  const detach = useCallback(() => {
    elRef.current?.removeEventListener('play', onPlay)
    elRef.current?.removeEventListener('pause', onPause)
    elRef.current = null
  }, [onPlay, onPause])

  const attach = useCallback(() => {
    const root = rootRef.current
    const next = root ? findMediaElement(root) : null
    if (next === elRef.current) return
    detach()
    elRef.current = next
    if (!next) {
      setIsPlaying(false)
      return
    }
    next.addEventListener('play', onPlay)
    next.addEventListener('pause', onPause)
    setIsPlaying(!next.paused)
  }, [detach, onPlay, onPause])

  const mediaRootRef = useCallback(
    (node: HTMLElement | null) => {
      observerRef.current?.disconnect()
      observerRef.current = null
      rootRef.current = node

      if (!node) {
        detach()
        setIsPlaying(false)
        return
      }

      attach()
      // The player mounts asynchronously *within* the column too (stream URL
      // fetch, dynamic import), and a version switch replaces the element, so
      // re-find on any subtree change.
      const observer = new MutationObserver(attach)
      observer.observe(node, { childList: true, subtree: true })
      observerRef.current = observer
    },
    [attach, detach],
  )

  // React calls the callback ref with null on unmount, so this is belt and
  // braces — it also covers a hook unmounted without its node being detached.
  useEffect(
    () => () => {
      observerRef.current?.disconnect()
      observerRef.current = null
      detach()
    },
    [detach],
  )

  const togglePlay = useCallback(() => {
    const el = elRef.current
    if (!el) return
    // Assumes any <video> in the media column is VideoPlayer's, since
    // VideoPlayer is what registers the handler behind `toggleVideo`
    // (registerTogglePlayHandler). Any other <video> rendered there would be
    // routed to a toggle nobody registered, making the sheet button a no-op.
    if (toggleVideo && el.tagName === 'VIDEO') {
      toggleVideo()
      return
    }
    // Autoplay policy can reject this; the button just stays on Play.
    if (el.paused) el.play().catch(() => {})
    else el.pause()
  }, [toggleVideo])

  return { isPlaying, togglePlay, mediaRootRef }
}
