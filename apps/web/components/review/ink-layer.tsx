'use client'

import * as React from 'react'
import { DOT_PX, INK_MS, classifyMark, normalizePoint, type InkMark } from '@/lib/ink'

type Ink = { id: number; k: 'stroke' | 'dot'; points: [number, number][] }

export const Strokes = ({ list, live }: { list: Ink[]; live?: boolean }) => (
  <>
    <svg className="ink-svg" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
      {list.filter(m => m.k === 'stroke').map(m => (
        <polyline key={m.id} className="ink-line" data-live={live ? '' : undefined} points={m.points.map(p => p.join(',')).join(' ')} />
      ))}
    </svg>
    {list.filter(m => m.k === 'dot').map(m => (
      <i key={m.id} className="ink-dot" data-live={live ? '' : undefined} style={{ left: `${m.points[0][0] * 100}%`, top: `${m.points[0][1] * 100}%` }} />
    ))}
  </>
)

export interface InkReplay { key: number; marks: Pick<InkMark, 'k' | 'points'>[] }

/**
 * The drawing surface over the picture, mounted inside the video frame (so 0..1 is the picture, never the letterbox).
 * Only while recording does it take the pointer. Drag = stroke, tap = dot; ink fades after INK_MS but is kept.
 * The first touch pauses the video; the recording goes on. A second finger is ignored while the first draws.
 */
export function InkLayer({ active, onStart, onMark, replay }: {
  active: boolean
  onStart: () => void
  onMark: (k: 'stroke' | 'dot', points: [number, number][]) => void
  replay?: InkReplay | null
}) {
  const root = React.useRef<HTMLDivElement>(null)
  const [cur, setCur] = React.useState<[number, number][] | null>(null)
  const [trail, setTrail] = React.useState<Ink[]>([])
  const g = React.useRef<{ pid: number; pts: [number, number][]; x0: number; y0: number; far: number } | null>(null)
  const seq = React.useRef(0)
  const gone = React.useRef(false)
  React.useEffect(() => { gone.current = false; return () => { gone.current = true } }, [])
  React.useEffect(() => { if (!active) { g.current = null; setCur(null) } }, [active])
  const [replayShown, setReplayShown] = React.useState<InkReplay | null>(null)
  React.useEffect(() => {
    if (!replay) return
    setReplayShown(replay)
    const id = setTimeout(() => setReplayShown(null), INK_MS + 100)
    return () => clearTimeout(id)
  }, [replay])

  const at = (e: React.PointerEvent) => normalizePoint(root.current!.getBoundingClientRect(), e.clientX, e.clientY)
  const down = (e: React.PointerEvent) => {
    if (!active || g.current || (e.pointerType === 'mouse' && e.button !== 0)) return
    e.preventDefault()
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* pointer already gone */ }
    const p = at(e)
    g.current = { pid: e.pointerId, pts: [p], x0: e.clientX, y0: e.clientY, far: 0 }
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
    setCur([...s.pts])
  }
  const up = (e: React.PointerEvent) => {
    const s = g.current
    if (!s || s.pid !== e.pointerId) return
    g.current = null
    setCur(null)
    const k = classifyMark(s.far)
    const points = k === 'dot' ? [s.pts[0]] : s.pts
    onMark(k, points)
    const id = ++seq.current
    setTrail(l => [...l, { id, k, points }])
    setTimeout(() => { if (!gone.current) setTrail(l => l.filter(m => m.id !== id)) }, INK_MS + 100)
  }
  const shown: Ink[] = replayShown ? replayShown.marks.map((m, i) => ({ id: replayShown.key * 100 + i, k: m.k, points: m.points })) : []
  return (
    <div ref={root} className="ink-layer" data-testid="ink-layer" data-on={active ? '' : undefined}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
      onClick={e => { if (active) e.stopPropagation() }}>
      <Strokes list={trail} />
      {replayShown ? <Strokes key={replayShown.key} list={shown} /> : null}
      {cur ? <Strokes list={[{ id: -1, k: 'stroke', points: cur.length > 1 ? cur : [cur[0], cur[0]] }]} live /> : null}
    </div>
  )
}

export { DOT_PX }
