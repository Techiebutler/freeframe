'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  Maximize,
  Minimize,
  Pause,
  Play,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatTime } from '@/lib/utils'
import { api } from '@/lib/api'
import { useReviewStore } from '@/stores/review-store'
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
  className?: string
}

// ─── Component ────────────────────────────────────────────────────────────────

const PLAYBACK_RATES = [0.5, 1, 1.5, 2]

export function VideoPlayer({ assetId, comments = [], className }: VideoPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [streamUrl, setStreamUrl] = useState<string | null>(null)
  const [controlsVisible, setControlsVisible] = useState(true)
  const controlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const { isDrawingMode } = useReviewStore()

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

  // Auto-hide controls
  const showControls = useCallback(() => {
    setControlsVisible(true)
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current)
    if (isPlaying) {
      controlsTimerRef.current = setTimeout(() => setControlsVisible(false), 3000)
    }
  }, [isPlaying])

  useEffect(() => {
    return () => {
      if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current)
    }
  }, [])

  // Keep controls visible when paused
  useEffect(() => {
    if (!isPlaying) {
      setControlsVisible(true)
      if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current)
    }
  }, [isPlaying])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't interfere with input fields or drawing mode
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

  const handleVolumeChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setVolume(parseFloat(e.target.value))
    },
    [setVolume],
  )

  return (
    <div
      ref={containerRef}
      className={cn(
        'relative bg-black overflow-hidden group',
        isFullscreen ? 'fixed inset-0 z-50' : 'rounded-lg',
        className,
      )}
      onMouseMove={showControls}
      onMouseEnter={showControls}
    >
      {/* Video element */}
      <video
        ref={videoRef}
        className={cn(
          'w-full h-full object-contain',
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

      {/* Controls overlay */}
      <div
        className={cn(
          'absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-4 pt-8 pb-3 transition-opacity duration-200',
          controlsVisible ? 'opacity-100' : 'opacity-0',
          isDrawingMode && 'pointer-events-none opacity-0',
        )}
      >
        {/* Progress bar */}
        <ProgressBar
          currentTime={currentTime}
          duration={duration}
          buffered={buffered}
          comments={comments}
          onSeek={seek}
          className="mb-3"
        />

        {/* Control row */}
        <div className="flex items-center gap-3">
          {/* Play / Pause */}
          <button
            onClick={togglePlay}
            className="text-white hover:text-blue-400 transition-colors shrink-0"
            aria-label={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
          </button>

          {/* Volume */}
          <button
            onClick={toggleMute}
            className="text-white hover:text-blue-400 transition-colors shrink-0"
            aria-label={isMuted ? 'Unmute' : 'Mute'}
          >
            {isMuted || volume === 0 ? (
              <VolumeX className="w-5 h-5" />
            ) : (
              <Volume2 className="w-5 h-5" />
            )}
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={isMuted ? 0 : volume}
            onChange={handleVolumeChange}
            className="w-20 accent-blue-500 shrink-0"
            aria-label="Volume"
          />

          {/* Time display */}
          <span className="text-white text-xs tabular-nums shrink-0 ml-1">
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>

          {/* Spacer */}
          <div className="flex-1" />

          {/* Playback speed */}
          <select
            value={playbackRate}
            onChange={(e) => setPlaybackRate(parseFloat(e.target.value))}
            className="bg-transparent text-white text-xs border border-white/30 rounded px-1 py-0.5 cursor-pointer shrink-0"
            aria-label="Playback speed"
          >
            {PLAYBACK_RATES.map((rate) => (
              <option key={rate} value={rate} className="bg-gray-900">
                {rate}x
              </option>
            ))}
          </select>

          {/* Quality selector */}
          {qualityLevels.length > 0 && (
            <select
              value={currentQuality}
              onChange={(e) => setQuality(parseInt(e.target.value, 10))}
              className="bg-transparent text-white text-xs border border-white/30 rounded px-1 py-0.5 cursor-pointer shrink-0"
              aria-label="Quality"
            >
              <option value={-1} className="bg-gray-900">
                Auto
              </option>
              {qualityLevels.map((level) => (
                <option key={level.index} value={level.index} className="bg-gray-900">
                  {level.label}
                </option>
              ))}
            </select>
          )}

          {/* Fullscreen */}
          <button
            onClick={handleFullscreen}
            className="text-white hover:text-blue-400 transition-colors shrink-0"
            aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
          >
            {isFullscreen ? (
              <Minimize className="w-5 h-5" />
            ) : (
              <Maximize className="w-5 h-5" />
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
