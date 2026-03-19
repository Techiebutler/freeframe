'use client'

import * as React from 'react'
import WaveSurfer from 'wavesurfer.js'
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Loader2,
} from 'lucide-react'
import { cn, formatTime } from '@/lib/utils'
import { api } from '@/lib/api'
import { useReviewStore } from '@/stores/review-store'
import type { Asset, AssetVersion, Comment } from '@/types'

// ─── Types ────────────────────────────────────────────────────────────────────

interface StreamResponse {
  url: string
}

// ─── Speed options ────────────────────────────────────────────────────────────

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const

// ─── Comment Markers ──────────────────────────────────────────────────────────

interface CommentMarkersProps {
  comments: Comment[]
  duration: number
  onMarkerClick: (time: number) => void
}

function CommentMarkers({ comments, duration, onMarkerClick }: CommentMarkersProps) {
  if (duration <= 0) return null

  const markers = comments.filter(
    (c) => c.timecode_start != null && !c.resolved && !c.deleted_at,
  )

  return (
    <>
      {markers.map((comment) => {
        const pct = ((comment.timecode_start ?? 0) / duration) * 100
        return (
          <button
            key={comment.id}
            onClick={() => onMarkerClick(comment.timecode_start ?? 0)}
            title={comment.body.slice(0, 80)}
            className="absolute top-0 z-10 h-full w-0.5 translate-x-[-50%] cursor-pointer bg-accent/80 transition-opacity hover:opacity-100 opacity-70"
            style={{ left: `${pct}%` }}
          />
        )
      })}
    </>
  )
}

// ─── Volume Slider ─────────────────────────────────────────────────────────────

interface VolumeSliderProps {
  volume: number
  muted: boolean
  onVolumeChange: (v: number) => void
  onToggleMute: () => void
}

function VolumeControl({ volume, muted, onVolumeChange, onToggleMute }: VolumeSliderProps) {
  return (
    <div className="flex items-center gap-1.5">
      <button
        onClick={onToggleMute}
        className="flex h-7 w-7 items-center justify-center rounded text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
        title={muted ? 'Unmute' : 'Mute'}
      >
        {muted || volume === 0 ? (
          <VolumeX className="h-4 w-4" />
        ) : (
          <Volume2 className="h-4 w-4" />
        )}
      </button>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={muted ? 0 : volume}
        onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
        className="h-1 w-20 cursor-pointer appearance-none rounded-full bg-bg-hover accent-accent"
        title="Volume"
      />
    </div>
  )
}

// ─── Main Component ────────────────────────────────────────────────────────────

interface AudioPlayerProps {
  asset: Asset
  version: AssetVersion | null
  comments?: Comment[]
  className?: string
}

