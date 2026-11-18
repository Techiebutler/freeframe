'use client'

import { useEffect, useState } from 'react'

/**
 * Height of the on-screen keyboard in CSS px — 0 when there is none.
 *
 * Neither iOS Safari nor current Android Chrome shrinks the LAYOUT viewport
 * when the keyboard opens; both resize only the VISUAL viewport. Anything
 * bottom-anchored inside a `position: fixed` box therefore sits behind the
 * keyboard unless it is lifted by hand. That is what this measures:
 *
 *   layoutViewportHeight - (visualViewport.height + visualViewport.offsetTop)
 *
 * `offsetTop` matters because iOS scrolls the visual viewport within the layout
 * viewport instead of only shrinking it.
 *
 * jsdom implements no visualViewport, so the guard below yields 0 — which is
 * exactly today's layout, not a special case.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0)

  useEffect(() => {
    const vv = typeof window === 'undefined' ? undefined : window.visualViewport
    if (!vv) return

    const read = () => {
      const visible = vv.height + vv.offsetTop
      setInset(Math.max(0, window.innerHeight - visible))
    }

    read()
    vv.addEventListener('resize', read)
    vv.addEventListener('scroll', read)
    return () => {
      vv.removeEventListener('resize', read)
      vv.removeEventListener('scroll', read)
    }
  }, [])

  return inset
}
