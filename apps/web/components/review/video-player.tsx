'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  Maximize,
  Minimize,
  Pause,
  Play,
  Volume2,
  VolumeX,
  ChevronUp,
  Check,
  Repeat,
} from 'lucide-react'
import { cn, formatTime, formatTimecode, formatFrames } from '@/lib/utils'
import { api } from '@/lib/api'
import { useReviewStore, type TimeFormat } from '@/stores/review-store'
import { useVideoPlayer } from '@/hooks/use-video-player'
import { ProgressBar } from './progress-bar'
import type { Comment } from '@/types'

// ─── Types ────────────────────────────────────────────────────────────────────

interface StreamUrlResponse {
  url: string
}

interface VideoPlayerProps {
  assetId: string
  comments?: Comment[]
  overlay?: React.ReactNode
  className?: string
}

// ─── Video frame constraint ──────────────────────────────────────────────────

/**
 * Wraps children so they are positioned exactly over the visible video frame,
 * excluding the black letterbox bars created by object-contain.
 */
function VideoFrameConstraint({
  videoRef,
  children,
}: {
  videoRef: React.RefObject<HTMLVideoElement>
  children: React.ReactNode
}) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState<React.CSSProperties>({})

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const calc = () => {
      const container = video.parentElement
      if (!container) return

      const cw = container.clientWidth
      const ch = container.clientHeight
      const vw = video.videoWidth
      const vh = video.videoHeight

      if (!vw || !vh) {
        // Video metadata not loaded yet — fill container
        setStyle({ position: 'absolute', inset: 0 })
        return
      }

      const containerAspect = cw / ch
      const videoAspect = vw / vh

      let renderW: number, renderH: number, offsetX: number, offsetY: number

      if (videoAspect > containerAspect) {
        // Video wider than container — letterbox top/bottom
        renderW = cw
        renderH = cw / videoAspect
        offsetX = 0
        offsetY = (ch - renderH) / 2
      } else {
        // Video taller than container — letterbox left/right
        renderH = ch
        renderW = ch * videoAspect
        offsetX = (cw - renderW) / 2
        offsetY = 0
      }

      setStyle({
        position: 'absolute',
        left: offsetX,
        top: offsetY,
        width: renderW,
        height: renderH,
      })
    }

    calc()
    video.addEventListener('loadedmetadata', calc)
    video.addEventListener('resize', calc)

    const ro = new ResizeObserver(calc)
    if (video.parentElement) ro.observe(video.parentElement)

    return () => {
      video.removeEventListener('loadedmetadata', calc)
      video.removeEventListener('resize', calc)
      ro.disconnect()
    }
  }, [videoRef])

  return (
    <div ref={wrapperRef} style={style} className="overflow-hidden">
      {children}
    </div>
  )
}

// ─── Component ────────────────────────────────────────────────────────────────

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const

