'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Hls from 'hls.js'
import { Globe, Lock, X } from 'lucide-react'
import { cn, formatTimecode } from '@/lib/utils'
import { buildCommentNumbers } from '@/lib/comment-numbers'
import { Avatar } from '@/components/shared/avatar'
import { useReviewStore } from '@/stores/review-store'
import type { Comment } from '@/types'

// ─── Avatar helpers ───────────────────────────────────────────────────────────

const AVATAR_COLORS = [
  '#E67E22', '#E74C3C', '#9B59B6', '#3498DB', '#1ABC9C',
  '#2ECC71', '#F39C12', '#D35400', '#8E44AD', '#2980B9',
]
const FRAME_PREVIEW_WIDTH = 160
const FRAME_PREVIEW_EDGE_MARGIN = 24
const COMMENT_TOOLTIP_EDGE_MARGIN = 8

export function getAvatarColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash)
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
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
  onScrubSeek?: (time: number) => void
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
  /** Canonical number shared with the side panel — NOT the marker's array position. */
  commentNumber?: number
  leftPercent: number
  rightPercent?: number
  authorName: string
  color: string
  isHovered: boolean
  isFocused: boolean
  onHover: () => void
  onLeave: () => void
  onSeek: (time: number) => void
}

function CommentMarker({
  comment,
  commentNumber,
  leftPercent,
  rightPercent,
  authorName,
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

  // Keep comment cards inside the timeline without the larger frame-preview gutter.
  useEffect(() => {
    if (!isHovered || !markerRef.current) {
      setTooltipPos(null)
      return
    }
    const rect = markerRef.current.getBoundingClientRect()
    const timelineRect = markerRef.current.parentElement?.getBoundingClientRect()
    const tooltipWidth = 240
    let left = rect.left + rect.width / 2 - tooltipWidth / 2
    const safeLeft = (timelineRect?.left ?? 0) + COMMENT_TOOLTIP_EDGE_MARGIN
    const safeRight = Math.max(
      safeLeft,
      (timelineRect?.right ?? window.innerWidth) - COMMENT_TOOLTIP_EDGE_MARGIN - tooltipWidth,
    )
    left = Math.min(safeRight, Math.max(safeLeft, left))
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
      className={cn(
        'absolute top-0 cursor-pointer pointer-events-auto',
        rightPercent === undefined && '-translate-x-1/2',
      )}
      style={{
        left: `${leftPercent}%`,
        width: rightPercent === undefined ? undefined : `${Math.max(0, rightPercent - leftPercent)}%`,
      }}
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      onClick={handleClick}
    >
      {rightPercent !== undefined && (
        <div
          className={cn(
            'absolute left-0 right-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-white transition-opacity',
            isFocused ? 'opacity-100' : 'opacity-90',
          )}
        />
      )}

      {/* Avatar dot */}
      <Avatar
        src={comment.author?.avatar_url}
        name={authorName}
        color={comment.author?.avatar_color}
        className={cn(
          'font-bold leading-none text-white shadow-md border-2 transition-transform hover:scale-110',
          rightPercent === undefined ? 'w-5 h-5 text-[9px]' : 'w-5 h-5 -translate-x-1/2 text-[9px]',
          isFocused ? 'border-accent scale-125 ring-2 ring-accent/40' : 'border-bg-primary',
        )}
        style={{ backgroundColor: color }}
      />

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
              <Avatar
                src={comment.author?.avatar_url}
                name={authorName}
                color={comment.author?.avatar_color}
                className="w-5 h-5 text-[9px] font-bold leading-none text-white"
                style={{ backgroundColor: color }}
              />
              <span className="min-w-0 flex-1 text-xs font-medium text-white truncate">{authorName}</span>
              <div className="flex items-center gap-1.5 shrink-0 text-text-tertiary">
                {commentNumber !== undefined && (
                  <span className="text-[10px] font-semibold">#{commentNumber}</span>
                )}
                {comment.visibility === 'internal' ? (
                  <Lock className="h-3.5 w-3.5 text-amber-400" />
                ) : (
                  <Globe className="h-3.5 w-3.5" />
                )}
              </div>
            </div>
            <div className="flex items-start gap-2">
              {comment.timecode_start !== null && (
                <span className="shrink-0 text-[10px] font-mono text-amber-400 bg-amber-500/20 px-1.5 py-0.5 rounded">
                  {formatTimecode(comment.timecode_start)}
                  {comment.timecode_end !== null && ` — ${formatTimecode(comment.timecode_end)}`}
                </span>
              )}
              <p className="min-w-0 text-xs text-text-secondary line-clamp-2 leading-relaxed">
                {comment.body}
              </p>
            </div>
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
  onScrubSeek,
  className,
}: ProgressBarProps) {
  const progressRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const seekFrameRef = useRef<number | null>(null)
  // The pointer driving the current drag (scrub or Shift+drag range). Only it
  // may move or end the drag, so a second finger cannot hijack the seek.
  const activePointerIdRef = useRef<number | null>(null)
  const dragModeRef = useRef<'scrub' | 'range' | null>(null)
  const queuedSeekTimeRef = useRef<number | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [scrubTime, setScrubTime] = useState<number | null>(null)
  const [rangeDragStart, setRangeDragStart] = useState<number | null>(null)
  const [rangeDragEnd, setRangeDragEnd] = useState<number | null>(null)
  const [draggingRangeHandle, setDraggingRangeHandle] = useState<'start' | 'end' | null>(null)
  const [hoverTime, setHoverTime] = useState<number | null>(null)
  const [hoverX, setHoverX] = useState(0)
  const [isTrackHovered, setIsTrackHovered] = useState(false)
  const [hoveredCommentId, setHoveredCommentId] = useState<string | null>(null)
  const focusedCommentId = useReviewStore((s) => s.focusedCommentId)
  const selectedTimeRange = useReviewStore((s) => s.selectedTimeRange)
  const setSelectedTimeRange = useReviewStore((s) => s.setSelectedTimeRange)

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

  // Pointer events can fire far faster than a video frame can be decoded. Coalesce
  // native seeks to one per animation frame while keeping the progress UI in sync
  // with the pointer through `scrubTime`. Only the fast scrub path is coalesced;
  // a player without one (audio) seeks straight away.
  const scheduleSeek = useCallback((time: number) => {
    if (!onScrubSeek) {
      onSeek(time)
      return
    }
    queuedSeekTimeRef.current = time
    if (seekFrameRef.current !== null) return

    seekFrameRef.current = requestAnimationFrame(() => {
      seekFrameRef.current = null
      const queuedTime = queuedSeekTimeRef.current
      queuedSeekTimeRef.current = null
      if (queuedTime !== null) (onScrubSeek ?? onSeek)(queuedTime)
    })
  }, [onScrubSeek, onSeek])

  const flushSeek = useCallback((time: number) => {
    queuedSeekTimeRef.current = time
    if (seekFrameRef.current !== null) {
      cancelAnimationFrame(seekFrameRef.current)
      seekFrameRef.current = null
    }
    const queuedTime = queuedSeekTimeRef.current
    queuedSeekTimeRef.current = null
    if (queuedTime !== null) onSeek(queuedTime)
  }, [onSeek])

  useEffect(() => () => {
    if (seekFrameRef.current !== null) cancelAnimationFrame(seekFrameRef.current)
  }, [])

  useEffect(() => {
    if (scrubTime !== null && Math.abs(currentTime - scrubTime) < 0.01) {
      setScrubTime(null)
    }
  }, [currentTime, scrubTime])

  // Hover: the floating frame preview + timecode stays inside the player, with
  // a margin sized for the 160px thumbnail.
  const previewXFor = useCallback((clientX: number): number => {
    const track = trackRef.current
    if (!track) return 0
    const rect = track.getBoundingClientRect()
    const progressRect = progressRef.current?.getBoundingClientRect() ?? rect
    const cursorX = clientX - progressRect.left
    const halfPreview = FRAME_PREVIEW_WIDTH / 2
    const edgeMargin = Math.min(
      FRAME_PREVIEW_EDGE_MARGIN,
      Math.max(0, (progressRect.width - FRAME_PREVIEW_WIDTH) / 2),
    )
    return progressRect.width <= FRAME_PREVIEW_WIDTH
      ? progressRect.width / 2
      : Math.min(
          progressRect.width - halfPreview - edgeMargin,
          Math.max(halfPreview + edgeMargin, cursorX),
        )
  }, [])

  // Dragging: only the timecode shows (the video itself is the preview). It is
  // clamped to the track, because a captured drag keeps delivering pointermove
  // past the track's edges and would otherwise push the tooltip off the player
  // (e.g. over the comment panel), though the seek itself is already clamped.
  const dragXFor = useCallback((clientX: number): number => {
    const track = trackRef.current
    if (!track) return 0
    const trackRect = track.getBoundingClientRect()
    const progressRect = progressRef.current?.getBoundingClientRect() ?? trackRect
    const min = trackRect.left - progressRect.left
    const max = trackRect.right - progressRect.left
    return Math.max(min, Math.min(max, clientX - progressRect.left))
  }, [])

  const endDrag = useCallback(() => {
    activePointerIdRef.current = null
    dragModeRef.current = null
    setIsDragging(false)
    setRangeDragStart(null)
    setRangeDragEnd(null)
    setHoverTime(null)
    clearPreview()
  }, [clearPreview])

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Ignore a secondary touch and any button but the main one (right-click).
      if (!e.isPrimary || e.button !== 0) return
      if (activePointerIdRef.current !== null) return // a drag is already in progress
      e.preventDefault()
      activePointerIdRef.current = e.pointerId
      // Capture keeps move/up/cancel coming to this element once the pointer
      // leaves the track, so no window listeners are needed. Optional: jsdom
      // does not implement it.
      e.currentTarget.setPointerCapture?.(e.pointerId)
      const time = getTimeFromEvent(e.clientX)
      if (e.shiftKey) {
        dragModeRef.current = 'range'
        setRangeDragStart(time)
        setRangeDragEnd(time)
        return
      }
      dragModeRef.current = 'scrub'
      setIsDragging(true)
      setScrubTime(time)
      setHoverTime(time)
      setHoverX(dragXFor(e.clientX))
      clearPreview()
      flushSeek(time)
    },
    [clearPreview, dragXFor, flushSeek, getTimeFromEvent],
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const time = getTimeFromEvent(e.clientX)
      if (activePointerIdRef.current !== null) {
        // Only the pointer that started the drag may drive it.
        if (e.pointerId !== activePointerIdRef.current) return
        if (dragModeRef.current === 'range') {
          setRangeDragEnd(time)
          return
        }
        setHoverTime(time)
        setHoverX(dragXFor(e.clientX))
        setScrubTime(time)
        scheduleSeek(time)
        return
      }
      if (draggingRangeHandle) return
      setHoverTime(time)
      setHoverX(previewXFor(e.clientX))
      seekPreview(time)
    },
    [draggingRangeHandle, dragXFor, getTimeFromEvent, previewXFor, scheduleSeek, seekPreview],
  )

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.pointerId !== activePointerIdRef.current) return
      const time = getTimeFromEvent(e.clientX)
      if (dragModeRef.current === 'range') {
        if (rangeDragStart !== null) {
          const start = Math.min(rangeDragStart, time)
          const end = Math.max(rangeDragStart, time)
          setSelectedTimeRange(end - start > 0.05 ? { start, end } : null)
        }
      } else {
        setScrubTime(time)
        flushSeek(time)
      }
      endDrag()
    },
    [endDrag, flushSeek, getTimeFromEvent, rangeDragStart, setSelectedTimeRange],
  )

  const handlePointerCancel = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // iOS fires this instead of pointerup when the system takes the gesture
      // (a pinch, an edge swipe, a long-press callout). The drag must still
      // end, or every later pointer move on the page seeks.
      if (e.pointerId !== activePointerIdRef.current) return
      endDrag()
    },
    [endDrag],
  )

  const handlePointerLeave = useCallback(() => {
    if (activePointerIdRef.current === null && !draggingRangeHandle) {
      setHoverTime(null)
      clearPreview()
    }
  }, [draggingRangeHandle, clearPreview])

  // Range handles (below the bar) drag with window listeners.
  useEffect(() => {
    if (!draggingRangeHandle) return

    const handleGlobalMouseMove = (e: MouseEvent) => {
      if (!selectedTimeRange) return
      const time = getTimeFromEvent(e.clientX)
      setSelectedTimeRange(
        draggingRangeHandle === 'start'
          ? { start: Math.min(time, selectedTimeRange.end), end: selectedTimeRange.end }
          : { start: selectedTimeRange.start, end: Math.max(time, selectedTimeRange.start) },
      )
    }

    const handleGlobalMouseUp = () => {
      setDraggingRangeHandle(null)
      setHoverTime(null)
      clearPreview()
    }

    window.addEventListener('mousemove', handleGlobalMouseMove)
    window.addEventListener('mouseup', handleGlobalMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleGlobalMouseMove)
      window.removeEventListener('mouseup', handleGlobalMouseUp)
    }
  }, [draggingRangeHandle, selectedTimeRange, getTimeFromEvent, clearPreview, setSelectedTimeRange])

  // Separate timecoded comments
  // Same helper the side panel uses, so a marker's #N always matches its card's.
  const commentNumbers = React.useMemo(() => buildCommentNumbers(comments), [comments])

  const pointMarkers = comments.filter(
    (c) => c.timecode_start !== null && c.timecode_end === null && !c.resolved,
  )
  const rangeMarkers = comments.filter(
    (c) => c.timecode_start !== null && c.timecode_end !== null && !c.resolved,
  )

  const playPercent = timeToPercent(scrubTime ?? currentTime)
  const bufferedPercent = timeToPercent(buffered)
  const activeRange = rangeDragStart !== null && rangeDragEnd !== null
    ? { start: Math.min(rangeDragStart, rangeDragEnd), end: Math.max(rangeDragStart, rangeDragEnd) }
    : selectedTimeRange
  const hasAreaRange = !!activeRange && activeRange.end - activeRange.start > 0.05
  const rangeHandleTimes = activeRange
    ? hasAreaRange
      ? [activeRange.start, activeRange.end]
      : [activeRange.start]
    : []

  return (
    <div ref={progressRef} className={cn('relative flex flex-col w-full group/progress', className)}>
      {/* Track area */}
      <div
        ref={trackRef}
        data-testid="progress-bar-track"
        className={cn(
          "relative mx-3 h-1 cursor-pointer touch-none before:absolute before:-top-3 before:bottom-0 before:inset-x-0 before:content-['']",
        )}
        onMouseEnter={() => setIsTrackHovered(true)}
        onMouseLeave={() => setIsTrackHovered(false)}
        onPointerLeave={handlePointerLeave}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onLostPointerCapture={endDrag}
        title="Shift + drag to select a comment range"
      >
        <div className={cn('pointer-events-none absolute inset-0 origin-bottom rounded-full bg-border transition-transform duration-200 ease-out', isTrackHovered || isDragging ? 'scale-y-[3]' : 'scale-y-100')}>
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
              className={cn(
                'absolute inset-y-0 rounded-full pointer-events-none',
                focusedCommentId === c.id ? 'bg-white/35' : 'bg-white/20',
              )}
              style={{
                left: `${left}%`,
                width: `${right - left}%`,
              }}
            />
          )
        })}

        {/* Pending/selected range for the next comment */}
        {activeRange && hasAreaRange && (
          <>
            <div
              className="absolute inset-y-0 rounded-sm bg-amber-400/45 pointer-events-none z-[1]"
              style={{
                left: `${timeToPercent(activeRange.start)}%`,
                width: `${Math.max(0.4, timeToPercent(activeRange.end) - timeToPercent(activeRange.start))}%`,
              }}
            />
          </>
        )}

        {/* Playback progress */}
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{
            width: `${playPercent}%`,
            background: 'var(--accent)',
          }}
        />

        {/* Playhead thumb */}
        <div
          className="absolute -top-px -translate-x-1/2 w-[3px] h-1.5 rounded-[1px] bg-white shadow-sm pointer-events-none z-10"
          style={{ left: `${playPercent}%`, transform: 'translateX(-50%)' }}
        />
        </div>
      </div>

      {/* Comment markers row — below the progress bar */}
      {(pointMarkers.length > 0 || rangeMarkers.length > 0 || activeRange) && (
        <div className="relative mx-3 h-6 mt-0.5">
          {activeRange && <>
            {rangeHandleTimes.map((time, index) => (
              <button
                type="button"
                key={`range-handle-${index}`}
                disabled={!selectedTimeRange}
                className={cn(
                  'absolute top-0 z-[2] h-5 cursor-ew-resize disabled:cursor-default',
                  hasAreaRange ? 'w-3' : 'w-4',
                )}
                style={{
                  left: `${timeToPercent(time)}%`,
                  transform: 'translateX(-50%)',
                }}
                onMouseDown={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  if (selectedTimeRange) {
                    setDraggingRangeHandle(hasAreaRange && index === 0 ? 'start' : 'end')
                  }
                }}
                aria-label={hasAreaRange && index === 0 ? 'Adjust range start' : 'Adjust range end'}
              >
                {hasAreaRange ? <>
                  <span className="absolute inset-y-0 left-1/2 w-[3px] -translate-x-1/2 rounded-sm bg-white shadow-sm" />
                  <span
                    className={cn(
                      "absolute top-0 h-1.5 w-1.5 border-t-2 border-amber-400",
                      index === 0 ? "left-0 border-l-2" : "right-0 border-r-2",
                    )}
                  />
                  <span
                    className={cn(
                      "absolute bottom-0 h-1.5 w-1.5 border-b-2 border-amber-400",
                      index === 0 ? "left-0 border-l-2" : "right-0 border-r-2",
                    )}
                  />
                </> : <>
                  <span className="absolute inset-y-0 left-1 w-[3px] rounded-sm bg-white shadow-sm" />
                  <span className="absolute inset-y-0 right-1 w-[3px] rounded-sm bg-white shadow-sm" />
                  <span className="absolute left-0 top-0 h-1.5 w-1.5 border-l-2 border-t-2 border-amber-400" />
                  <span className="absolute bottom-0 left-0 h-1.5 w-1.5 border-b-2 border-l-2 border-amber-400" />
                  <span className="absolute right-0 top-0 h-1.5 w-1.5 border-r-2 border-t-2 border-amber-400" />
                  <span className="absolute bottom-0 right-0 h-1.5 w-1.5 border-b-2 border-r-2 border-amber-400" />
                </>}
              </button>
            ))}
            {selectedTimeRange && (
              <button
                type="button"
                className="absolute top-0.5 z-[2] flex h-4 w-4 items-center justify-center rounded-full bg-text-tertiary text-bg-primary hover:bg-text-secondary"
                style={{ left: `${timeToPercent(selectedTimeRange.end)}%`, transform: 'translateX(10px)' }}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={() => setSelectedTimeRange(null)}
                aria-label="Clear selected range"
                title="Clear selected range"
              >
                <X className="h-3.5 w-3.5" strokeWidth={2.5} />
              </button>
            )}
          </>}
          {rangeMarkers.map((c) => {
            if (c.timecode_start === null || c.timecode_end === null) return null
            const left = timeToPercent(c.timecode_start)
            const right = timeToPercent(c.timecode_end)
            const authorName = c.author?.name ?? c.guest_author?.name ?? 'Unknown'
            const color = getAvatarColor(authorName)
            const isHovered = hoveredCommentId === c.id

            return (
              <CommentMarker
                key={c.id}
                comment={c}
                commentNumber={commentNumbers.get(c.id)}
                leftPercent={left}
                rightPercent={right}
                authorName={authorName}
                color={color}
                isHovered={isHovered}
                isFocused={focusedCommentId === c.id}
                onHover={() => setHoveredCommentId(c.id)}
                onLeave={() => setHoveredCommentId(null)}
                onSeek={onSeek}
              />
            )
          })}
          {pointMarkers.map((c) => {
            if (c.timecode_start === null) return null
            const left = timeToPercent(c.timecode_start)
            const authorName = c.author?.name ?? c.guest_author?.name ?? 'Unknown'
            const color = getAvatarColor(authorName)
            const isHovered = hoveredCommentId === c.id

            return (
              <CommentMarker
                key={c.id}
                comment={c}
                commentNumber={commentNumbers.get(c.id)}
                leftPercent={left}
                authorName={authorName}
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
          data-testid="progress-bar-hover-tooltip"
          className="absolute -top-2 z-30 pointer-events-none"
          style={{ left: hoverX, transform: 'translateX(-50%) translateY(-100%)' }}
        >
          {/* Frame preview */}
          {previewImage && (
            <div className="mb-1 w-40 rounded-md overflow-hidden border border-white/15 shadow-2xl">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={previewImage} alt="" className="w-full object-contain bg-black" />
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
