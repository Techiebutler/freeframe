'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Hls from 'hls.js'
import { cn, formatTimecode } from '@/lib/utils'
import { useReviewStore } from '@/stores/review-store'
import type { Comment } from '@/types'

// ─── Avatar helpers ───────────────────────────────────────────────────────────

const AVATAR_COLORS = [
  '#E67E22', '#E74C3C', '#9B59B6', '#3498DB', '#1ABC9C',
  '#2ECC71', '#F39C12', '#D35400', '#8E44AD', '#2980B9',
]

export function getAvatarColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash)
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
}

export function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase()
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase()
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface ProgressBarProps {
  currentTime: number
  duration: number
  buffered?: number
  comments?: Comment[]
  videoRef?: React.RefObject<HTMLVideoElement | null>
  streamUrl?: string | null
  onSeek: (time: number) => void
  className?: string
}

// ─── Frame Preview Hook ───────────────────────────────────────────────────────

function useFramePreview(streamUrl: string | null | undefined) {
  const previewVideoRef = useRef<HTMLVideoElement | null>(null)
  const previewHlsRef = useRef<Hls | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const seekResolveRef = useRef<(() => void) | null>(null)
  const readyRef = useRef(false)
  const [previewImage, setPreviewImage] = useState<string | null>(null)

  // Initialize hidden preview video + HLS
  useEffect(() => {
    if (!streamUrl) return

    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    video.crossOrigin = 'anonymous'
    video.style.display = 'none'
    document.body.appendChild(video)
    previewVideoRef.current = video

    const canvas = document.createElement('canvas')
    canvas.width = 160
    canvas.height = 90
    canvasRef.current = canvas

    const isHls = streamUrl.includes('.m3u8')

    const onReady = () => {
      readyRef.current = true
    }

    video.addEventListener('loadeddata', onReady)

    video.addEventListener('seeked', () => {
      // Capture frame
      try {
        const ctx = canvas.getContext('2d')
        if (ctx && video.videoWidth > 0) {
          const aspectRatio = video.videoWidth / video.videoHeight
          const w = 160
          const h = Math.round(w / aspectRatio)
          canvas.width = w
          canvas.height = h
          ctx.drawImage(video, 0, 0, w, h)
          setPreviewImage(canvas.toDataURL('image/jpeg', 0.7))
        }
      } catch {
        // CORS — silently fail
      }
      seekResolveRef.current?.()
      seekResolveRef.current = null
    })

    if (isHls && Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: false,
        maxBufferLength: 1,
        maxMaxBufferLength: 2,
        maxBufferSize: 0.5 * 1024 * 1024, // 500KB — minimal buffering
      })
      previewHlsRef.current = hls
      hls.loadSource(streamUrl)
      hls.attachMedia(video)
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = streamUrl
    } else {
      video.src = streamUrl
    }

    return () => {
      readyRef.current = false
      if (previewHlsRef.current) {
        previewHlsRef.current.destroy()
        previewHlsRef.current = null
      }
      video.removeEventListener('loadeddata', onReady)
      video.src = ''
      video.remove()
      previewVideoRef.current = null
      canvasRef.current = null
      setPreviewImage(null)
    }
  }, [streamUrl])

  const seekPreview = useCallback((time: number) => {
    const video = previewVideoRef.current
    if (!video || !readyRef.current) return
    // Debounce: if already seeking, skip
    if (seekResolveRef.current) return
    seekResolveRef.current = () => {}
    video.currentTime = Math.max(0, time)
  }, [])

  const clearPreview = useCallback(() => {
    setPreviewImage(null)
  }, [])

  return { previewImage, seekPreview, clearPreview }
}

// ─── Comment Marker ──────────────────────────────────────────────────────────

interface CommentMarkerProps {
  comment: Comment
  index: number
  leftPercent: number
  authorName: string
  initials: string
  color: string
  isHovered: boolean
  isFocused: boolean
  onHover: () => void
  onLeave: () => void
  onSeek: (time: number) => void
}

