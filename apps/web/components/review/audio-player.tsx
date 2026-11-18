'use client'

import * as React from 'react'
import WaveSurfer from 'wavesurfer.js'
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Loader2,
  Repeat,
  ChevronUp,
  Check,
} from 'lucide-react'
import { cn, formatTime, formatTimecode, formatFrames } from '@/lib/utils'
import { api } from '@/lib/api'
import { useReviewStore, type TimeFormat } from '@/stores/review-store'
import { useReview } from '@/components/review/review-provider'
import { ProgressBar } from './progress-bar'
import type { Asset, AssetVersion, Comment } from '@/types'

interface StreamResponse {
  url: string
}

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const

// ─── Main Component ──────────────────────────────────────────────────────────

interface AudioPlayerProps {
  asset: Asset
  version: AssetVersion | null
  comments?: Comment[]
  className?: string
}

export function AudioPlayer({ asset, version, comments = [], className }: AudioPlayerProps) {
  const { setPlayheadTime, seekTarget, timeFormat, setTimeFormat } = useReviewStore()
  const [timeFormatOpen, setTimeFormatOpen] = React.useState(false)
  const timeFormatRef = React.useRef<HTMLDivElement>(null)

  // Close time format dropdown on outside click
  React.useEffect(() => {
    if (!timeFormatOpen) return
    const handleClick = (e: MouseEvent) => {
      if (timeFormatRef.current && !timeFormatRef.current.contains(e.target as Node)) setTimeFormatOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [timeFormatOpen])

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
  const [loop, setLoop] = React.useState(false)
  const [audioUrl, setAudioUrl] = React.useState<string | null>(null)

  // Access share context for share-mode stream fetching
  let shareToken: string | undefined
  let shareSession: string | null | undefined
  try {
    const review = useReview()
    shareToken = review.shareToken
    shareSession = review.shareSession
  } catch {
    // Not inside ReviewProvider — normal mode
  }

  // Fetch presigned URL
  React.useEffect(() => {
    if (!version) return

    // In share mode, fetch via share endpoint
    if (shareToken) {
      let cancelled = false
      setIsLoading(true)
      setError(null)
      const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'
      const sp = shareSession ? `&share_session=${encodeURIComponent(shareSession)}` : ''
      fetch(`${API_URL}/share/${shareToken}/stream/${asset.id}?version_id=${version.id}${sp}`)
        .then(res => res.ok ? res.json() : Promise.reject(new Error('Failed to load audio')))
        .then(data => { if (!cancelled) setAudioUrl(data.url) })
        .catch(err => { if (!cancelled) { setError(err.message); setIsLoading(false) } })
      return () => { cancelled = true }
    }

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
    return () => { cancelled = true }
  }, [asset.id, shareToken, version])

  // Initialize WaveSurfer
  React.useEffect(() => {
    if (!audioUrl || !waveformRef.current) return

    if (wavesurferRef.current) {
      wavesurferRef.current.destroy()
      wavesurferRef.current = null
    }

    const cssVars = getComputedStyle(document.documentElement)
    const waveColor = cssVars.getPropertyValue('--text-tertiary').trim() || '#5e5e6e'
    const accentColor = cssVars.getPropertyValue('--accent').trim() || '#5b8def'

    const ws = WaveSurfer.create({
      container: waveformRef.current,
      height: 160,
      waveColor,
      progressColor: accentColor,
      cursorColor: accentColor,
      cursorWidth: 2,
      barWidth: 3,
      barGap: 2,
      barRadius: 3,
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
      if (loop) {
        ws.seekTo(0)
        ws.play()
      }
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

  // React to external seek requests (e.g. clicking comment timecode)
  React.useEffect(() => {
    if (!seekTarget || !wavesurferRef.current || duration <= 0) return
    const clamped = Math.max(0, Math.min(seekTarget.time, duration))
    wavesurferRef.current.seekTo(clamped / duration)
    setCurrentTime(clamped)
  }, [seekTarget, duration])

  // Sync volume/speed
  React.useEffect(() => {
    wavesurferRef.current?.setVolume(muted ? 0 : volume)
  }, [volume, muted])

  React.useEffect(() => {
    wavesurferRef.current?.setPlaybackRate(speed)
  }, [speed])

  // Keyboard: space = play/pause
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

  const handlePlayPause = () => wavesurferRef.current?.playPause()

  const handleSeek = (time: number) => {
    if (!wavesurferRef.current || duration <= 0) return
    wavesurferRef.current.seekTo(time / duration)
  }

  function displayTime(t: number): string {
    switch (timeFormat) {
      case 'frames': return formatFrames(t)
      case 'standard': return formatTime(t)
      case 'timecode': return formatTimecode(t)
      default: return formatTimecode(t)
    }
  }

  return (
    <div className={cn('flex flex-col h-full w-full', className)}>
      {/* Main waveform area — fills available space */}
      <div className="flex-1 flex items-center justify-center bg-bg-primary relative">
        {/* Loading */}
        {isLoading && !error && (
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="h-8 w-8 animate-spin text-text-tertiary" />
            <span className="text-xs text-text-tertiary">Loading waveform...</span>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="flex flex-col items-center gap-2">
            <span className="text-sm text-status-warning">{error}</span>
          </div>
        )}

        {/* WaveSurfer waveform — centered with max width */}
        <div
          ref={waveformRef}
          className={cn(
            'w-full max-w-3xl mx-auto px-8',
            isLoading ? 'invisible h-0' : 'visible',
          )}
        />
      </div>

      {/* Timeline scrubber with comment markers */}
      <div className="shrink-0 bg-bg-primary">
        <ProgressBar
          currentTime={currentTime}
          duration={duration}
          comments={comments}
          onSeek={handleSeek}
        />
      </div>

      {/* Bottom transport bar */}
      <div className="flex items-center justify-between h-12 px-4 bg-bg-secondary/80 border-t border-border shrink-0">
        {/* Left: Play, Loop, Speed, Volume */}
        <div className="flex items-center gap-2">
          <button
            onClick={handlePlayPause}
            disabled={!isReady}
            className="flex h-7 w-7 items-center justify-center rounded text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-40"
            title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
          >
            {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </button>

          <button
            onClick={() => setLoop(!loop)}
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded transition-colors',
              loop ? 'text-accent bg-accent/10' : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover',
            )}
            title="Loop"
          >
            <Repeat className="h-4 w-4" />
          </button>

          <button
            onClick={() => {
              const idx = SPEED_OPTIONS.indexOf(speed as typeof SPEED_OPTIONS[number])
              const next = SPEED_OPTIONS[(idx + 1) % SPEED_OPTIONS.length]
              setSpeed(next)
            }}
            disabled={!isReady}
            className="flex h-7 items-center justify-center rounded px-1.5 text-xs font-medium text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors tabular-nums disabled:opacity-40"
            title="Playback speed"
          >
            {speed}x
          </button>

          <button
            onClick={() => setMuted(!muted)}
            className="flex h-7 w-7 items-center justify-center rounded text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors"
            title={muted ? 'Unmute' : 'Mute'}
          >
            {muted || volume === 0 ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
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
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 slide-in-from-left-1/2 mb-2 z-50 w-48 rounded-xl border border-white/10 bg-[#2a2a30] shadow-2xl py-1.5 animate-in fade-in zoom-in-95 duration-100">
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

        {/* Right: spacer for symmetry */}
        <div className="w-[140px]" />
      </div>
    </div>
  )
}
