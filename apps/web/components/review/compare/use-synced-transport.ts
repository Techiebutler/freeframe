'use client'

import * as React from 'react'
import { useVideoPlayer } from '@/hooks/use-video-player'
import {
  driftedBeyond, localTime, sideEnded, sideNotStarted, tMax, type SideTiming,
} from '@/lib/compare-time'

export interface SlavableVideo {
  currentTime: number
  paused: boolean
  play(): unknown
  pause(): void
}

/**
 * Slave one side's <video> to transport time `t`.
 * Before its offset: paused on first frame. Past its end: paused on last frame.
 * Otherwise: playing (when the transport plays) with drift corrected past 50ms.
 */
export function applySideState(video: SlavableVideo, t: number, side: SideTiming, playing: boolean): void {
  const expected = localTime(t, side)
  if (sideNotStarted(t, side) || sideEnded(t, side) || !playing) {
    if (!video.paused) video.pause()
    if (driftedBeyond(expected, video.currentTime, 0.001)) video.currentTime = expected
    return
  }
  if (video.paused) Promise.resolve(video.play()).catch(() => {})
  if (driftedBeyond(expected, video.currentTime)) video.currentTime = expected
}

export interface MasterSample { mediaTime: number; offset: number }

/**
 * Next transport time: follow the master's media clock when one is active,
 * else advance by wall dt. The master is the AUDIBLE video — deriving T from
 * its own clock makes its drift zero BY CONSTRUCTION (expected local =
 * T − offset = its currentTime), so applySideState never issues a corrective
 * seek on it. Corrective seeks on the audible side are audible discontinuities
 * (the "walkie-talkie" crackle); on muted sides they are invisible and keep
 * the 50ms rule.
 */
export function computeNextT(prevT: number, dtWall: number, master: MasterSample | null, total: number): number {
  const next = master ? master.mediaTime + master.offset : prevT + dtWall
  return Math.min(Math.max(next, 0), total)
}

interface UseSyncedTransportArgs {
  urlA: string | null
  urlB: string | null
  timingA: SideTiming
  timingB: SideTiming
  /** The side whose audio is unmuted — it becomes the clock master while active. */
  audibleSide?: 'a' | 'b' | null
}

/**
 * One monotonic transport clock driving two detached players.
 * The clock advances via requestAnimationFrame while playing — following the
 * audible side's media clock when one is active (see computeNextT), the wall
 * clock otherwise; both videos are slaved to it every frame via applySideState
 * (50ms drift rule).
 */
export function useSyncedTransport({ urlA, urlB, timingA, timingB, audibleSide = null }: UseSyncedTransportArgs) {
  const playerA = useVideoPlayer(urlA, { detached: true })
  const playerB = useVideoPlayer(urlB, { detached: true })

  const [t, setT] = React.useState(0)
  const [isPlaying, setIsPlaying] = React.useState(false)
  const tRef = React.useRef(0)
  const playingRef = React.useRef(false)
  const total = tMax(timingA, timingB)
  const totalRef = React.useRef(total)
  totalRef.current = total
  const timingARef = React.useRef(timingA)
  const timingBRef = React.useRef(timingB)
  timingARef.current = timingA
  timingBRef.current = timingB
  const audibleSideRef = React.useRef(audibleSide)
  audibleSideRef.current = audibleSide

  const slaveBoth = React.useCallback((time: number, playing: boolean) => {
    const a = playerA.videoRef.current
    const b = playerB.videoRef.current
    if (a) applySideState(a, time, timingARef.current, playing)
    if (b) applySideState(b, time, timingBRef.current, playing)
  }, [playerA.videoRef, playerB.videoRef])

  // rAF clock
  React.useEffect(() => {
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = (now - last) / 1000
      last = now
      if (playingRef.current) {
        // Audible side = clock master while inside its offset window; before
        // its start / past its end fall back to the wall clock so a short
        // audible side never stalls the shared timeline.
        const side = audibleSideRef.current
        const el = side === 'a' ? playerA.videoRef.current : side === 'b' ? playerB.videoRef.current : null
        const timing = side === 'a' ? timingARef.current : timingBRef.current
        const masterActive = !!el && !!side && !sideNotStarted(tRef.current, timing) && !sideEnded(tRef.current, timing)
        const next = computeNextT(
          tRef.current,
          dt,
          masterActive ? { mediaTime: el.currentTime, offset: timing.offset } : null,
          totalRef.current,
        )
        tRef.current = next
        setT(next)
        if (next >= totalRef.current) {
          playingRef.current = false
          setIsPlaying(false)
        }
      }
      slaveBoth(tRef.current, playingRef.current)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [slaveBoth, playerA.videoRef, playerB.videoRef])

  const seekTo = React.useCallback((time: number) => {
    const clamped = Math.min(Math.max(time, 0), totalRef.current)
    tRef.current = clamped
    setT(clamped)
    slaveBoth(clamped, playingRef.current)
  }, [slaveBoth])

  const toggle = React.useCallback(() => {
    // Restart from 0 when toggling play at the very end.
    if (!playingRef.current && tRef.current >= totalRef.current) {
      tRef.current = 0
      setT(0)
    }
    playingRef.current = !playingRef.current
    setIsPlaying(playingRef.current)
  }, [])

  return { playerA, playerB, t, total, isPlaying, toggle, seekTo, setIsPlaying }
}
