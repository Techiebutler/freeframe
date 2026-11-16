'use client'

import * as React from 'react'

const COLORS = ['#ff453a', '#ff9f0a', '#ffd60a', '#32d74b', '#0a84ff', '#bf5af2']
const PIECES = Array.from({ length: 28 }, (_, i) => {
  const a = (i / 28) * Math.PI * 2 + (i % 3) * 0.2
  const d = 90 + (i % 5) * 38
  return { dx: Math.round(Math.cos(a) * d), dy: Math.round(Math.sin(a) * d) - 60, r: (i * 97) % 360, c: COLORS[i % COLORS.length] }
})

/** Apple-style burst, 1.2 s, no text, never blocks a tap. Re-fires whenever `burst` changes; nothing at all under reduced motion. */
export function Confetti({ burst }: { burst: number }) {
  const [live, setLive] = React.useState(false)
  React.useEffect(() => {
    if (!burst || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    setLive(true)
    const id = setTimeout(() => setLive(false), 1300)
    return () => clearTimeout(id)
  }, [burst])
  if (!live) return null
  return (
    <div data-testid="confetti" aria-hidden="true" className="pointer-events-none absolute inset-0 z-50 overflow-hidden motion-reduce:hidden">
      {PIECES.map((p, i) => (
        <span key={i} className="confetti-piece" style={{ '--dx': `${p.dx}px`, '--dy': `${p.dy}px`, '--r': `${p.r}deg`, background: p.c } as React.CSSProperties} />
      ))}
    </div>
  )
}