export function VideoPlayer({ assetId, comments = [], overlay, className }: VideoPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [streamUrl, setStreamUrl] = useState<string | null>(null)
  const [loop, setLoop] = useState(false)

  const { isDrawingMode, timeFormat, setTimeFormat, setPlayheadTime } = useReviewStore()
  const [timeFormatOpen, setTimeFormatOpen] = useState(false)
  const timeFormatRef = useRef<HTMLDivElement>(null)

  // Sync video currentTime to review store so comment input shows same timecode
  const lastSyncRef = useRef(0)
  useEffect(() => {
    // Throttle to avoid excessive store updates — sync every 100ms
    const now = Date.now()
    if (now - lastSyncRef.current > 100) {
      setPlayheadTime(currentTime)
      lastSyncRef.current = now
    }
  }, [currentTime, setPlayheadTime])

  // Close time format dropdown on outside click
  useEffect(() => {
    if (!timeFormatOpen) return
    const handleClick = (e: MouseEvent) => {
      if (timeFormatRef.current && !timeFormatRef.current.contains(e.target as Node)) setTimeFormatOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [timeFormatOpen])

  function displayTime(seconds: number): string {
    switch (timeFormat) {
      case 'frames': return formatFrames(seconds)
      case 'standard': return formatTime(seconds)
      case 'timecode': return formatTimecode(seconds)
      default: return formatTimecode(seconds)
    }
  }

  // Load the stream URL
  useEffect(() => {
    api
      .get<StreamUrlResponse>(`/assets/${assetId}/stream`)
      .then((data) => setStreamUrl(data.url))
      .catch(() => {
        /* stream URL errors handled by player error state */
      })
  }, [assetId])

  const player = useVideoPlayer(streamUrl)

  const {
    videoRef,
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
    togglePlay,
    seek,
    setPlaybackRate,
    setQuality,
    setVolume,
    toggleMute,
    toggleFullscreen,
  } = player

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        isDrawingMode
      ) {
        return
      }

      switch (e.code) {
        case 'Space':
          e.preventDefault()
          togglePlay()
          break
        case 'ArrowLeft':
          e.preventDefault()
          seek(currentTime - 5)
          break
        case 'ArrowRight':
          e.preventDefault()
          seek(currentTime + 5)
          break
        case 'KeyJ':
          seek(currentTime - 10)
          break
        case 'KeyK':
          togglePlay()
          break
        case 'KeyL':
          seek(currentTime + 10)
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [togglePlay, seek, currentTime, isDrawingMode])

  const handleContainerClick = useCallback(() => {
    if (!isDrawingMode) {
      togglePlay()
    }
  }, [togglePlay, isDrawingMode])

  const handleFullscreen = useCallback(() => {
    if (containerRef.current) {
      toggleFullscreen(containerRef.current)
    }
  }, [toggleFullscreen])

  const handleSpeedCycle = useCallback(() => {
    const idx = SPEED_OPTIONS.indexOf(playbackRate as typeof SPEED_OPTIONS[number])
    const next = SPEED_OPTIONS[(idx + 1) % SPEED_OPTIONS.length]
    setPlaybackRate(next)
  }, [playbackRate, setPlaybackRate])

  return (
    <div
      ref={containerRef}
      className={cn(
        'flex flex-col h-full w-full',
        isFullscreen && 'fixed inset-0 z-50',
        className,
      )}
    >
      {/* Video area — fills available space, object-contain preserves aspect ratio with letterbox */}
      <div className="flex-1 relative min-h-0 bg-black overflow-hidden">
        <video
          ref={videoRef}
          className={cn(
            'absolute inset-0 w-full h-full object-contain',
            isDrawingMode ? 'pointer-events-none' : 'cursor-pointer',
          )}
          onClick={handleContainerClick}
          playsInline
          preload="metadata"
        />

        {/* Loading spinner */}
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-10 h-10 border-4 border-white/20 border-t-white rounded-full animate-spin" />
          </div>
        )}

        {/* Error state */}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60">
            <p className="text-red-400 text-sm">{error}</p>
          </div>
        )}

        {/* Overlay slot (annotation canvas / overlay) — constrained to video frame */}
        {overlay && <VideoFrameConstraint videoRef={videoRef}>{overlay}</VideoFrameConstraint>}
      </div>

      {/* Progress bar */}
      <div className="px-4 shrink-0 bg-bg-primary">
        <ProgressBar
          currentTime={currentTime}
          duration={duration}
          buffered={buffered}
          comments={comments}
          streamUrl={streamUrl}
          onSeek={seek}
        />
      </div>

      {/* Bottom transport bar (matches audio player style) */}
      <div className="flex items-center justify-between h-12 px-4 bg-bg-secondary/80 border-t border-border shrink-0">
        {/* Left: Play, Loop, Speed, Volume */}
        <div className="flex items-center gap-2">
          <button
            onClick={togglePlay}
            className="flex h-7 w-7 items-center justify-center rounded text-text-primary hover:bg-bg-hover transition-colors"
            aria-label={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </button>

          <button
            onClick={() => setLoop((p) => !p)}
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded transition-colors',
              loop ? 'text-accent bg-accent/10' : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover',
            )}
            aria-label="Loop"
          >
            <Repeat className="h-4 w-4" />
          </button>

          <button
            onClick={handleSpeedCycle}
            className="flex h-7 items-center justify-center rounded px-1.5 text-xs font-medium text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors tabular-nums"
            aria-label="Playback speed"
          >
            {playbackRate}x
          </button>

          <button
            onClick={toggleMute}
            className="flex h-7 w-7 items-center justify-center rounded text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors"
            aria-label={isMuted ? 'Unmute' : 'Mute'}
          >
            {isMuted || volume === 0 ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </button>
        </div>

        {/* Center: Timecode display with format picker */}
        <div className="relative" ref={timeFormatRef}>
          <button
            onClick={() => setTimeFormatOpen((p) => !p)}
            className="flex items-center gap-1.5 rounded-md bg-bg-tertiary px-3 py-1 hover:bg-bg-hover transition-colors"
          >
            <span className="font-mono text-sm text-text-primary tabular-nums tracking-wide">
              {timeFormat === 'timecode'
                ? displayTime(currentTime)
                : <>{displayTime(currentTime)} <span className="text-text-tertiary">/</span> {displayTime(duration)}</>
              }
            </span>
            <ChevronUp className={cn('h-3 w-3 text-text-tertiary transition-transform', timeFormatOpen && 'rotate-180')} />
          </button>
          {timeFormatOpen && (
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 w-48 rounded-xl border border-white/10 bg-[#2a2a30] shadow-2xl py-1.5 animate-in fade-in zoom-in-95 duration-100">
              <div className="px-3 py-2 text-[11px] text-text-tertiary uppercase tracking-wider font-medium">
                Time Format
              </div>
              {([
                { id: 'frames' as TimeFormat, label: 'Frames' },
                { id: 'standard' as TimeFormat, label: 'Standard' },
                { id: 'timecode' as TimeFormat, label: 'Timecode' },
              ] as const).map((item) => (
                <button
                  key={item.id}
                  className={cn(
                    'flex w-full items-center justify-between px-3 py-2 text-[13px] transition-colors',
                    timeFormat === item.id ? 'text-text-primary' : 'text-text-secondary hover:bg-white/5',
                  )}
                  onClick={() => { setTimeFormat(item.id); setTimeFormatOpen(false) }}
                >
                  {item.label}
                  {timeFormat === item.id && <Check className="h-4 w-4 text-accent" />}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Right: Quality, Fullscreen */}
        <div className="flex items-center gap-2">
          {/* Quality selector */}
          {qualityLevels.length > 0 && (
            <select
              value={currentQuality}
              onChange={(e) => setQuality(parseInt(e.target.value, 10))}
              className="bg-transparent text-text-secondary text-xs border border-border rounded px-1.5 py-1 cursor-pointer shrink-0 hover:text-text-primary transition-colors"
              aria-label="Quality"
            >
              <option value={-1} className="bg-bg-secondary">
                Auto
              </option>
              {qualityLevels.map((level) => (
                <option key={level.index} value={level.index} className="bg-bg-secondary">
                  {level.label}
                </option>
              ))}
            </select>
          )}

          {/* Fullscreen */}
          <button
            onClick={handleFullscreen}
            className="flex h-7 w-7 items-center justify-center rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
            aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
          >
            {isFullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </div>
  )
}
