'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useReviewStore } from '@/stores/review-store'

// ─── Types ────────────────────────────────────────────────────────────────────

export type DrawingTool = 'pen' | 'rectangle' | 'arrow' | 'line'

export interface UseDrawingReturn {
  canvasRef: React.RefObject<HTMLCanvasElement>
  resize: (width: number, height: number) => void
  clear: () => void
  undo: () => void
  getJSON: () => Record<string, unknown>
  loadJSON: (json: Record<string, unknown>) => void
}

const MAX_HISTORY = 20

// ─── Shared singleton state ───────────────────────────────────────────────────

let sharedFabric: import('fabric').Canvas | null = null
let sharedHistory: string[] = []
let sharedIsLoading = false
let sharedPendingSize: { w: number; h: number } | null = null

// Notify all hook consumers when canvas becomes ready
let readyListeners: Array<() => void> = []
function onCanvasReady(cb: () => void) {
  readyListeners.push(cb)
  return () => { readyListeners = readyListeners.filter((l) => l !== cb) }
}
function notifyCanvasReady() {
  readyListeners.forEach((cb) => cb())
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useDrawing(): UseDrawingReturn {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [canvasReady, setCanvasReady] = useState(!!sharedFabric)

  const { drawingTool, drawingColor, brushSize, isDrawingMode } = useReviewStore()

  // Listen for canvas ready notifications (for consumers without the canvas element)
  useEffect(() => {
    if (sharedFabric) { setCanvasReady(true); return }
    return onCanvasReady(() => setCanvasReady(true))
  }, [isDrawingMode])

  // ─── Bootstrap Fabric.js ────────────────────────────────────────────────────
  // Re-runs when isDrawingMode toggles so late-mounted canvas elements get initialized.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const el = canvasRef.current
    if (!el) return

    // If Fabric is already attached to THIS element, skip re-init
    if (sharedFabric && (sharedFabric as any).lowerCanvasEl === el) return

    let disposed = false

    // Capture parent container dimensions BEFORE Fabric wraps the element
    const parent = el.parentElement
    const parentW = parent?.clientWidth ?? 0
    const parentH = parent?.clientHeight ?? 0

    const init = async () => {
      const mod = await import('fabric')
      if (disposed) return

      // Dispose any existing canvas (might be on a stale/detached element)
      if (sharedFabric) {
        try { sharedFabric.dispose() } catch { /* already disposed */ }
        sharedFabric = null
      }

      const canvas = new mod.Canvas(el, {
        selection: false,
        renderOnAddRemove: true,
        skipTargetFind: true,
        hoverCursor: 'crosshair',
        moveCursor: 'crosshair',
        defaultCursor: 'crosshair',
      })

      sharedFabric = canvas
      notifyCanvasReady()

      // Use pre-captured parent dimensions, or pending size, or fallback
      const w = sharedPendingSize?.w ?? parentW
      const h = sharedPendingSize?.h ?? parentH
      if (w && h) {
        canvas.setDimensions({ width: w, height: h })
      }
      sharedPendingSize = null

      // Apply initial drawing settings immediately
      if (isDrawingMode) {
        canvas.isDrawingMode = true
        const brush = new mod.PencilBrush(canvas)
        brush.color = drawingColor
        brush.width = brushSize
        canvas.freeDrawingBrush = brush
      }

      sharedHistory = [JSON.stringify(canvas.toJSON())]

      const saveHistory = () => {
        if (sharedIsLoading || !sharedFabric) return
        const json = JSON.stringify(sharedFabric.toJSON())
        if (sharedHistory[sharedHistory.length - 1] !== json) {
          if (sharedHistory.length >= MAX_HISTORY) sharedHistory.shift()
          sharedHistory.push(json)
        }
      }

      canvas.on('object:added', saveHistory)
      canvas.on('object:modified', saveHistory)
      canvas.on('object:removed', saveHistory)
    }

    init()

    return () => {
      disposed = true
    }
  }, [isDrawingMode])

  // ─── Sync tool / color / brush size ─────────────────────────────────────────
  useEffect(() => {
    if (typeof window === 'undefined') return
    const canvas = sharedFabric
    if (!canvas) return

    if (!isDrawingMode) {
      canvas.isDrawingMode = false
      return
    }

    const applyTool = async () => {
      const mod = await import('fabric')

      // Deselect any active object
      canvas.discardActiveObject()
      canvas.renderAll()

      if (drawingTool === 'pen') {
        canvas.isDrawingMode = true
        const brush = new mod.PencilBrush(canvas)
        brush.color = drawingColor
        brush.width = brushSize
        canvas.freeDrawingBrush = brush
      } else {
        // For shapes (rectangle, arrow, line) we handle via mouse events
        canvas.isDrawingMode = false
      }
    }

    applyTool()
  }, [drawingTool, drawingColor, brushSize, isDrawingMode, canvasReady])

  // ─── Shape drawing (rectangle, arrow, line) ─────────────────────────────────
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!isDrawingMode) return
    if (drawingTool !== 'rectangle' && drawingTool !== 'arrow' && drawingTool !== 'line') return

    const canvas = sharedFabric
    if (!canvas) return

    let startX = 0
    let startY = 0
    let activeShape: import('fabric').FabricObject | null = null
    let drawing = false

    const handleMouseDown = async (opt: import('fabric').TPointerEventInfo) => {
      const mod = await import('fabric')
      const pointer = canvas.getScenePoint(opt.e as MouseEvent)
      startX = pointer.x
      startY = pointer.y
      drawing = true

      if (drawingTool === 'rectangle') {
        const rect = new mod.Rect({
          left: pointer.x,
          top: pointer.y,
          originX: 'left',
          originY: 'top',
          width: 0,
          height: 0,
          stroke: drawingColor,
          strokeWidth: 2,
          fill: 'transparent',
          selectable: false,
          evented: false,
          hasControls: false,
          hasBorders: false,
        })
        canvas.add(rect)
        activeShape = rect
      }

      if (drawingTool === 'arrow' || drawingTool === 'line') {
        const line = new mod.Line([pointer.x, pointer.y, pointer.x, pointer.y], {
          stroke: drawingColor,
          strokeWidth: 2,
          selectable: false,
          evented: false,
          hasControls: false,
          hasBorders: false,
        })
        canvas.add(line)
        activeShape = line
      }
    }

    const handleMouseMove = async (opt: import('fabric').TPointerEventInfo) => {
      if (!drawing || !activeShape) return
      const mod = await import('fabric')
      const pointer = canvas.getScenePoint(opt.e as MouseEvent)

      if (drawingTool === 'rectangle' && activeShape instanceof mod.Rect) {
        activeShape.set({
          left: Math.min(startX, pointer.x),
          top: Math.min(startY, pointer.y),
          width: Math.abs(pointer.x - startX),
          height: Math.abs(pointer.y - startY),
        })
        canvas.renderAll()
      }

      if ((drawingTool === 'arrow' || drawingTool === 'line') && activeShape instanceof mod.Line) {
        activeShape.set({ x2: pointer.x, y2: pointer.y })
        canvas.renderAll()
      }
    }

    const handleMouseUp = async () => {
      // Add arrowhead for arrow tool
      if (drawingTool === 'arrow' && activeShape) {
        const mod = await import('fabric')
        if (activeShape instanceof mod.Line) {
          const x1 = activeShape.x1 ?? 0
          const y1 = activeShape.y1 ?? 0
          const x2 = activeShape.x2 ?? 0
          const y2 = activeShape.y2 ?? 0
          const angle = Math.atan2(y2 - y1, x2 - x1)
          const headLen = 12

          const head = new mod.Polygon(
            [
              { x: x2, y: y2 },
              {
                x: x2 - headLen * Math.cos(angle - Math.PI / 6),
                y: y2 - headLen * Math.sin(angle - Math.PI / 6),
              },
              {
                x: x2 - headLen * Math.cos(angle + Math.PI / 6),
                y: y2 - headLen * Math.sin(angle + Math.PI / 6),
              },
            ],
            {
              fill: drawingColor,
              selectable: false,
              evented: false,
              hasControls: false,
              hasBorders: false,
            },
          )
          canvas.add(head)
        }
      }

      drawing = false
      activeShape = null
    }

    const disposeDown = canvas.on('mouse:down', handleMouseDown)
    const disposeMove = canvas.on('mouse:move', handleMouseMove)
    const disposeUp = canvas.on('mouse:up', handleMouseUp)

    return () => {
      disposeDown()
      disposeMove()
      disposeUp()
    }
  }, [isDrawingMode, drawingTool, drawingColor, canvasReady])

  // ─── Methods ─────────────────────────────────────────────────────────────────

  const resize = useCallback((width: number, height: number) => {
    if (sharedFabric) {
      sharedFabric.setDimensions({ width, height })
      sharedFabric.renderAll()
    } else {
      sharedPendingSize = { w: width, h: height }
    }
  }, [])

  const clear = useCallback(() => {
    if (!sharedFabric) return
    sharedFabric.clear()
    sharedHistory = [JSON.stringify(sharedFabric.toJSON())]
  }, [])

  const undo = useCallback(() => {
    if (!sharedFabric) return
    if (sharedHistory.length <= 1) return
    sharedHistory.pop()
    const previous = sharedHistory[sharedHistory.length - 1]
    sharedIsLoading = true
    sharedFabric.loadFromJSON(JSON.parse(previous) as Record<string, unknown>).then(() => {
      sharedFabric?.renderAll()
      sharedIsLoading = false
    })
  }, [])

  const getJSON = useCallback((): Record<string, unknown> => {
    if (!sharedFabric) return {}
    const json = sharedFabric.toJSON() as Record<string, unknown>
    // Store canvas dimensions so the overlay can scale coordinates
    // when the container size differs from when the annotation was drawn.
    json._canvasWidth = sharedFabric.width
    json._canvasHeight = sharedFabric.height
    return json
  }, [])

  const loadJSON = useCallback((json: Record<string, unknown>) => {
    if (!sharedFabric) return
    sharedIsLoading = true
    sharedFabric.loadFromJSON(json).then(() => {
      sharedFabric?.renderAll()
      sharedIsLoading = false
    })
  }, [])

  return { canvasRef, resize, clear, undo, getJSON, loadJSON }
}
