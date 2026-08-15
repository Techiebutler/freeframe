'use client'

import * as React from 'react'
import { cn } from '@/lib/utils'
import { renderedMediaBox } from '@/lib/media-frame'
import { MediaFrameContext, type LegacyAnnotationFrame } from './media-frame-context'

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
  // What annotations saved before the frame fix were measured against.
  const [legacyFrame, setLegacyFrame] = React.useState<LegacyAnnotationFrame | null>(null)

  React.useEffect(() => {
    const img = imgRef.current
    if (!img) return

    const calc = () => {
      const box = renderedMediaBox({
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
        // Nothing measured yet; recalculated on the next load/resize.
        setLegacyFrame(null)
        return
      }

      // Enough for the overlay to reconstruct the picture box inside the
      // container that pre-fix annotations were authored against.
      setLegacyFrame({ naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight })

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

    // Watch both boxes. Under `w-full h-full` the <img> resizes with its
    // container, but under `max-*` an image smaller than the container renders
    // at natural size and a resize only RECENTRES it — offsetLeft/offsetTop
    // move while the element's own box is untouched, and ResizeObserver does not
    // fire on a position-only change. Observing the container catches that;
    // observing the <img> catches a box change that leaves the container alone.
    const ro = new ResizeObserver(calc)
    ro.observe(img)
    if (img.parentElement) ro.observe(img.parentElement)

    return () => {
      img.removeEventListener('load', calc)
      ro.disconnect()
    }
  }, [imgRef])

  return (
    <MediaFrameContext.Provider value={legacyFrame}>
      <div style={style} className={cn('overflow-hidden', className)}>
        {children}
      </div>
    </MediaFrameContext.Provider>
  )
}
