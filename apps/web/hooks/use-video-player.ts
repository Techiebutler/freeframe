'use client'

import Hls, { type Level } from 'hls.js'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useReviewStore } from '@/stores/review-store'
import { hlsStartConfig, saveBandwidth } from '@/lib/hls-bandwidth'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface QualityLevel {
  index: number
  height: number
  bitrate: number
  label: string
}

export interface VideoPlayerControls {
  play: () => void
  pause: () => void
  togglePlay: () => void
  seek: (time: number) => void
  setPlaybackRate: (rate: number) => void
  setQuality: (levelIndex: number) => void
  setVolume: (volume: number) => void
  toggleMute: () => void
  toggleFullscreen: (containerEl: HTMLElement) => void
}

export interface VideoPlayerState {
  isPlaying: boolean
  currentTime: number
  duration: number
  buffered: number
  volume: number
  isMuted: boolean
  playbackRate: number
  qualityLevels: QualityLevel[]
  currentQuality: number
  selectedQuality: number
  isLoading: boolean
  isFullscreen: boolean
  error: string | null
}

export interface UseVideoPlayerReturn extends VideoPlayerControls, VideoPlayerState {
  videoRef: React.RefObject<HTMLVideoElement | null>
  hlsRef: React.RefObject<Hls | null>
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export interface UseVideoPlayerOptions {
  /** Compare panes: don't touch global review-store signals (seekTarget/playheadTime/activeAnnotation). */
  detached?: boolean
}

export function useVideoPlayer(
  src: string | null,
  options?: UseVideoPlayerOptions,
): UseVideoPlayerReturn {
  const detached = options?.detached === true
  const videoRef = useRef<HTMLVideoElement>(null)
  const hlsRef = useRef<Hls | null>(null)
  const syncIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // The armed `canplay` retry of a rejected play() (see togglePlay), together
  // with the element it was armed on. The <video> is reused across source and
  // version changes and an already-paused element fires no `pause` event, so
  // nothing but an explicit disarm stops a stale retry from starting playback
  // the user did not ask for.
  const playRetryRef = useRef<{ video: HTMLVideoElement; onCanPlay: () => void } | null>(null)
  // Bumped whenever the intent to play ends. A play() that is still pending
  // when the user pauses rejects (AbortError) only AFTER that pause, and must
  // not arm a retry from its own rejection.
  const playIntentRef = useRef(0)

  const { setPlayheadTime, seekTarget, setActiveAnnotation } = useReviewStore()

  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [buffered, setBuffered] = useState(0)
  const [volume, setVolumeState] = useState(1)
  const [isMuted, setIsMuted] = useState(false)
  const [playbackRate, setPlaybackRateState] = useState(1)
  // Loading a new source resets the element to its default rate without a
  // `ratechange` the label could follow, so the chosen rate is put back on it.
  const playbackRateRef = useRef(1)
  // When the frame clock last wrote the display, as a `performance.now()`
  // stamp. `timeupdate` reads it to tell a running clock from a stalled one.
  // -Infinity until the first frame, so a clock that has never run never looks
  // alive, whatever the page's clock reads.
  const lastFrameRef = useRef(Number.NEGATIVE_INFINITY)
  const [qualityLevels, setQualityLevels] = useState<QualityLevel[]>([])
  const [currentQuality, setCurrentQuality] = useState(-1) // -1 = no active rung reported
  const [selectedQuality, setSelectedQuality] = useState(-1) // -1 = auto
  const [isLoading, setIsLoading] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Ends the current intent to play: disarms an armed retry and invalidates a
  // play() that has not settled yet. Removes the listener from the element the
  // retry was armed on and never reads videoRef.current, which React has
  // already nulled by the time a passive effect cleanup runs on unmount.
  const cancelPlayRetry = useCallback(() => {
    playIntentRef.current += 1
    const armed = playRetryRef.current
    if (!armed) return
    playRetryRef.current = null
    armed.video.removeEventListener('canplay', armed.onCanPlay)
  }, [])

  // Sync playhead to store at ~4fps to avoid excessive re-renders
  useEffect(() => {
    if (detached) return
    syncIntervalRef.current = setInterval(() => {
      const video = videoRef.current
      if (video && !video.paused) {
        setPlayheadTime(video.currentTime)
      }
    }, 250)
    return () => {
      if (syncIntervalRef.current) clearInterval(syncIntervalRef.current)
    }
  }, [setPlayheadTime, detached])

  // Follow the picture frame by frame while playing. `timeupdate` alone fires
  // only every 250-330 ms in Chrome (7-8 frames at 25 fps), so the timecode
  // moved in steps and jumped when the final update on pause caught up.
  // requestVideoFrameCallback reports each presented frame; requestAnimationFrame
  // is the fallback where it is missing.
  //
  // A detached pane is skipped: no compare code reads its time, so the clock
  // would re-render both panes once per frame for nothing.
  useEffect(() => {
    if (!isPlaying || detached) return
    const video = videoRef.current as (HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number
      cancelVideoFrameCallback?: (handle: number) => void
    }) | null
    if (!video) return
    let stopped = false
    if (typeof video.requestVideoFrameCallback === 'function') {
      let handle = 0
      const onFrame = (_now: number, meta: { mediaTime: number }) => {
        if (stopped) return
        lastFrameRef.current = performance.now()
        setCurrentTime(meta.mediaTime)
        handle = video.requestVideoFrameCallback!(onFrame)
      }
      handle = video.requestVideoFrameCallback(onFrame)
      return () => {
        stopped = true
        video.cancelVideoFrameCallback?.(handle)
      }
    }
    let raf = 0
    const tick = () => {
      if (stopped) return
      lastFrameRef.current = performance.now()
      setCurrentTime(video.currentTime)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      stopped = true
      cancelAnimationFrame(raf)
    }
  }, [isPlaying, detached])

