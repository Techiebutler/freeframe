'use client'

import * as React from 'react'
import { useVideoPlayer } from '@/hooks/use-video-player'
import {
  driftedBeyond, frameStep, localTime, sideEnded, sideNotStarted, tMax, type SideTiming,
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
 * `pausedTol` is the drift tolerance while paused/parked (default ~one frame).
 */
export function applySideState(
  video: SlavableVideo,
  t: number,
  side: SideTiming,
  playing: boolean,
  pausedTol: number = frameStep(),
): void {
  const expected = localTime(t, side)
  if (sideNotStarted(t, side) || sideEnded(t, side) || !playing) {
    if (!video.paused) video.pause()
    // Correct only past ~one frame. A paused seek snaps currentTime to the
    // nearest decodable frame, which is essentially never exactly `expected`;
    // a sub-frame threshold (the old 1ms) re-issued the seek on every rAF
    // forever — decoder thrash on the exact paused-frame-inspection workflow
    // compare exists for. One frame is display-accurate (you can't show a
    // fractional frame) and lets a freshly-loaded pane still snap into place.
    if (driftedBeyond(expected, video.currentTime, pausedTol)) video.currentTime = expected
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

/** The element-liveness slice of HTMLVideoElement the master predicate needs. */
export interface MasterCandidate { ended: boolean; error: unknown }

/**
 * The audible side may own the clock only while LIVE (not ended, no media
 * error) and inside its recorded offset window. Liveness matters because the
 * recorded duration routinely overshoots the real media duration by
 * milliseconds: the element then fires `ended` while T is still inside the
 * recorded window, and an ended master would freeze T — worse, play() on an
 * ended element restarts it from 0, so the 50ms rule would seek it back and
 * it would end again (freeze/replay chatter). An ended/errored master instead
 * releases the clock to wall time, and the recorded-window freeze-last-frame
 * semantics complete the end normally.
 */
export function isMasterActive(el: MasterCandidate | null, t: number, timing: SideTiming): boolean {
  return !!el && !el.ended && !el.error && !sideNotStarted(t, timing) && !sideEnded(t, timing)
}

interface UseSyncedTransportArgs {
  urlA: string | null
  urlB: string | null
  timingA: SideTiming
  timingB: SideTiming
  /** The side whose audio is unmuted — it becomes the clock master while active. */
  audibleSide?: 'a' | 'b' | null
  /** Frame rate — sets the paused drift tolerance to ~one frame (see applySideState). */
  fps?: number | null
}

/**
 * One transport clock driving two detached players.
 * The clock advances via requestAnimationFrame while playing — following the
 * audible side's media clock while that side is live and inside its window
 * (see computeNextT / isMasterActive), the wall clock otherwise. T is
 * therefore NEAR-monotonic: a master handoff (audible-side switch, end,
 * error) may step it backward by a bounded amount — do not assume strict
 * monotonicity. Both videos are slaved to T every frame via applySideState
 * (50ms drift rule).
 */
export function useSyncedTransport({ urlA, urlB, timingA, timingB, audibleSide = null, fps = null }: UseSyncedTransportArgs) {
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
  const pausedTolRef = React.useRef(frameStep(fps))
  pausedTolRef.current = frameStep(fps)

  const slaveBoth = React.useCallback((time: number, playing: boolean) => {
    const a = playerA.videoRef.current
    const b = playerB.videoRef.current
    if (a) applySideState(a, time, timingARef.current, playing, pausedTolRef.current)
    if (b) applySideState(b, time, timingBRef.current, playing, pausedTolRef.current)
  }, [playerA.videoRef, playerB.videoRef])

  // rAF clock
  React.useEffect(() => {
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = (now - last) / 1000
      last = now
      if (playingRef.current) {
        // Audible side = clock master while live and inside its offset
        // window; before its start / past its end / on ended or media error
        // fall back to the wall clock so a short (or dead) audible side
        // never stalls the shared timeline.
        const side = audibleSideRef.current
        const el = side === 'a' ? playerA.videoRef.current : side === 'b' ? playerB.videoRef.current : null
        const timing = side === 'a' ? timingARef.current : timingBRef.current
        const masterActive = !!el && !!side && isMasterActive(el, tRef.current, timing)
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
