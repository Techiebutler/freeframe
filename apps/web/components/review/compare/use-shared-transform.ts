'use client'

import * as React from 'react'

/** Single zoom/pan transform shared by both compare sides (wipe or side-by-side). */
export function useSharedTransform() {
  const [scale, setScale] = React.useState(1)
  const [tx, setTx] = React.useState(0)
  const [ty, setTy] = React.useState(0)
  const drag = React.useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)
  const dragCleanup = React.useRef<(() => void) | null>(null)
  React.useEffect(() => () => dragCleanup.current?.(), [])

  const onWheel = React.useCallback((e: { deltaY: number; preventDefault(): void }) => {
    e.preventDefault()
    setScale((s) => {
      const next = e.deltaY < 0 ? s * 1.2 : s / 1.2
      const clamped = Math.min(Math.max(next, 1), 8)
      if (clamped === 1) { setTx(0); setTy(0) }
      return clamped
    })
  }, [])

  const onPointerDown = React.useCallback((e: React.PointerEvent) => {
    if (scale === 1) return
    drag.current = { x: e.clientX, y: e.clientY, tx, ty }
    const move = (ev: PointerEvent) => {
      if (!drag.current) return
      setTx(drag.current.tx + (ev.clientX - drag.current.x))
      setTy(drag.current.ty + (ev.clientY - drag.current.y))
    }
    const up = () => {
      drag.current = null
      dragCleanup.current = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    dragCleanup.current = up
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, [scale, tx, ty])

  const reset = React.useCallback(() => { setScale(1); setTx(0); setTy(0) }, [])

  const styleFor = React.useCallback(
    (): React.CSSProperties => ({
      transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
      transformOrigin: 'center center',
    }),
    [scale, tx, ty],
  )

  return { scale, tx, ty, styleFor, onWheel, onPointerDown, reset }
}