export function AudioPlayer({ asset, version, comments = [], className }: AudioPlayerProps) {
  const { setPlayheadTime } = useReviewStore()

  const waveformRef = React.useRef<HTMLDivElement>(null)
  const wavesurferRef = React.useRef<WaveSurfer | null>(null)

  const [isReady, setIsReady] = React.useState(false)
  const [isPlaying, setIsPlaying] = React.useState(false)
  const [isLoading, setIsLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [currentTime, setCurrentTime] = React.useState(0)
  const [duration, setDuration] = React.useState(0)
  const [volume, setVolume] = React.useState(0.8)
  const [muted, setMuted] = React.useState(false)
  const [speed, setSpeed] = React.useState<number>(1)
  const [audioUrl, setAudioUrl] = React.useState<string | null>(null)

  // ── Fetch presigned URL ──────────────────────────────────────────────────────
  React.useEffect(() => {
    if (!version) return
    let cancelled = false

    const fetchUrl = async () => {
      setIsLoading(true)
      setError(null)
      setIsReady(false)
      setIsPlaying(false)
      setCurrentTime(0)
      setDuration(0)

      try {
        const data = await api.get<StreamResponse>(`/assets/${asset.id}/stream`)
        if (!cancelled) setAudioUrl(data.url)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load audio')
          setIsLoading(false)
        }
      }
    }

    fetchUrl()
    return () => {
      cancelled = true
    }
  }, [asset.id, version])

  // ── Initialize WaveSurfer ────────────────────────────────────────────────────
  React.useEffect(() => {
    if (!audioUrl || !waveformRef.current) return

    // Destroy existing instance
    if (wavesurferRef.current) {
      wavesurferRef.current.destroy()
      wavesurferRef.current = null
    }

    const ws = WaveSurfer.create({
      container: waveformRef.current,
      height: 128,
      waveColor: 'oklch(0.48 0.008 250)',    // --text-tertiary
      progressColor: 'oklch(0.62 0.16 240)', // --accent
      cursorColor: 'oklch(0.62 0.16 240)',
      cursorWidth: 2,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      normalize: true,
      interact: true,
      hideScrollbar: true,
    })

    wavesurferRef.current = ws

    ws.on('ready', () => {
      setIsReady(true)
      setIsLoading(false)
      setDuration(ws.getDuration())
      ws.setVolume(volume)
      ws.setPlaybackRate(speed)
    })

    ws.on('audioprocess', (time: number) => {
      setCurrentTime(time)
      setPlayheadTime(time)
    })

    ws.on('seeking', (time: number) => {
      setCurrentTime(time)
      setPlayheadTime(time)
    })

    ws.on('play', () => setIsPlaying(true))
    ws.on('pause', () => setIsPlaying(false))
    ws.on('finish', () => {
      setIsPlaying(false)
      setCurrentTime(ws.getDuration())
    })

    ws.on('error', (err: Error) => {
      setError(err?.message ?? 'Waveform error')
      setIsLoading(false)
    })

    ws.load(audioUrl)

    return () => {
      ws.destroy()
      wavesurferRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioUrl])

  // ── Sync volume/speed/mute changes to WaveSurfer ────────────────────────────
  React.useEffect(() => {
    wavesurferRef.current?.setVolume(muted ? 0 : volume)
  }, [volume, muted])

  React.useEffect(() => {
    wavesurferRef.current?.setPlaybackRate(speed)
  }, [speed])

  // ── Keyboard shortcut: space = play/pause ────────────────────────────────────
  React.useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.code === 'Space') {
        e.preventDefault()
        wavesurferRef.current?.playPause()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [])

  // ── Controls ─────────────────────────────────────────────────────────────────

  const handlePlayPause = () => {
    wavesurferRef.current?.playPause()
  }

  const handleVolumeChange = (v: number) => {
    setMuted(false)
    setVolume(v)
  }

  const handleToggleMute = () => {
    setMuted((m) => !m)
  }

  const handleMarkerClick = (time: number) => {
    wavesurferRef.current?.seekTo(duration > 0 ? time / duration : 0)
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div
      className={cn(
        'flex flex-col gap-3 rounded-lg border border-border bg-bg-secondary p-4',
        className,
      )}
    >
      {/* Track info */}
      <div className="flex items-center justify-between">
        <p className="truncate text-sm font-medium text-text-primary">{asset.name}</p>
        {isLoading && <Loader2 className="h-4 w-4 animate-spin text-text-tertiary" />}
      </div>

      {/* Error state */}
      {error && (
        <div className="rounded bg-status-error/10 px-3 py-2 text-sm text-status-error">
          {error}
        </div>
      )}

      {/* Waveform container */}
      <div className="relative">
        {/* Skeleton while loading */}
        {isLoading && !error && (
          <div className="h-32 w-full animate-pulse rounded bg-bg-tertiary" />
        )}

        {/* WaveSurfer mount point — always in DOM so ref is valid */}
        <div
          ref={waveformRef}
          className={cn(
            'relative w-full rounded overflow-hidden',
            isLoading ? 'invisible h-0' : 'visible',
          )}
        >
          {/* Comment markers overlay */}
          {isReady && (
            <CommentMarkers
              comments={comments}
              duration={duration}
              onMarkerClick={handleMarkerClick}
            />
          )}
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3">
        {/* Play / Pause */}
        <button
          onClick={handlePlayPause}
          disabled={!isReady}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-text-inverse transition-colors hover:bg-accent-hover disabled:opacity-50"
          title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
        >
          {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 translate-x-px" />}
        </button>

        {/* Timecode */}
        <span className="min-w-[72px] text-xs tabular-nums text-text-secondary">
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Volume */}
        <VolumeControl
          volume={volume}
          muted={muted}
          onVolumeChange={handleVolumeChange}
          onToggleMute={handleToggleMute}
        />

        {/* Speed selector */}
        <select
          value={speed}
          onChange={(e) => setSpeed(parseFloat(e.target.value))}
          disabled={!isReady}
          className="h-7 cursor-pointer rounded border border-border bg-bg-elevated px-1.5 text-xs text-text-secondary transition-colors hover:border-border-focus focus:outline-none focus:ring-1 focus:ring-border-focus disabled:opacity-50"
          title="Playback speed"
        >
          {SPEED_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s}x
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}
