'use client'

import * as React from 'react'
import { METER_COLUMNS, METER_ROWS, dotStyle, smoothLevel } from '@/lib/level-meter'

const STEP_MS = 70

function paint(col: HTMLElement | null, level: number) {
  if (!col) return
  Array.from(col.children).forEach((el, r) => {
    const d = dotStyle(level, r, METER_ROWS)
    const s = (el as HTMLElement).style
    s.opacity = String(d.opacity)
    s.transform = `scale(${d.scale || 0.5})`
    s.backgroundColor = d.peak ? 'var(--accent-hover)' : d.on ? 'var(--text-primary)' : 'var(--text-tertiary)'
    s.boxShadow = d.peak ? '0 0 6px rgba(255,91,58,.7)' : 'none'
  })
}

/**
 * Dot-matrix level, centred: each column grows symmetrically from the centre line. Driven every animation frame: the newest
 * column follows the voice live (fast attack, slow release), older columns scroll left and fade out. Static under reduced motion.
 */
export function LevelMeter({ levelRef, active = true }: { levelRef: React.MutableRefObject<number>; active?: boolean }) {
  const cols = React.useRef<(HTMLDivElement | null)[]>([])
  React.useEffect(() => {
    const reduced = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const hist = Array.from({ length: METER_COLUMNS }, (_, i) => (reduced ? 0.25 + ((i * 7) % 5) / 12 : 0))
    const paintAll = () => hist.forEach((lv, i) => paint(cols.current[i], lv))
    paintAll()
    if (reduced || !active) return
    let raf = 0
    let last = -1
    let since = 0
    let smooth = 0
    const tick = (now: number) => {
      if (last < 0) { last = now; raf = requestAnimationFrame(tick); return }
      const dt = Math.min(100, now - last)
      last = now
      smooth = smoothLevel(smooth, levelRef.current, dt)
      since += dt
      if (since >= STEP_MS) {
        since -= STEP_MS
        hist.shift(); hist.push(smooth)
        paintAll()
        // the newest column pops in
        cols.current[METER_COLUMNS - 1]?.animate?.([{ transform: 'scale(1.15)' }, { transform: 'scale(1)' }], { duration: 120, easing: 'ease-out' })
      } else {
        hist[METER_COLUMNS - 1] = smooth
        paint(cols.current[METER_COLUMNS - 1], smooth)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [active, levelRef])

  return (
    <div data-testid="level-meter" aria-hidden="true" className="flow-meter flex h-14 min-w-0 flex-1 items-center justify-center gap-[3px]">
      {Array.from({ length: METER_COLUMNS }, (_, c) => (
        <div key={c} ref={el => { cols.current[c] = el }} className="flex origin-center flex-col gap-[3px]">
          {Array.from({ length: METER_ROWS }, (_, r) => <span key={r} className="block h-[5px] w-[5px] rounded-full" style={{ willChange: 'transform, opacity' }} />)}
        </div>
      ))}
    </div>
  )
}
