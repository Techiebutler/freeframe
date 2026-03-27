'use client'

import React, { useCallback, useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { useDrawing } from '@/hooks/use-drawing'
import { useReviewStore } from '@/stores/review-store'

interface AnnotationCanvasProps {
  onSave?: (drawingData: Record<string, unknown>) => void
  className?: string
}

/**
 * Transparent overlay canvas for drawing annotations on the media viewer.
 * The toolbar is rendered separately in the comment input (Frame.io style).
 */
export function AnnotationCanvas({ onSave, className }: AnnotationCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const { isDrawingMode, setPendingAnnotation } = useReviewStore()
  const { canvasRef, resize, getJSON } = useDrawing()
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave

  const saveAnnotation = useCallback((data: Record<string, unknown>) => {
    onSaveRef.current?.(data)
    setPendingAnnotation(data)
  }, [setPendingAnnotation])

  // Keep Fabric canvas dimensions synced with the container
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const sync = () => {
      // Use offsetWidth/offsetHeight to get layout dimensions BEFORE CSS transforms
      // (getBoundingClientRect includes zoom transforms from TransformComponent)
      const w = container.offsetWidth || Math.floor(container.getBoundingClientRect().width)
      const h = container.offsetHeight || Math.floor(container.getBoundingClientRect().height)
      resize(w, h)
    }

    sync()
    const timer = setTimeout(sync, 100)

    const ro = new ResizeObserver(sync)
    ro.observe(container)
    return () => {
      ro.disconnect()
      clearTimeout(timer)
    }
  }, [resize])

  // Push canvas state to parent on every drawing change
  useEffect(() => {
    if (typeof window === 'undefined' || !isDrawingMode) return

    let checkInterval: ReturnType<typeof setInterval> | null = null

    // Poll for fabric canvas availability then attach listeners
    const interval = setInterval(() => {
      try {
        const json = getJSON()
        const objects = (json as any)?.objects
        if (!objects) return // canvas not ready yet

        clearInterval(interval)

        // Re-export JSON on every change
        checkInterval = setInterval(() => {
          const data = getJSON()
          const objs = (data as any)?.objects
          if (objs && Array.isArray(objs) && objs.length > 0) {
            saveAnnotation(data)
          }
        }, 500)
      } catch {
        // canvas not ready
      }
    }, 200)

    return () => {
      clearInterval(interval)
      if (checkInterval) clearInterval(checkInterval)
    }
  }, [isDrawingMode, getJSON, saveAnnotation])

  // When exiting drawing mode, capture final state
  const prevDrawingMode = useRef(isDrawingMode)
  useEffect(() => {
    if (prevDrawingMode.current && !isDrawingMode) {
      // Just exited drawing mode — save final canvas state
      const json = getJSON()
      const objects = (json as any)?.objects
      if (objects && Array.isArray(objects) && objects.length > 0) {
        saveAnnotation(json)
      }
    }
    prevDrawingMode.current = isDrawingMode
  }, [isDrawingMode, getJSON, saveAnnotation])

  if (!isDrawingMode) return null

  return (
    <div
      ref={containerRef}
      className={cn('absolute inset-0 z-10', className)}
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 cursor-crosshair"
        style={{ touchAction: 'none' }}
      />
    </div>
  )
}
