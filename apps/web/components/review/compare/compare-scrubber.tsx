'use client'

import * as React from 'react'
import { Pause, Play } from 'lucide-react'
import { cn, formatTimecode } from '@/lib/utils'
import { frameStep, markerPosition, type SideTiming } from '@/lib/compare-time'

export interface ScrubberMarker { id: string; tc: number }

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
  onMarkerClick(side: 'a' | 'b', tc: number): void
  onOffsetChange(side: 'a' | 'b', value: number): void
}

function OffsetStepper({ side, offset, fps, onOffsetChange }: {
  side: 'a' | 'b'; offset: number; fps?: number | null
  onOffsetChange(side: 'a' | 'b', value: number): void
}) {
  const f = frameStep(fps)
  const nudge = (delta: number) => onOffsetChange(side, Math.max(0, Number((offset + delta).toFixed(3))))
  const btn = 'rounded border border-border px-1 text-[10px] text-text-tertiary hover:bg-bg-hover'
  return (
    <div className="flex items-center gap-1 text-[11px] text-text-tertiary">
      <span className={side === 'a' ? 'text-sky-400' : 'text-emerald-400'}>{side.toUpperCase()}</span>
      <button type="button" data-testid={`off${side.toUpperCase()}-minus-second`} className={btn} onClick={() => nudge(-1)}>−1s</button>
      <button type="button" data-testid={`off${side.toUpperCase()}-minus-frame`} className={btn} onClick={() => nudge(-f)}>−1f</button>
      <span className="w-12 text-center tabular-nums">{offset.toFixed(2)}s</span>
      <button type="button" data-testid={`off${side.toUpperCase()}-plus-frame`} className={btn} onClick={() => nudge(f)}>+1f</button>
      <button type="button" data-testid={`off${side.toUpperCase()}-plus-second`} className={btn} onClick={() => nudge(1)}>+1s</button>
    </div>
  )
}

export function CompareScrubber(props: CompareScrubberProps) {
  const { t, total, isPlaying, fps, onToggle, onSeek, markersA, markersB, timingA, timingB, onMarkerClick, onOffsetChange } = props
  const trackRef = React.useRef<HTMLDivElement>(null)

  const seekFromEvent = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return
    const seekTime = ((clientX - rect.left) / rect.width) * total
    onSeek(Math.round(seekTime * 100) / 100)
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

      <div className="relative flex-1 py-3">
        {/* A markers above the track */}
        {markersA.map((m) => (
          <button
            key={m.id}
            data-testid={`marker-a-${m.id}`}
            type="button"
            onClick={() => onMarkerClick('a', m.tc)}
            className="absolute -top-0.5 h-2 w-2 -translate-x-1/2 rounded-full bg-sky-400"
            style={{ left: `${markerPosition(m.tc, timingA, total) * 100}%` }}
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
          <button
            key={m.id}
            data-testid={`marker-b-${m.id}`}
            type="button"
            onClick={() => onMarkerClick('b', m.tc)}
            className="absolute -bottom-0.5 h-2 w-2 -translate-x-1/2 rounded-full bg-emerald-400"
            style={{ left: `${markerPosition(m.tc, timingB, total) * 100}%` }}
          />
        ))}
      </div>

      <span className="font-mono text-[12px] tabular-nums text-text-secondary">{formatTimecode(t, fps ?? 24)}</span>

      <div className={cn('flex flex-col gap-1')}>
        <OffsetStepper side="a" offset={timingA.offset} fps={fps} onOffsetChange={onOffsetChange} />
        <OffsetStepper side="b" offset={timingB.offset} fps={fps} onOffsetChange={onOffsetChange} />
      </div>
    </div>
  )
}
