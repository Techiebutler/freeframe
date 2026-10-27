'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { UseVideoPlayerReturn } from './use-video-player'

/** The speeds J and L step through on each press, as in an edit suite. */
export const SHUTTLE_RATES = [1, 2, 4, 8] as const

/** The next shuttle speed above `rate`, holding at the fastest. */
export function nextShuttleRate(rate: number): number {
  return SHUTTLE_RATES.find((r) => r > rate) ?? SHUTTLE_RATES[SHUTTLE_RATES.length - 1]
}

type ShuttlePlayer = Pick<
  UseVideoPlayerReturn,
  'videoRef' | 'isPlaying' | 'playbackRate' | 'play' | 'pause' | 'togglePlay' | 'seek' | 'setPlaybackRate'
>

export interface UseShuttleReturn {
  /** Speed of reverse playback, or 0 when not playing in reverse. */
  reverseRate: number
  /** L: play forward, or one step faster if already playing forward. */
  shuttleForward: () => void
  /** J: play in reverse, or one step faster if already playing in reverse. */
  shuttleReverse: () => void
  /** K, Space and the play button: stops either direction, else toggles play. */
  togglePlay: () => void
  /** The speed menu: a speed picked there is kept when K stops playback. */
  setPlaybackRate: (rate: number) => void
}

/**
 * J/K/L shuttle on top of the video player.
 *
 * A media element can't play backwards: Chrome and Firefox refuse a negative
 * playbackRate. So reverse keeps the element paused and walks currentTime back
 * once per animation frame, by the wall-clock time since the last step times
 * the speed. It only steps when the previous seek has finished, carrying the
 * time owed over, so the speed holds even when seeks are slower than frames
 * and they never queue up behind each other.
 */
export function useShuttle(player: ShuttlePlayer): UseShuttleReturn {
  const { videoRef, isPlaying, playbackRate, play, pause, seek } = player
  const { togglePlay: playerTogglePlay, setPlaybackRate: setRate } = player
  const [reverseRate, setReverseRate] = useState(0)
  // Set while the forward speed came from L rather than the speed menu, so K
  // drops back to 1x instead of leaving the next play running at 8x.
  const forwardShuttledRef = useRef(false)

  useEffect(() => {
    if (!reverseRate) return
    const video = videoRef.current
    if (!video) return

    let last = performance.now()
    let owed = 0
    let raf = requestAnimationFrame(function step(now) {
      owed += ((now - last) / 1000) * reverseRate
      last = now
      if (!video.seeking) {
        const next = Math.max(0, video.currentTime - owed)
        owed = 0
        seek(next)
        if (next === 0) {
          setReverseRate(0)
          return
        }
      }
      raf = requestAnimationFrame(step)
    })

    // Forward playback from anywhere (the scrubber, the mobile sheet, a
    // comment) ends reverse, and so does the element moving to another source.
    const stop = () => setReverseRate(0)
    video.addEventListener('play', stop)
    video.addEventListener('emptied', stop)
    return () => {
      cancelAnimationFrame(raf)
      video.removeEventListener('play', stop)
      video.removeEventListener('emptied', stop)
    }
  }, [reverseRate, videoRef, seek])

  const resetForwardShuttle = useCallback(() => {
    if (!forwardShuttledRef.current) return
    forwardShuttledRef.current = false
    setRate(1)
  }, [setRate])

  const shuttleForward = useCallback(() => {
    if (reverseRate || !isPlaying) {
      setReverseRate(0)
      forwardShuttledRef.current = false
      setRate(1)
      play()
      return
    }
    const next = nextShuttleRate(playbackRate)
    forwardShuttledRef.current = next > 1
    setRate(next)
  }, [reverseRate, isPlaying, playbackRate, play, setRate])

  const shuttleReverse = useCallback(() => {
    if (reverseRate) {
      setReverseRate(nextShuttleRate(reverseRate))
      return
    }
    if (isPlaying) pause()
    resetForwardShuttle()
    setReverseRate(1)
  }, [reverseRate, isPlaying, pause, resetForwardShuttle])

  const togglePlay = useCallback(() => {
    if (reverseRate) {
      setReverseRate(0)
      return
    }
    if (isPlaying && forwardShuttledRef.current) {
      pause()
      resetForwardShuttle()
      return
    }
    playerTogglePlay()
  }, [reverseRate, isPlaying, pause, resetForwardShuttle, playerTogglePlay])

  const setPlaybackRate = useCallback((rate: number) => {
    forwardShuttledRef.current = false
    setRate(rate)
  }, [setRate])

  return { reverseRate, shuttleForward, shuttleReverse, togglePlay, setPlaybackRate }
}