  // React to external seek requests (e.g. clicking comment timecode)
  useEffect(() => {
    if (detached) return
    if (!seekTarget) return
    const video = videoRef.current
    if (!video) return
    const dur = video.duration
    // Allow seek even if duration isn't fully resolved yet (NaN/0)
    if (dur && Number.isFinite(dur)) {
      const clamped = Math.max(0, Math.min(seekTarget.time, dur))
      video.currentTime = clamped
      setCurrentTime(clamped)
      if (seekTarget.pause) {
        cancelPlayRetry()
        video.pause()
        setIsPlaying(false)
      }
    } else {
      // Queue seek for after metadata loads
      const onLoaded = () => {
        const d = video.duration
        if (d && Number.isFinite(d)) {
          const clamped = Math.max(0, Math.min(seekTarget.time, d))
          video.currentTime = clamped
          setCurrentTime(clamped)
          if (seekTarget.pause) {
            cancelPlayRetry()
            video.pause()
            setIsPlaying(false)
          }
        }
        video.removeEventListener('loadedmetadata', onLoaded)
      }
      video.addEventListener('loadedmetadata', onLoaded)
      return () => video.removeEventListener('loadedmetadata', onLoaded)
    }
  }, [seekTarget, detached, cancelPlayRetry])

  // Fullscreen change listener.
  //
  // Three sources, because the modes report differently: the standard event,
  // Safari's prefixed one (iPadOS, desktop), and the video element's own
  // begin/end events, which are the ONLY signal on an iPhone, where the
  // picture goes fullscreen through the native player rather than the document.
  useEffect(() => {
    const doc = document as Document & { webkitFullscreenElement?: Element | null }
    const video = videoRef.current
    const readDoc = () => setIsFullscreen(!!(document.fullscreenElement || doc.webkitFullscreenElement))
    const enter = () => setIsFullscreen(true)
    const leave = () => setIsFullscreen(false)
    document.addEventListener('fullscreenchange', readDoc)
    document.addEventListener('webkitfullscreenchange', readDoc)
    video?.addEventListener('webkitbeginfullscreen', enter)
    video?.addEventListener('webkitendfullscreen', leave)
    return () => {
      document.removeEventListener('fullscreenchange', readDoc)
      document.removeEventListener('webkitfullscreenchange', readDoc)
      video?.removeEventListener('webkitbeginfullscreen', enter)
      video?.removeEventListener('webkitendfullscreen', leave)
    }
  }, [])

