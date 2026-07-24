import { useEffect, useRef, useState } from 'react'

// Keep a conditionally-rendered element mounted through its close animation.
// Returns `mounted` (true while open OR animating out) and `state`
// ('open' | 'closed') to drive data-[state=*] enter/exit classes. `durationMs`
// must match the exit animation length so unmount lands after it finishes.
export function useDelayedUnmount(open: boolean, durationMs = 150) {
  const [mounted, setMounted] = useState(open)
  const [state, setState] = useState<'open' | 'closed'>(open ? 'open' : 'closed')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    if (open) {
      setMounted(true)
      // Flip to 'open' next frame so the enter transition runs from 'closed'.
      const raf = requestAnimationFrame(() => setState('open'))
      return () => cancelAnimationFrame(raf)
    }
    setState('closed')
    timer.current = setTimeout(() => setMounted(false), durationMs)
  }, [open, durationMs])

  return { mounted, state }
}