function CommentMarker({
  comment,
  index,
  leftPercent,
  authorName,
  initials,
  color,
  isHovered,
  isFocused,
  onHover,
  onLeave,
  onSeek,
}: CommentMarkerProps) {
  const markerRef = useRef<HTMLDivElement>(null)
  const setFocusedCommentId = useReviewStore((s) => s.setFocusedCommentId)
  const setActiveAnnotation = useReviewStore((s) => s.setActiveAnnotation)
  const seekTo = useReviewStore((s) => s.seekTo)
  const [tooltipPos, setTooltipPos] = useState<{ left: number; top: number } | null>(null)

  // Recalculate tooltip position when hovered to avoid viewport clipping
  useEffect(() => {
    if (!isHovered || !markerRef.current) {
      setTooltipPos(null)
      return
    }
    const rect = markerRef.current.getBoundingClientRect()
    const tooltipWidth = 240
    let left = rect.left + rect.width / 2 - tooltipWidth / 2
    if (left < 8) left = 8
    if (left + tooltipWidth > window.innerWidth - 8) left = window.innerWidth - 8 - tooltipWidth
    setTooltipPos({ left, top: rect.top - 8 })
  }, [isHovered])

  const handleClick = useCallback(() => {
    if (comment.timecode_start !== null) {
      seekTo(comment.timecode_start, true)
    }
    setFocusedCommentId(comment.id)
    if ((comment as any).annotation?.drawing_data) {
      setActiveAnnotation((comment as any).annotation.drawing_data)
    } else {
      setActiveAnnotation(null)
    }
  }, [comment, seekTo, setFocusedCommentId, setActiveAnnotation])

  return (
    <div
      ref={markerRef}
      className="absolute top-0 -translate-x-1/2 cursor-pointer"
      style={{ left: `${leftPercent}%` }}
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      onClick={handleClick}
    >
      {/* Avatar dot */}
      <div
        className={cn(
          'w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold text-white shadow-md border-2 transition-transform hover:scale-110',
          isFocused ? 'border-accent scale-125 ring-2 ring-accent/40' : 'border-bg-primary',
        )}
        style={{ backgroundColor: color }}
      >
        {initials}
      </div>

      {/* Tooltip — portaled to document.body to escape all overflow */}
      {isHovered && tooltipPos && createPortal(
        <div
          style={{
            position: 'fixed',
            left: tooltipPos.left,
            top: tooltipPos.top,
            width: 240,
            transform: 'translateY(-100%)',
            zIndex: 9999,
            pointerEvents: 'none',
          }}
        >
          <div className="bg-[#1e1e22] border border-white/10 rounded-lg shadow-2xl p-3">
            <div className="flex items-center gap-2 mb-1.5">
              <div
                className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold text-white shrink-0"
                style={{ backgroundColor: color }}
              >
                {initials}
              </div>
              <span className="text-xs font-medium text-white truncate">{authorName}</span>
              {comment.timecode_start !== null && (
                <span className="ml-auto text-[10px] font-mono text-indigo-400 bg-indigo-500/10 px-1.5 py-0.5 rounded">
                  {formatTimecode(comment.timecode_start)}
                </span>
              )}
            </div>
            <p className="text-xs text-text-secondary line-clamp-2 leading-relaxed">
              {comment.body}
            </p>
          </div>
          {/* Arrow */}
          <div className="flex justify-center">
            <div className="w-2 h-2 bg-[#1e1e22] border-b border-r border-white/10 rotate-45 -mt-1" />
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ProgressBar({
  currentTime,
  duration,
  buffered = 0,
  comments = [],
  streamUrl,
  onSeek,
  className,
}: ProgressBarProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [hoverTime, setHoverTime] = useState<number | null>(null)
  const [hoverX, setHoverX] = useState(0)
  const [hoveredCommentId, setHoveredCommentId] = useState<string | null>(null)
  const focusedCommentId = useReviewStore((s) => s.focusedCommentId)

  const { previewImage, seekPreview, clearPreview } = useFramePreview(streamUrl)

  const timeToPercent = useCallback(
    (time: number): number => {
      if (!duration) return 0
      return Math.max(0, Math.min(100, (time / duration) * 100))
    },
    [duration],
  )

  const getTimeFromEvent = useCallback(
    (clientX: number): number => {
      const track = trackRef.current
      if (!track || !duration) return 0
      const rect = track.getBoundingClientRect()
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
      return ratio * duration
    },
    [duration],
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const time = getTimeFromEvent(e.clientX)
      setHoverTime(time)
      const track = trackRef.current
      if (track) {
        const rect = track.getBoundingClientRect()
        setHoverX(e.clientX - rect.left)
      }
      if (isDragging) {
        onSeek(time)
      }
      seekPreview(time)
    },
    [isDragging, getTimeFromEvent, onSeek, seekPreview],
  )

  const handleMouseLeave = useCallback(() => {
    if (!isDragging) {
      setHoverTime(null)
      clearPreview()
    }
  }, [isDragging, clearPreview])

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault()
      setIsDragging(true)
      onSeek(getTimeFromEvent(e.clientX))
    },
    [getTimeFromEvent, onSeek],
  )

  // Global mouse up / move to handle drag outside track
  useEffect(() => {
    if (!isDragging) return

    const handleGlobalMouseMove = (e: MouseEvent) => {
      onSeek(getTimeFromEvent(e.clientX))
    }

    const handleGlobalMouseUp = (e: MouseEvent) => {
      setIsDragging(false)
      setHoverTime(null)
      clearPreview()
      onSeek(getTimeFromEvent(e.clientX))
    }

    window.addEventListener('mousemove', handleGlobalMouseMove)
    window.addEventListener('mouseup', handleGlobalMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleGlobalMouseMove)
      window.removeEventListener('mouseup', handleGlobalMouseUp)
    }
  }, [isDragging, getTimeFromEvent, onSeek, clearPreview])

  // Separate timecoded comments
  const pointMarkers = comments.filter(
    (c) => c.timecode_start !== null && c.timecode_end === null && !c.resolved,
  )
  const rangeMarkers = comments.filter(
    (c) => c.timecode_start !== null && c.timecode_end !== null && !c.resolved,
  )

  const playPercent = timeToPercent(currentTime)
  const bufferedPercent = timeToPercent(buffered)

  return (
    <div className={cn('relative flex flex-col w-full group/progress py-1', className)}>
      {/* Track area */}
      <div
        ref={trackRef}
        className="relative w-full h-1 group-hover/progress:h-1.5 transition-all duration-150 cursor-pointer bg-border rounded-full"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onMouseDown={handleMouseDown}
      >
        {/* Buffered range */}
        <div
          className="absolute inset-y-0 left-0 bg-border-secondary rounded-full"
          style={{ width: `${bufferedPercent}%` }}
        />

        {/* Time-range comment spans */}
        {rangeMarkers.map((c) => {
          if (c.timecode_start === null || c.timecode_end === null) return null
          const left = timeToPercent(c.timecode_start)
          const right = timeToPercent(c.timecode_end)
          return (
            <div
              key={c.id}
              className="absolute inset-y-0 bg-yellow-400/40 rounded-full pointer-events-none"
              style={{
                left: `${left}%`,
                width: `${right - left}%`,
              }}
            />
          )
        })}

        {/* Playback progress */}
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{
            width: `${playPercent}%`,
            background: 'linear-gradient(90deg, #6366f1, #818cf8)',
          }}
        />

        {/* Playhead thumb */}
        <div
          className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-accent shadow-lg opacity-0 group-hover/progress:opacity-100 transition-opacity pointer-events-none z-10"
          style={{ left: `${playPercent}%`, transform: 'translateX(-50%) translateY(-50%)' }}
        />
      </div>

      {/* Comment markers row — below the progress bar */}
      {pointMarkers.length > 0 && (
        <div className="relative w-full h-6 mt-0.5">
          {pointMarkers.map((c, idx) => {
            if (c.timecode_start === null) return null
            const left = timeToPercent(c.timecode_start)
            const authorName = c.author?.name ?? c.guest_author?.name ?? 'Unknown'
            const initials = getInitials(authorName)
            const color = getAvatarColor(authorName)
            const isHovered = hoveredCommentId === c.id

            return (
              <CommentMarker
                key={c.id}
                comment={c}
                index={idx}
                leftPercent={left}
                authorName={authorName}
                initials={initials}
                color={color}
                isHovered={isHovered}
                isFocused={focusedCommentId === c.id}
                onHover={() => setHoveredCommentId(c.id)}
                onLeave={() => setHoveredCommentId(null)}
                onSeek={onSeek}
              />
            )
          })}
        </div>
      )}

      {/* Frame preview + time tooltip on bar hover */}
      {hoverTime !== null && (
        <div
          className="absolute -top-2 z-30 pointer-events-none"
          style={{ left: hoverX, transform: 'translateX(-50%) translateY(-100%)' }}
        >
          {/* Frame preview */}
          {previewImage && (
            <div className="mb-1 rounded-md overflow-hidden border border-white/15 shadow-2xl">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={previewImage} alt="" className="w-40 object-contain bg-black" />
            </div>
          )}
          {/* Time label */}
          <div className="flex justify-center">
            <span className="bg-black/90 text-white text-[11px] font-mono px-2 py-0.5 rounded-md">
              {formatTimecode(hoverTime)}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