  // HLS + video element setup
  useEffect(() => {
    const video = videoRef.current
    if (!video || !src) return

    setError(null)
    setIsLoading(true)

    const onLoadedMetadata = () => {
      video.playbackRate = playbackRateRef.current
      setDuration(video.duration)
      setIsLoading(false)
    }

    const onTimeUpdate = () => {
      // Two writers would otherwise set the same display: the frame clock
      // writes the presented frame's `mediaTime`, and `video.currentTime` here
      // can be up to a frame behind it, so the label stepped back on screen.
      // While the clock is running this only skips the display; `timeupdate`
      // stays the writer whenever the clock cannot run. `video.paused` covers
      // the reverse shuttle, which walks `currentTime` on a paused element,
      // and the 300 ms threshold covers a hidden tab, where neither
      // requestVideoFrameCallback nor requestAnimationFrame fires.
      if (video.paused || performance.now() - lastFrameRef.current > 300) {
        setCurrentTime(video.currentTime)
      }
      // Update buffered end
      if (video.buffered.length > 0) {
        setBuffered(video.buffered.end(video.buffered.length - 1))
      }
    }

    const onPlay = () => { setIsPlaying(true); if (!detached) setActiveAnnotation(null) }
    // Settle the display AND the store on the paused position at once, within
    // a frame of the picture, so a comment written now is anchored there
    // rather than wherever a later update lands. The player's own store sync
    // is throttled and can drop this last value.
    const onPause = () => {
      setIsPlaying(false)
      setCurrentTime(video.currentTime)
      if (!detached) setPlayheadTime(video.currentTime)
    }
    const onWaiting = () => setIsLoading(true)
    const onCanPlay = () => setIsLoading(false)
    const onVolumeChange = () => {
      setVolumeState(video.volume)
      setIsMuted(video.muted)
    }
    const onEnded = () => {
      setIsPlaying(false)
      if (!detached) setPlayheadTime(video.duration)
    }
    const onError = () => {
      setIsLoading(false)
      setError('Video playback error')
    }
    const onProgress = () => {
      if (video.buffered.length > 0) {
        setBuffered(video.buffered.end(video.buffered.length - 1))
      }
    }

    video.addEventListener('loadedmetadata', onLoadedMetadata)
    video.addEventListener('timeupdate', onTimeUpdate)
    video.addEventListener('play', onPlay)
    video.addEventListener('pause', onPause)
    video.addEventListener('waiting', onWaiting)
    video.addEventListener('canplay', onCanPlay)
    video.addEventListener('volumechange', onVolumeChange)
    video.addEventListener('ended', onEnded)
    video.addEventListener('error', onError)
    video.addEventListener('progress', onProgress)

    const isHlsSource = src.includes('.m3u8')

    if (isHlsSource && Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        ...hlsStartConfig(),
      })
      hlsRef.current = hls
      hls.loadSource(src)
      hls.attachMedia(video)

      hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
        const levels: QualityLevel[] = data.levels.map((level: Level, index: number) => ({
          index,
          height: level.height,
          bitrate: level.bitrate,
          // Named by the short side, as the ladder sizes a rung: a portrait
          // 1080x1920 level is 1080p (#452).
          label: level.height
            ? `${Math.min(level.width || level.height, level.height)}p`
            : `${Math.round(level.bitrate / 1000)}kbps`,
        }))
        setQualityLevels(levels)
        setCurrentQuality(-1) // wait for the first active rung
        setSelectedQuality(-1) // each new manifest starts in auto mode
        setIsLoading(false)
      })

      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          setError(`HLS error: ${data.type}`)
          setIsLoading(false)
        }
      })

      hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
        setCurrentQuality(data.level)
      })

      // Remember the measured bandwidth so the next video starts at the right
      // rung. hls.js samples on the same fragments, in a listener registered
      // before this one, so the estimate here already includes this fragment.
      // Compare panes don't save: two players share the link, so each measures
      // about half of it, and whichever saved last would win.
      hls.on(Hls.Events.FRAG_BUFFERED, (_event, { frag }) => {
        if (detached) return
        if (frag.type !== 'main' || frag.sn === 'initSegment' || frag.stats.aborted) return
        saveBandwidth(hls.bandwidthEstimate)
      })
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari native HLS
      video.src = src
    } else {
      // Direct URL (mp4, mp3, etc.)
      video.src = src
    }

    return () => {
      // The element outlives this source, so a retry armed for it must not.
      cancelPlayRetry()
      video.removeEventListener('loadedmetadata', onLoadedMetadata)
      video.removeEventListener('timeupdate', onTimeUpdate)
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('waiting', onWaiting)
      video.removeEventListener('canplay', onCanPlay)
      video.removeEventListener('volumechange', onVolumeChange)
      video.removeEventListener('ended', onEnded)
      video.removeEventListener('error', onError)
      video.removeEventListener('progress', onProgress)

      if (hlsRef.current) {
        hlsRef.current.destroy()
        hlsRef.current = null
      }
    }
  }, [src, setPlayheadTime, cancelPlayRetry, detached])

  // ─── Controls ───────────────────────────────────────────────────────────────

  const play = useCallback(() => {
    videoRef.current?.play().catch(() => {
      // Autoplay may be blocked; ignore
    })
  }, [])

  const pause = useCallback(() => {
    cancelPlayRetry()
    videoRef.current?.pause()
  }, [cancelPlayRetry])

  const togglePlay = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    // Every toggle supersedes the previous one: never two listeners, and a
    // toggle to pause takes the retry with it.
    cancelPlayRetry()
    if (video.paused) {
      const intent = playIntentRef.current
      video.play().catch(() => {
        // Paused, re-toggled, or moved to another source while play() was
        // still pending: this rejection is not a first tap that needs a retry.
        if (intent !== playIntentRef.current) return
        // iOS/ManagedMediaSource: the first gesture often only starts buffering,
        // play() rejects without buffered data. Retry once as soon as
        // data is available, otherwise mobile always needs a second tap.
        const onCanPlay = () => {
          playRetryRef.current = null
          video.play().catch(() => {})
        }
        playRetryRef.current = { video, onCanPlay }
        video.addEventListener('canplay', onCanPlay, { once: true })
        hlsRef.current?.startLoad()
      })
    } else {
      video.pause()
    }
  }, [cancelPlayRetry])

  const seek = useCallback((time: number) => {
    const video = videoRef.current
    if (!video) return
    const clamped = Math.max(0, Math.min(time, video.duration || 0))
    video.currentTime = clamped
    setCurrentTime(clamped)
    if (!detached) setPlayheadTime(clamped)
  }, [setPlayheadTime, detached])

  const setPlaybackRate = useCallback((rate: number) => {
    const video = videoRef.current
    if (!video) return
    video.playbackRate = rate
    playbackRateRef.current = rate
    setPlaybackRateState(rate)
  }, [])

  const setQuality = useCallback((levelIndex: number) => {
    const hls = hlsRef.current
    if (!hls) return
    hls.currentLevel = levelIndex // -1 = auto
    setSelectedQuality(levelIndex)
  }, [])

  const setVolume = useCallback((vol: number) => {
    const video = videoRef.current
    if (!video) return
    const clamped = Math.max(0, Math.min(1, vol))
    video.volume = clamped
    video.muted = clamped === 0
  }, [])

  const toggleMute = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    video.muted = !video.muted
  }, [])

  // An iPhone has no element fullscreen at all: `Element.requestFullscreen` is
  // undefined there, so this threw "not a function" and the button did nothing.
  // Safari on iPadOS and the desktop has the prefixed element API; an iPhone
  // has only the video element's own native player. Try them in that order.
  //
  // The iPhone path shows the system player, so the annotation overlay and our
  // transport are not visible while it is up. That is a platform limit, not a
  // choice: there is no way to put custom chrome over a fullscreen video there.
  const toggleFullscreen = useCallback((containerEl: HTMLElement) => {
    const doc = document as Document & {
      webkitFullscreenElement?: Element | null
      webkitExitFullscreen?: () => Promise<void> | void
    }
    const el = containerEl as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void }
    const video = videoRef.current as (HTMLVideoElement & {
      webkitEnterFullscreen?: () => void
      webkitDisplayingFullscreen?: boolean
    }) | null

    const active = !!(document.fullscreenElement || doc.webkitFullscreenElement)
    if (!active && !video?.webkitDisplayingFullscreen) {
      if (typeof el.requestFullscreen === 'function') {
        void Promise.resolve(el.requestFullscreen()).catch(() => {})
      } else if (typeof el.webkitRequestFullscreen === 'function') {
        void Promise.resolve(el.webkitRequestFullscreen()).catch(() => {})
      } else if (video && typeof video.webkitEnterFullscreen === 'function') {
        video.webkitEnterFullscreen()
      }
      return
    }
    if (typeof document.exitFullscreen === 'function') {
      void Promise.resolve(document.exitFullscreen()).catch(() => {})
    } else if (typeof doc.webkitExitFullscreen === 'function') {
      void Promise.resolve(doc.webkitExitFullscreen()).catch(() => {})
    }
  }, [])

  return {
    videoRef,
    hlsRef,
    // state
    isPlaying,
    currentTime,
    duration,
    buffered,
    volume,
    isMuted,
    playbackRate,
    qualityLevels,
    currentQuality,
    selectedQuality,
    isLoading,
    isFullscreen,
    error,
    // controls
    play,
    pause,
    togglePlay,
    seek,
    setPlaybackRate,
    setQuality,
    setVolume,
    toggleMute,
    toggleFullscreen,
  }
}
