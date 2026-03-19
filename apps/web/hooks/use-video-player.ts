'use client'

import Hls, { type Level } from 'hls.js'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useReviewStore } from '@/stores/review-store'

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
  isLoading: boolean
  isFullscreen: boolean
  error: string | null
}

export interface UseVideoPlayerReturn extends VideoPlayerControls, VideoPlayerState {
  videoRef: React.RefObject<HTMLVideoElement>
  hlsRef: React.RefObject<Hls | null>
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useVideoPlayer(src: string | null): UseVideoPlayerReturn {
  const videoRef = useRef<HTMLVideoElement>(null)
  const hlsRef = useRef<Hls | null>(null)
  const syncIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const { setPlayheadTime } = useReviewStore()

  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [buffered, setBuffered] = useState(0)
  const [volume, setVolumeState] = useState(1)
  const [isMuted, setIsMuted] = useState(false)
  const [playbackRate, setPlaybackRateState] = useState(1)
  const [qualityLevels, setQualityLevels] = useState<QualityLevel[]>([])
  const [currentQuality, setCurrentQuality] = useState(-1) // -1 = auto
  const [isLoading, setIsLoading] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Sync playhead to store at ~4fps to avoid excessive re-renders
  useEffect(() => {
    syncIntervalRef.current = setInterval(() => {
      const video = videoRef.current
      if (video && !video.paused) {
        setPlayheadTime(video.currentTime)
      }
    }, 250)
    return () => {
      if (syncIntervalRef.current) clearInterval(syncIntervalRef.current)
    }
  }, [setPlayheadTime])

  // Fullscreen change listener
  useEffect(() => {
    const handleFsChange = () => {
      setIsFullscreen(!!document.fullscreenElement)
    }
    document.addEventListener('fullscreenchange', handleFsChange)
    return () => document.removeEventListener('fullscreenchange', handleFsChange)
  }, [])

  // HLS + video element setup
  useEffect(() => {
    const video = videoRef.current
    if (!video || !src) return

    setError(null)
    setIsLoading(true)

    const onLoadedMetadata = () => {
      setDuration(video.duration)
      setIsLoading(false)
    }

    const onTimeUpdate = () => {
      setCurrentTime(video.currentTime)
      // Update buffered end
      if (video.buffered.length > 0) {
        setBuffered(video.buffered.end(video.buffered.length - 1))
      }
    }

    const onPlay = () => setIsPlaying(true)
    const onPause = () => setIsPlaying(false)
    const onWaiting = () => setIsLoading(true)
    const onCanPlay = () => setIsLoading(false)
    const onVolumeChange = () => {
      setVolumeState(video.volume)
      setIsMuted(video.muted)
    }
    const onEnded = () => {
      setIsPlaying(false)
      setPlayheadTime(video.duration)
    }
    const onError = () => {
      setIsLoading(false)
      setError('Video playback error')
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

    const isHlsSource = src.includes('.m3u8')

    if (isHlsSource && Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
      })
      hlsRef.current = hls
      hls.loadSource(src)
      hls.attachMedia(video)

      hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
        const levels: QualityLevel[] = data.levels.map((level: Level, index: number) => ({
          index,
          height: level.height,
          bitrate: level.bitrate,
          label: level.height ? `${level.height}p` : `${Math.round(level.bitrate / 1000)}kbps`,
        }))
        setQualityLevels(levels)
        setCurrentQuality(-1) // start on auto
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
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari native HLS
      video.src = src
    } else {
      // Direct URL (mp4, mp3, etc.)
      video.src = src
    }

    return () => {
      video.removeEventListener('loadedmetadata', onLoadedMetadata)
      video.removeEventListener('timeupdate', onTimeUpdate)
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('waiting', onWaiting)
      video.removeEventListener('canplay', onCanPlay)
      video.removeEventListener('volumechange', onVolumeChange)
      video.removeEventListener('ended', onEnded)
      video.removeEventListener('error', onError)

      if (hlsRef.current) {
        hlsRef.current.destroy()
        hlsRef.current = null
      }
    }
  }, [src, setPlayheadTime])

  // ─── Controls ───────────────────────────────────────────────────────────────

  const play = useCallback(() => {
    videoRef.current?.play().catch(() => {
      // Autoplay may be blocked; ignore
    })
  }, [])

  const pause = useCallback(() => {
    videoRef.current?.pause()
  }, [])

  const togglePlay = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) {
      video.play().catch(() => {})
    } else {
      video.pause()
    }
  }, [])

  const seek = useCallback((time: number) => {
    const video = videoRef.current
    if (!video) return
    const clamped = Math.max(0, Math.min(time, video.duration || 0))
    video.currentTime = clamped
    setCurrentTime(clamped)
    setPlayheadTime(clamped)
  }, [setPlayheadTime])

  const setPlaybackRate = useCallback((rate: number) => {
    const video = videoRef.current
    if (!video) return
    video.playbackRate = rate
    setPlaybackRateState(rate)
  }, [])

  const setQuality = useCallback((levelIndex: number) => {
    const hls = hlsRef.current
    if (!hls) return
    hls.currentLevel = levelIndex // -1 = auto
    setCurrentQuality(levelIndex)
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

  const toggleFullscreen = useCallback((containerEl: HTMLElement) => {
    if (!document.fullscreenElement) {
      containerEl.requestFullscreen().catch(() => {})
    } else {
      document.exitFullscreen().catch(() => {})
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
