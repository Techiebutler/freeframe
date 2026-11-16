'use client'

import * as React from 'react'
import { Maximize2, Pause, Play, Volume2, VolumeX } from 'lucide-react'
import { timecode } from '@/lib/platform'

/** The bar fades out after this long without the pointer while the video plays. */
export const HIDE_MS = 2500

const videoIn = (root: React.RefObject<HTMLElement | null>) => root.current?.querySelector('video') ?? null

/** Space = play/pause, arrows = seek 1 s. Never while the user is on a button, field or link of their own. */
export function embedKey(e: React.KeyboardEvent, video: HTMLVideoElement | null) {
  if (!video) return
  const t = e.target as HTMLElement
  if (t.closest('button, input, textarea, a, [role="slider"], [role="button"]')) return
  if (e.key === ' ') { e.preventDefault(); if (video.paused) void video.play().catch(() => {}); else video.pause() }
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); video.currentTime = Math.min(video.duration || Infinity, Math.max(0, video.currentTime + (e.key === 'ArrowRight' ? 1 : -1))) }
}

/**
 * The embed player's control bar (Review Player v5): a floating glass bar over the bottom of the video.
 * Thin track with blue progress and a knob that grows on hover, comment markers as dots, mono time, play/pause, mute, fullscreen.
 * Fades out while the video plays and the pointer is idle; always shown when paused. Two rows when the video is narrow (container query).
 */
export function EmbedBar({ root, area, playing, time, markers }: { root: React.RefObject<HTMLElement | null>; area: React.RefObject<HTMLElement | null>; playing: boolean; time: number; markers: number[] }) {
  const [duration, setDuration] = React.useState(0)
  const [muted, setMuted] = React.useState(false)
  const [drag, setDrag] = React.useState<number | null>(null)
  const [idle, setIdle] = React.useState(false)
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  React.useEffect(() => {
    const el = root.current
    if (!el) return
    const sync = (e: Event) => {
      if (!(e.target instanceof HTMLVideoElement)) return
      if (Number.isFinite(e.target.duration)) setDuration(e.target.duration)
      setMuted(e.target.muted)
    }
    const events = ['loadedmetadata', 'durationchange', 'volumechange'] as const
    events.forEach(ev => el.addEventListener(ev, sync, true))
    const v = videoIn(root)
    if (v) { if (Number.isFinite(v.duration)) setDuration(v.duration); setMuted(v.muted) }
    return () => events.forEach(ev => el.removeEventListener(ev, sync, true))
  }, [root])

  // Idle: the pointer (or a touch) on the video brings the bar back, 2.5 s later it fades again while playing.
  const wake = React.useCallback(() => {
    setIdle(false)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setIdle(true), HIDE_MS)
  }, [])
  React.useEffect(() => {
    const el = area.current
    if (!el) return
    el.addEventListener('pointermove', wake)
    el.addEventListener('pointerdown', wake)
    return () => { el.removeEventListener('pointermove', wake); el.removeEventListener('pointerdown', wake); if (timer.current) clearTimeout(timer.current) }
  }, [area, wake])
  React.useEffect(() => { if (playing) wake(); else { setIdle(false); if (timer.current) clearTimeout(timer.current) } }, [playing, wake])
  const hidden = playing && idle

  const frac = duration > 0 ? Math.min(1, Math.max(0, drag ?? time / duration)) : 0
  const seek = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const f = r.width > 0 ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : 0
    setDrag(f)
    const v = videoIn(root)
    if (v && duration > 0) v.currentTime = f * duration
  }
  const step = (e: React.KeyboardEvent) => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    const v = videoIn(root)
    if (!d || !v) return
    e.preventDefault(); e.stopPropagation()
    v.currentTime = Math.min(duration, Math.max(0, v.currentTime + d))
  }
  const toggle = () => { const v = videoIn(root); if (!v) return; if (v.paused) void v.play().catch(() => {}); else v.pause() }
  const mute = () => { const v = videoIn(root); if (v) { v.muted = !v.muted; setMuted(v.muted) } }
  const fullscreen = () => {
    const el = area.current as (HTMLElement & { webkitRequestFullscreen?: () => void }) | null
    const v = videoIn(root) as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null
    if (document.fullscreenElement) { void document.exitFullscreen(); return }
    if (el?.requestFullscreen) void el.requestFullscreen().catch(() => v?.webkitEnterFullscreen?.())
    else if (el?.webkitRequestFullscreen) el.webkitRequestFullscreen()
    else v?.webkitEnterFullscreen?.()
  }

  return (
    <div className="ep-bar" data-hidden={hidden ? '' : undefined} data-testid="embed-bar" onFocus={wake}>
      <button type="button" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'} className="ep-ib ep-play">{playing ? <Pause size={20} fill="currentColor" aria-hidden="true" /> : <Play size={20} fill="currentColor" aria-hidden="true" />}</button>
      <span className="ep-time">{timecode(drag !== null ? drag * duration : time)} <b>/ {timecode(duration)}</b></span>
      <div
        className="ep-trk" role="slider" tabIndex={0} aria-label="Seek" aria-valuemin={0} aria-valuemax={Math.round(duration)} aria-valuenow={Math.round(frac * duration)} aria-valuetext={`${timecode(frac * duration)} of ${timecode(duration)}`}
        onPointerDown={e => { if (e.pointerType === 'mouse' && e.button !== 0) return; try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* pointer already gone */ } seek(e) }}
        onPointerMove={e => { if (drag !== null) seek(e) }}
        onPointerUp={() => setDrag(null)} onPointerCancel={() => setDrag(null)} onKeyDown={step}
      >
        <span className="ep-rail" />
        <span className="ep-fill" style={{ width: `${frac * 100}%` }} />
        {duration > 0 && markers.map((t, i) => <i key={i} className="ep-mk" style={{ left: `${Math.min(100, (t / duration) * 100)}%` }} />)}
        <span className="ep-knob" style={{ left: `${frac * 100}%` }} />
      </div>
      <button type="button" onClick={mute} aria-label={muted ? 'Unmute' : 'Mute'} aria-pressed={muted} className="ep-ib ep-mute">{muted ? <VolumeX size={20} aria-hidden="true" /> : <Volume2 size={20} aria-hidden="true" />}</button>
      <button type="button" onClick={fullscreen} aria-label="Fullscreen" className="ep-ib ep-fs"><Maximize2 size={20} aria-hidden="true" /></button>
    </div>
  )
}
