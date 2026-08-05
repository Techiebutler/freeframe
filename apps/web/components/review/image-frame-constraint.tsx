'use client'

import * as React from 'react'
import { cn } from '@/lib/utils'
import { renderedImageBox } from '@/lib/media-frame'

/**
 * Wraps children so they sit exactly over the visible picture, excluding the
 * empty bands `object-contain` leaves around it.
 *
 * Annotations are AUTHORED inside this constraint (image-frame coordinates), so
 * every viewer that renders them must mount the overlay in the same space —
 * otherwise the same drawing lands somewhere else whenever the container's
 * aspect ratio differs from the one it was drawn in. Mirrors
 * `VideoFrameConstraint` in video-player.tsx, which does this for <video>.
 *
 * Both children that go in here size themselves from their parent
 * (`AnnotationOverlay` reads offsetWidth/offsetHeight, `AnnotationCanvas` feeds
 * the same into Fabric via useDrawing), so being inside this wrapper is the
 * whole mechanism — neither needed changing.
 *
 * Uses offset* rather than getBoundingClientRect because this renders inside
 * react-zoom-pan-pinch's TransformComponent: offset* are pre-transform layout
 * values, while a client rect would fold the zoom/pan matrix in.
 */
export function ImageFrameConstraint({
  imgRef,
  className,
  children,
}: {
  imgRef: React.RefObject<HTMLImageElement | null>
  /** Merged onto the constrained box — callers use it for pointer-events. */
  className?: string
  children: React.ReactNode
}) {
  const [style, setStyle] = React.useState<React.CSSProperties>({ position: 'absolute', inset: 0 })

  React.useEffect(() => {
    const img = imgRef.current
    if (!img) return

    const calc = () => {
      const box = renderedImageBox({
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        elementWidth: img.offsetWidth,
        elementHeight: img.offsetHeight,
        offsetLeft: img.offsetLeft,
        offsetTop: img.offsetTop,
      })

      // Not laid out yet — fill the container so the overlay is never orphaned
      // at 0x0, and recalculate on the next load/resize.
      if (!box) {
        setStyle({ position: 'absolute', inset: 0 })
        return
      }

      setStyle({
        position: 'absolute',
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
      })
    }

    calc()
    // A cached image can be complete before this effect runs, so calc() above
    // is not redundant with the load listener.
    img.addEventListener('load', calc)

    // The <img> itself resizes whenever its container does, under both the
    // max-* and the w-full/h-full patterns, so observing it covers both.
    const ro = new ResizeObserver(calc)
    ro.observe(img)

    return () => {
      img.removeEventListener('load', calc)
      ro.disconnect()
    }
  }, [imgRef])

  return (
    <div style={style} className={cn('overflow-hidden', className)}>
      {children}
    </div>
  )
}
