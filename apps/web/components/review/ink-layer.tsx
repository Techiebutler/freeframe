'use client'

import * as React from 'react'
import { CONTOUR_WIDTH, DOT_PX, classifyMark, normalizePoint, replayDuration, smoothPath, taperChunks, thinPoints, visibleMarks, type InkMark } from '@/lib/ink'

type Ink = { id: number; k: 'stroke' | 'dot'; points: [number, number][] }

/** Fade-out length once playback resumes; CSS holds the same value. */
const FADE_MS = 250

export const Strokes = ({ list, live, fading }: { list: Ink[]; live?: boolean; fading?: boolean }) => (
  <>
    <svg className="ink-svg" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
      {list.filter(m => m.k === 'stroke').map(m => (
        <g key={m.id} className="ink-stroke" data-live={live ? '' : undefined} data-fading={fading ? '' : undefined}>
          {/* one continuous dark contour under every white chunk, so it never shows seams where the width steps */}
          <path className="ink-contour" d={smoothPath(thinPoints(m.points))} style={{ strokeWidth: CONTOUR_WIDTH }} />
          {taperChunks(thinPoints(m.points)).map((c, i) => (
            <path key={i} className="ink-line" d={smoothPath(c.points, c)} style={{ strokeWidth: c.width }} />
          ))}
        </g>
      ))}
    </svg>
    {list.filter(m => m.k === 'dot').map(m => (
      <i key={m.id} className="ink-dot ink-stroke" data-live={live ? '' : undefined} data-fading={fading ? '' : undefined} style={{ left: `${m.points[0][0] * 100}%`, top: `${m.points[0][1] * 100}%` }} />
    ))}
  </>
)

export interface InkReplay { key: number; marks: (Pick<InkMark, 'k' | 'points'> & Partial<Pick<InkMark, 'times' | 'offset_ms'>>)[] }

/**
 * The drawing surface over the picture, mounted inside the video frame (so 0..1 is the picture, never the letterbox).
 * Only while recording does it take the pointer. Drag = stroke, tap = dot. Ink stays on the picture while the video is
 * paused and fades out as soon as it plays again (it is kept in the note, only the screen is cleared).
 * The first touch pauses the video; the recording goes on. A second finger is ignored while the first draws.
 */
export function InkLayer({ active, playing = false, onStart, onMark, replay }: {
  active: boolean
  /** Video is playing: ink stays while it is paused and fades out once it runs again. */
  playing?: boolean
  onStart: () => void
  onMark: (k: 'stroke' | 'dot', points: [number, number][], times: number[]) => void
  replay?: InkReplay | null
}) {
  const root = React.useRef<HTMLDivElement>(null)
  const [cur, setCur] = React.useState<[number, number][] | null>(null)
  const [trail, setTrail] = React.useState<Ink[]>([])
  const g = React.useRef<{ pid: number; pts: [number, number][]; times: number[]; t0: number; x0: number; y0: number; far: number } | null>(null)
  const seq = React.useRef(0)
  const gone = React.useRef(false)
  React.useEffect(() => { gone.current = false; return () => { gone.current = true } }, [])
  React.useEffect(() => { if (!active) { g.current = null; setCur(null) } }, [active])
  const [replayShown, setReplayShown] = React.useState<InkReplay | null>(null)
  const [fading, setFading] = React.useState(false)
  // A replay draws at the speed it was drawn (times are stored per point); reduced motion shows it at once.
  const [replayMs, setReplayMs] = React.useState(Infinity)
  React.useEffect(() => {
    if (!replay) return
    setReplayShown(replay); setFading(false)
    const reduced = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const total = replayDuration(replay.marks)
    if (reduced || total === 0) { setReplayMs(Infinity); return }
    const t0 = Date.now()
    setReplayMs(0)
    const id = setInterval(() => {
      const el = Date.now() - t0
      if (el >= total) { setReplayMs(Infinity); clearInterval(id) } else setReplayMs(el)
    }, 16)
    return () => clearInterval(id)
  }, [replay])
  // Playback resumed (paused -> playing): let everything on screen fade, then clear it. While paused nothing is removed.
  const wasPlaying = React.useRef(playing)
  const shownRef = React.useRef({ trail, replayShown })
  shownRef.current = { trail, replayShown }
  React.useEffect(() => {
    const resumed = playing && !wasPlaying.current
    wasPlaying.current = playing
    if (!resumed || (!shownRef.current.trail.length && !shownRef.current.replayShown)) return
    const reduced = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    setFading(true)
    const id = setTimeout(() => { setTrail([]); setReplayShown(null); setFading(false) }, reduced ? 0 : FADE_MS + 20)
    return () => clearTimeout(id)
  }, [playing])

  const at = (e: React.PointerEvent) => normalizePoint(root.current!.getBoundingClientRect(), e.clientX, e.clientY)
  const down = (e: React.PointerEvent) => {
    if (!active || g.current || (e.pointerType === 'mouse' && e.button !== 0)) return
    e.preventDefault()
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* pointer already gone */ }
    const p = at(e)
    const t0 = Date.now()
    g.current = { pid: e.pointerId, pts: [p], times: [0], t0, x0: e.clientX, y0: e.clientY, far: 0 }
    setCur([p])
    onStart()
  }
  const move = (e: React.PointerEvent) => {
    const s = g.current
    if (!s || s.pid !== e.pointerId) return
    s.far = Math.max(s.far, Math.hypot(e.clientX - s.x0, e.clientY - s.y0))
    const p = at(e)
    const last = s.pts[s.pts.length - 1]
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.004) return
    s.pts.push(p)
    s.times.push(Math.round(Date.now() - s.t0))
    setCur([...s.pts])
  }
  const up = (e: React.PointerEvent) => {
    const s = g.current
    if (!s || s.pid !== e.pointerId) return
    g.current = null
    setCur(null)
    const k = classifyMark(s.far)
    const points = k === 'dot' ? [s.pts[0]] : s.pts
    onMark(k, points, k === 'dot' ? [0] : s.times)
    const id = ++seq.current
    setTrail(l => [...l, { id, k, points }])
  }
  const shown: Ink[] = replayShown ? (replayMs === Infinity ? replayShown.marks : visibleMarks(replayShown.marks, replayMs)).map((m, i) => ({ id: replayShown.key * 100 + i, k: m.k, points: m.points })) : []
  return (
    <div ref={root} className="ink-layer" data-testid="ink-layer" data-on={active ? '' : undefined}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
      onClick={e => { if (active) e.stopPropagation() }}>
      <Strokes list={trail} fading={fading} />
      {replayShown ? <Strokes key={replayShown.key} list={shown} fading={fading} /> : null}
      {cur ? <Strokes list={[{ id: -1, k: 'stroke', points: cur.length > 1 ? cur : [cur[0], cur[0]] }]} live /> : null}
    </div>
  )
}

export { DOT_PX }
