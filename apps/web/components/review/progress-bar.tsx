'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { formatTime } from '@/lib/utils'
import type { Comment } from '@/types'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ProgressBarProps {
  currentTime: number
  duration: number
  buffered?: number
  comments?: Comment[]
  onSeek: (time: number) => void
  className?: string
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ProgressBar({
  currentTime,
  duration,
  buffered = 0,
  comments = [],
  onSeek,
  className,
}: ProgressBarProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [hoverTime, setHoverTime] = useState<number | null>(null)
  const [hoverX, setHoverX] = useState(0)

  // Convert time to percentage position along the bar
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
    },
    [isDragging, getTimeFromEvent, onSeek],
  )

  const handleMouseLeave = useCallback(() => {
    if (!isDragging) setHoverTime(null)
  }, [isDragging])

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
      onSeek(getTimeFromEvent(e.clientX))
    }

    window.addEventListener('mousemove', handleGlobalMouseMove)
    window.addEventListener('mouseup', handleGlobalMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleGlobalMouseMove)
      window.removeEventListener('mouseup', handleGlobalMouseUp)
    }
  }, [isDragging, getTimeFromEvent, onSeek])

  // Separate timecoded comments (point markers) from time-range comments
  const pointMarkers = comments.filter(
    (c) => c.timecode_start !== null && c.timecode_end === null && !c.resolved,
  )
  const rangeMarkers = comments.filter(
    (c) => c.timecode_start !== null && c.timecode_end !== null && !c.resolved,
  )

  const playPercent = timeToPercent(currentTime)
  const bufferedPercent = timeToPercent(buffered)

  return (
    <div className={cn('relative flex items-center w-full group', className)}>
      {/* Track area — taller hit target */}
      <div
        ref={trackRef}
        className="relative w-full h-1 group-hover:h-2 transition-all duration-150 cursor-pointer bg-white/20 rounded-full"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onMouseDown={handleMouseDown}
      >
        {/* Buffered range */}
        <div
          className="absolute inset-y-0 left-0 bg-white/30 rounded-full"
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
          className="absolute inset-y-0 left-0 bg-blue-500 rounded-full"
          style={{ width: `${playPercent}%` }}
        />

        {/* Playhead thumb */}
        <div
          className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-white shadow opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
          style={{ left: `${playPercent}%`, transform: 'translateX(-50%) translateY(-50%)' }}
        />

        {/* Point comment markers */}
        {pointMarkers.map((c) => {
          if (c.timecode_start === null) return null
          const left = timeToPercent(c.timecode_start)
          return (
            <div
              key={c.id}
              className="absolute top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-yellow-400 border border-yellow-600 pointer-events-none"
              style={{ left: `${left}%`, transform: 'translateX(-50%) translateY(-50%)' }}
              title={c.body.slice(0, 60)}
            />
          )
        })}
      </div>

      {/* Hover time tooltip */}
      {hoverTime !== null && (
        <div
          className="absolute -top-7 bg-black/80 text-white text-xs px-1.5 py-0.5 rounded pointer-events-none whitespace-nowrap z-10"
          style={{ left: hoverX, transform: 'translateX(-50%)' }}
        >
          {formatTime(hoverTime)}
        </div>
      )}
    </div>
  )
}
