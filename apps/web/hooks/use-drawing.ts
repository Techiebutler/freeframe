'use client'

import { useCallback, useEffect, useRef } from 'react'
import { useReviewStore } from '@/stores/review-store'

// ─── Types ────────────────────────────────────────────────────────────────────

export type DrawingTool = 'pen' | 'rectangle' | 'arrow' | 'text' | 'eraser'

export interface UseDrawingReturn {
  canvasRef: React.RefObject<HTMLCanvasElement>
  clear: () => void
  undo: () => void
  getJSON: () => Record<string, unknown>
  loadJSON: (json: Record<string, unknown>) => void
}

const MAX_HISTORY = 20

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useDrawing(): UseDrawingReturn {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // Store the fabric Canvas instance as unknown to avoid top-level fabric import (SSR)
  const fabricRef = useRef<import('fabric').Canvas | null>(null)
  const historyRef = useRef<string[]>([])
  const isLoadingRef = useRef(false)

  const { drawingTool, drawingColor, brushSize, isDrawingMode } = useReviewStore()

  // ─── Bootstrap Fabric.js ────────────────────────────────────────────────────
  useEffect(() => {
    if (typeof window === 'undefined') return
    const el = canvasRef.current
    if (!el) return

    let canvas: import('fabric').Canvas | null = null

    const init = async () => {
      const mod = await import('fabric')

      canvas = new mod.Canvas(el, {
        selection: false,
        renderOnAddRemove: true,
      })

      fabricRef.current = canvas

      // Save initial blank state
      historyRef.current = [JSON.stringify(canvas.toJSON())]

      const saveHistory = () => {
        if (isLoadingRef.current || !canvas) return
        const json = JSON.stringify(canvas.toJSON())
        const history = historyRef.current
        if (history[history.length - 1] !== json) {
          if (history.length >= MAX_HISTORY) history.shift()
          history.push(json)
        }
      }

      canvas.on('object:added', saveHistory)
      canvas.on('object:modified', saveHistory)
      canvas.on('object:removed', saveHistory)
    }

    init()

    return () => {
      if (canvas) canvas.dispose()
      fabricRef.current = null
    }
  }, [])

  // ─── Sync tool / color / brush size ─────────────────────────────────────────
  useEffect(() => {
    if (typeof window === 'undefined') return
    const canvas = fabricRef.current
    if (!canvas) return

    if (!isDrawingMode) {
      canvas.isDrawingMode = false
      canvas.selection = false
      return
    }

    const applyTool = async () => {
      const mod = await import('fabric')

      if (drawingTool === 'pen' || drawingTool === 'eraser') {
        canvas.isDrawingMode = true
        canvas.selection = false
        const brush = new mod.PencilBrush(canvas)
        brush.color = drawingTool === 'eraser' ? '#ffffff' : drawingColor
        brush.width = drawingTool === 'eraser' ? brushSize * 3 : brushSize
        canvas.freeDrawingBrush = brush
      } else {
        // rectangle / arrow / text — handled via mouse event listeners below
        canvas.isDrawingMode = false
        canvas.selection = false
      }
    }

    applyTool()
  }, [drawingTool, drawingColor, brushSize, isDrawingMode])

  // ─── Shape drawing (rectangle, arrow, text) ──────────────────────────────────
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!isDrawingMode) return
    if (drawingTool !== 'rectangle' && drawingTool !== 'arrow' && drawingTool !== 'text') return

    const canvas = fabricRef.current
    if (!canvas) return

    let shapeStartX = 0
    let shapeStartY = 0
    let activeShape: import('fabric').FabricObject | null = null
    let isDrawingShape = false

    const handleMouseDown = async (opt: import('fabric').TPointerEventInfo) => {
      const mod = await import('fabric')
      const pointer = canvas.getScenePoint(opt.e as MouseEvent)
      shapeStartX = pointer.x
      shapeStartY = pointer.y
      isDrawingShape = true

      if (drawingTool === 'text') {
        const textbox = new mod.IText('Text', {
          left: pointer.x,
          top: pointer.y,
          fontSize: 18,
          fill: drawingColor,
          selectable: true,
          editable: true,
        })
        canvas.add(textbox)
        canvas.setActiveObject(textbox)
        textbox.enterEditing()
        isDrawingShape = false
        return
      }

      if (drawingTool === 'rectangle') {
        const rect = new mod.Rect({
          left: pointer.x,
          top: pointer.y,
          width: 0,
          height: 0,
          stroke: drawingColor,
          strokeWidth: 2,
          fill: 'transparent',
          selectable: false,
        })
        canvas.add(rect)
        activeShape = rect
      }

      if (drawingTool === 'arrow') {
        const line = new mod.Line([pointer.x, pointer.y, pointer.x, pointer.y], {
          stroke: drawingColor,
          strokeWidth: 2,
          selectable: false,
        })
        canvas.add(line)
        activeShape = line
      }
    }

    const handleMouseMove = async (opt: import('fabric').TPointerEventInfo) => {
      if (!isDrawingShape || !activeShape) return
      const mod = await import('fabric')
      const pointer = canvas.getScenePoint(opt.e as MouseEvent)

      if (drawingTool === 'rectangle' && activeShape instanceof mod.Rect) {
        activeShape.set({
          left: Math.min(shapeStartX, pointer.x),
          top: Math.min(shapeStartY, pointer.y),
          width: Math.abs(pointer.x - shapeStartX),
          height: Math.abs(pointer.y - shapeStartY),
        })
        canvas.renderAll()
      }

      if (drawingTool === 'arrow' && activeShape instanceof mod.Line) {
        activeShape.set({ x2: pointer.x, y2: pointer.y })
        canvas.renderAll()
      }
    }

    const handleMouseUp = () => {
      isDrawingShape = false
      activeShape = null
    }

    // Use disposers — the fabric v7 on() returns a VoidFunction disposer
    const disposeDown = canvas.on('mouse:down', handleMouseDown)
    const disposeMove = canvas.on('mouse:move', handleMouseMove)
    const disposeUp = canvas.on('mouse:up', handleMouseUp)

    return () => {
      disposeDown()
      disposeMove()
      disposeUp()
    }
  }, [isDrawingMode, drawingTool, drawingColor])

  // ─── Methods ─────────────────────────────────────────────────────────────────

  const clear = useCallback(() => {
    const canvas = fabricRef.current
    if (!canvas) return
    canvas.clear()
    historyRef.current = [JSON.stringify(canvas.toJSON())]
  }, [])

  const undo = useCallback(() => {
    const canvas = fabricRef.current
    if (!canvas) return
    const history = historyRef.current
    if (history.length <= 1) return
    history.pop()
    const previous = history[history.length - 1]
    isLoadingRef.current = true
    canvas.loadFromJSON(JSON.parse(previous) as Record<string, unknown>).then(() => {
      canvas.renderAll()
      isLoadingRef.current = false
    })
  }, [])

  const getJSON = useCallback((): Record<string, unknown> => {
    const canvas = fabricRef.current
    if (!canvas) return {}
    return canvas.toJSON() as Record<string, unknown>
  }, [])

  const loadJSON = useCallback((json: Record<string, unknown>) => {
    const canvas = fabricRef.current
    if (!canvas) return
    isLoadingRef.current = true
    canvas.loadFromJSON(json).then(() => {
      canvas.renderAll()
      isLoadingRef.current = false
    })
  }, [])

  return { canvasRef, clear, undo, getJSON, loadJSON }
}
