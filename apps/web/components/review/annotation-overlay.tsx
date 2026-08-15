'use client'

import React, { useEffect, useRef } from 'react'
import { useReviewStore } from '@/stores/review-store'
import { MediaFrameContext, MEDIA_FRAME_SPACE } from './media-frame-context'
import { containBox } from '@/lib/media-frame'

interface AnnotationOverlayProps {
  /**
   * Compare panes: render THIS drawing instead of the store's activeAnnotation.
   * Pass null to render nothing. Omit entirely for store-driven behavior.
   */
  annotation?: Record<string, unknown> | null
}

/**
 * Read-only overlay that renders a saved Fabric.js annotation on top of the media.
 * Shown when a comment with an annotation is focused/hovered.
 */
export function AnnotationOverlay({ annotation }: AnnotationOverlayProps = {}) {
  const storeActiveAnnotation = useReviewStore((s) => s.activeAnnotation)
  const active = annotation !== undefined ? annotation : storeActiveAnnotation
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const legacyFrame = React.useContext(MediaFrameContext)

  // The constrained box is not final on mount: an <img> that has not decoded
  // reports no size, so the constraint starts as the whole pane and shrinks to
  // the picture on load. Re-running on that change keeps a deep-linked
  // annotation from being scaled against the pane. AnnotationCanvas already
  // does this via its own ResizeObserver.
  const [boxSize, setBoxSize] = React.useState<string>('')
  useEffect(() => {
    const el = containerRef.current
    // Absent in SSR and in older browsers; the initial measurement still stands.
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      setBoxSize(`${el.offsetWidth}x${el.offsetHeight}`)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [active])

  useEffect(() => {
    if (!active || !canvasRef.current || !containerRef.current) return

    let disposed = false
    let fabricCanvas: any = null

    // Defer to next frame so the DOM has been laid out (offsetWidth/Height are valid)
    const rafId = requestAnimationFrame(async () => {
      if (disposed || !canvasRef.current || !containerRef.current) return

      const { Canvas } = await import('fabric')
      if (disposed || !canvasRef.current || !containerRef.current) return

      // Use offsetWidth/offsetHeight — layout dimensions before CSS transforms
      let w = containerRef.current.offsetWidth
      let h = containerRef.current.offsetHeight

      // Fallback to getBoundingClientRect if offset returns 0
      if (!w || !h) {
        const rect = containerRef.current.getBoundingClientRect()
        w = Math.floor(rect.width)
        h = Math.floor(rect.height)
      }

      if (!w || !h) return // container still has no size

      fabricCanvas = new Canvas(canvasRef.current, {
        selection: false,
        renderOnAddRemove: false,
        skipTargetFind: true,
        interactive: false,
      })

      fabricCanvas.setDimensions({ width: w, height: h })

      try {
        const data = active as Record<string, unknown>
        // _canvasWidth/_canvasHeight are saved by use-drawing's getJSON().
        // Fall back to data.width (never set by Fabric) then current size.
        const origWidth = (data._canvasWidth as number) || (data.width as number) || w
        const origHeight = (data._canvasHeight as number) || (data.height as number) || h

        // Data saved before the frame fix measured the whole letterboxed
        // container, not the picture. Reconstruct where the picture sat inside
        // that container (the contain fit of the media's intrinsic size into
        // the stored dimensions) so the mark can be expressed relative to the
        // picture and replayed correctly at any size. `legacyFrame` is null on
        // surfaces that always authored in media space (video), where unmarked
        // data is already correct.
        const isLegacy =
          data._frameSpace !== MEDIA_FRAME_SPACE &&
          legacyFrame !== null &&
          !!legacyFrame.naturalWidth &&
          !!legacyFrame.naturalHeight

        const authored = isLegacy
          ? containBox(legacyFrame!.naturalWidth, legacyFrame!.naturalHeight, origWidth, origHeight)
          : { left: 0, top: 0, width: origWidth, height: origHeight }

        const scaleX = w / authored.width
        const scaleY = h / authored.height

        await fabricCanvas.loadFromJSON(active)

        if (scaleX !== 1 || scaleY !== 1 || authored.left || authored.top) {
          fabricCanvas.getObjects().forEach((obj: any) => {
            obj.set({
              left: ((obj.left ?? 0) - authored.left) * scaleX,
              top: ((obj.top ?? 0) - authored.top) * scaleY,
              scaleX: (obj.scaleX ?? 1) * scaleX,
              scaleY: (obj.scaleY ?? 1) * scaleY,
            })
            obj.setCoords()
          })
        }

        fabricCanvas.renderAll()
      } catch {
        // annotation data may be invalid
      }
    })

    return () => {
      disposed = true
      cancelAnimationFrame(rafId)
      if (fabricCanvas) {
        try { fabricCanvas.dispose() } catch { /* ignore */ }
      }
    }
  }, [active, legacyFrame, boxSize])

  if (!active) return null

  return (
    <div
      ref={containerRef}
      data-testid="annotation-overlay"
      className="absolute inset-0 z-10 pointer-events-none"
      style={{ overflow: 'hidden' }}
    >
      <canvas ref={canvasRef} />
    </div>
  )
}
