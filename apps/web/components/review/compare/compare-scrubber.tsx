'use client'

import * as React from 'react'
import { createPortal } from 'react-dom'
import { Pause, Play, RotateCcw } from 'lucide-react'
import { cn, formatTimecode } from '@/lib/utils'
import { frameStep, markerPosition, type SideTiming } from '@/lib/compare-time'
import { getAvatarColor, getInitials } from '@/components/review/progress-bar'

export interface ScrubberMarker {
  id: string
  tc: number
  authorName: string
  body: string
  hasAnnotation: boolean
}

interface CompareScrubberProps {
  t: number
  total: number
  isPlaying: boolean
  fps?: number | null
  onToggle(): void
  onSeek(t: number): void
  markersA: ScrubberMarker[]
  markersB: ScrubberMarker[]
  timingA: SideTiming
  timingB: SideTiming
  onMarkerClick(side: 'a' | 'b', marker: ScrubberMarker): void
  onOffsetChange(side: 'a' | 'b', value: number): void
  /** Version labels for the offset rows (e.g. "v1" / "v2"), shown instead of A/B. */
  labelA: string
  labelB: string
  /** Reset both per-side offsets back to 0 (re-sync the two sides). */
  onResetOffsets(): void
}

// ─── Marker dot + hover preview (mirrors progress-bar.tsx's CommentMarker) ────

interface HoveredMarker { side: 'a' | 'b'; id: string }

