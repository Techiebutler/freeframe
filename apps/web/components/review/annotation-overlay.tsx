'use client'

import React, { useEffect, useRef } from 'react'
import { useReviewStore } from '@/stores/review-store'

/**
 * Read-only overlay that renders a saved Fabric.js annotation on top of the media.
 * Shown when a comment with an annotation is focused/hovered.
 */
export function AnnotationOverlay() {
  const activeAnnotation = useReviewStore((s) => s.activeAnnotation)
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (!activeAnnotation || !canvasRef.current || !containerRef.current) return

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
        const data = activeAnnotation as Record<string, unknown>
        const origWidth = (data.width as number) || w
        const origHeight = (data.height as number) || h
        const scaleX = w / origWidth
        const scaleY = h / origHeight

        await fabricCanvas.loadFromJSON(activeAnnotation)

        if (scaleX !== 1 || scaleY !== 1) {
          fabricCanvas.getObjects().forEach((obj: any) => {
            obj.set({
              left: (obj.left ?? 0) * scaleX,
              top: (obj.top ?? 0) * scaleY,
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
  }, [activeAnnotation])

  if (!activeAnnotation) return null

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 z-10 pointer-events-none"
      style={{ overflow: 'hidden' }}
    >
      <canvas ref={canvasRef} />
    </div>
  )
}