function ScrubberCommentMarker({
  marker,
  side,
  leftPercent,
  fps,
  isHovered,
  onHover,
  onLeave,
  onClick,
}: {
  marker: ScrubberMarker
  side: 'a' | 'b'
  leftPercent: number
  fps?: number | null
  isHovered: boolean
  onHover: () => void
  onLeave: () => void
  onClick: () => void
}) {
  const markerRef = React.useRef<HTMLDivElement>(null)
  const [tooltipPos, setTooltipPos] = React.useState<{ left: number; top: number } | null>(null)
  const initials = getInitials(marker.authorName)
  const color = getAvatarColor(marker.authorName)

  // Recalculate tooltip position when hovered to avoid viewport clipping.
  // BOTH sides open upward: the scrubber sits flush against the viewport
  // bottom, so a downward tooltip would land entirely off-screen. Opening
  // upward puts the B tooltip above the scrubber, over the video area.
  React.useEffect(() => {
    if (!isHovered || !markerRef.current) {
      setTooltipPos(null)
      return
    }
    const rect = markerRef.current.getBoundingClientRect()
    const tooltipWidth = 240
    let left = rect.left + rect.width / 2 - tooltipWidth / 2
    if (left < 8) left = 8
    if (left + tooltipWidth > window.innerWidth - 8) left = window.innerWidth - 8 - tooltipWidth
    const top = Math.max(8, rect.top - 8)
    setTooltipPos({ left, top })
  }, [isHovered])

  return (
    <div
      ref={markerRef}
      data-testid={`marker-${side}-${marker.id}`}
      className={cn('absolute -translate-x-1/2 cursor-pointer', side === 'a' ? 'top-0' : 'bottom-0')}
      style={{ left: `${leftPercent}%` }}
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      onClick={onClick}
    >
      {/* Avatar dot */}
      <div
        className="flex h-5 w-5 items-center justify-center rounded-full border-2 border-bg-primary text-[9px] font-bold text-white shadow-md transition-transform hover:scale-110"
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
              <span className="text-xs font-medium text-white truncate">{marker.authorName}</span>
              <span className="ml-auto text-[10px] font-mono text-indigo-400 bg-indigo-500/10 px-1.5 py-0.5 rounded">
                {formatTimecode(marker.tc, fps ?? 24)}
              </span>
            </div>
            <p className="text-xs text-text-secondary line-clamp-2 leading-relaxed">
              {marker.body}
            </p>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}

function OffsetStepper({ side, label, offset, fps, onOffsetChange }: {
  side: 'a' | 'b'; label: string; offset: number; fps?: number | null
  onOffsetChange(side: 'a' | 'b', value: number): void
}) {
  const f = frameStep(fps)
  const nudge = (delta: number) => onOffsetChange(side, Math.max(0, Number((offset + delta).toFixed(3))))
  const btn = 'rounded border border-border px-1 text-[10px] text-text-tertiary hover:bg-bg-hover'
  return (
    <div className="flex items-center gap-1 text-[11px] text-text-tertiary">
      <span className={cn('min-w-[1.75rem] text-right font-medium tabular-nums', side === 'a' ? 'text-sky-400' : 'text-emerald-400')}>{label}</span>
      <button type="button" data-testid={`off${side.toUpperCase()}-minus-second`} className={btn} onClick={() => nudge(-1)}>−1s</button>
      <button type="button" data-testid={`off${side.toUpperCase()}-minus-frame`} className={btn} onClick={() => nudge(-f)}>−1f</button>
      <span className="w-12 text-center tabular-nums">{offset.toFixed(2)}s</span>
      <button type="button" data-testid={`off${side.toUpperCase()}-plus-frame`} className={btn} onClick={() => nudge(f)}>+1f</button>
      <button type="button" data-testid={`off${side.toUpperCase()}-plus-second`} className={btn} onClick={() => nudge(1)}>+1s</button>
    </div>
  )
}

export function CompareScrubber(props: CompareScrubberProps) {
  const { t, total, isPlaying, fps, onToggle, onSeek, markersA, markersB, timingA, timingB, onMarkerClick, onOffsetChange, labelA, labelB, onResetOffsets } = props
  const trackRef = React.useRef<HTMLDivElement>(null)
  const [hovered, setHovered] = React.useState<HoveredMarker | null>(null)

  const seekFromEvent = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return
    onSeek(((clientX - rect.left) / rect.width) * total)
  }

  return (
    <div className="flex items-center gap-4 border-t border-border bg-bg-primary px-4 py-2">
      <button
        type="button"
        onClick={onToggle}
        aria-label={isPlaying ? 'Pause' : 'Play'}
        className="flex h-8 w-8 items-center justify-center rounded-md text-text-secondary hover:bg-bg-hover hover:text-text-primary"
      >
        {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
      </button>

      <div className="relative flex-1 py-6">
        {/* A markers above the track */}
        {markersA.map((m) => (
          <ScrubberCommentMarker
            key={m.id}
            marker={m}
            side="a"
            fps={fps}
            leftPercent={markerPosition(m.tc, timingA, total) * 100}
            isHovered={hovered?.side === 'a' && hovered.id === m.id}
            onHover={() => setHovered({ side: 'a', id: m.id })}
            onLeave={() => setHovered(null)}
            onClick={() => onMarkerClick('a', m)}
          />
        ))}
        <div
          ref={trackRef}
          data-testid="compare-track"
          onClick={(e) => seekFromEvent(e.clientX)}
          className="relative h-2 cursor-pointer rounded-full bg-bg-tertiary"
        >
          <div className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${total > 0 ? (t / total) * 100 : 0}%` }} />
        </div>
        {/* B markers below the track */}
        {markersB.map((m) => (
          <ScrubberCommentMarker
            key={m.id}
            marker={m}
            side="b"
            fps={fps}
            leftPercent={markerPosition(m.tc, timingB, total) * 100}
            isHovered={hovered?.side === 'b' && hovered.id === m.id}
            onHover={() => setHovered({ side: 'b', id: m.id })}
            onLeave={() => setHovered(null)}
            onClick={() => onMarkerClick('b', m)}
          />
        ))}
      </div>

      <span className="font-mono text-[12px] tabular-nums text-text-secondary">{formatTimecode(t, fps ?? 24)}</span>

      <div className="flex items-center gap-2">
        <div className="flex flex-col gap-1">
          <OffsetStepper side="a" label={labelA} offset={timingA.offset} fps={fps} onOffsetChange={onOffsetChange} />
          <OffsetStepper side="b" label={labelB} offset={timingB.offset} fps={fps} onOffsetChange={onOffsetChange} />
        </div>
        <button
          type="button"
          data-testid="offset-reset"
          onClick={onResetOffsets}
          disabled={timingA.offset === 0 && timingB.offset === 0}
          title="Reset offsets — re-sync both sides"
          aria-label="Reset offsets"
          className="flex items-center gap-1 rounded border border-border px-1.5 py-1 text-[10px] text-text-tertiary hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-30"
        >
          <RotateCcw className="h-3 w-3" />
          Sync
        </button>
      </div>
    </div>
  )
}
