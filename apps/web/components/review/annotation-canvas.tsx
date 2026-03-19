'use client'

import React, { useCallback, useEffect, useRef } from 'react'
import {
  Eraser,
  Minus,
  MousePointer,
  Pencil,
  Plus,
  RotateCcw,
  Square,
  Trash2,
  Type,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useReviewStore } from '@/stores/review-store'
import { useDrawing } from '@/hooks/use-drawing'

// ─── Types ────────────────────────────────────────────────────────────────────

interface AnnotationCanvasProps {
  /** Called when the user presses "Done" — receives the serialized Fabric.js JSON */
  onSave?: (drawingData: Record<string, unknown>) => void
  className?: string
}

// ─── Constants ────────────────────────────────────────────────────────────────

type DrawingTool = 'pen' | 'rectangle' | 'arrow' | 'text' | 'eraser'

const TOOLS: { id: DrawingTool; icon: React.ReactNode; label: string }[] = [
  { id: 'pen', icon: <Pencil className="w-4 h-4" />, label: 'Pen' },
  { id: 'rectangle', icon: <Square className="w-4 h-4" />, label: 'Rectangle' },
  { id: 'arrow', icon: <MousePointer className="w-4 h-4" />, label: 'Arrow' },
  { id: 'text', icon: <Type className="w-4 h-4" />, label: 'Text' },
  { id: 'eraser', icon: <Eraser className="w-4 h-4" />, label: 'Eraser' },
]

const PRESET_COLORS = [
  '#FF3B30', // red
  '#FF9500', // orange
  '#FFCC00', // yellow
  '#34C759', // green
  '#007AFF', // blue
  '#AF52DE', // purple
  '#FFFFFF', // white
  '#000000', // black
]

// ─── Component ────────────────────────────────────────────────────────────────

export function AnnotationCanvas({ onSave, className }: AnnotationCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  const {
    isDrawingMode,
    drawingTool,
    drawingColor,
    brushSize,
    setDrawingTool,
    setDrawingColor,
    setBrushSize,
  } = useReviewStore()

  const { canvasRef, clear, undo, getJSON } = useDrawing()

  // Sync canvas element size to its container
  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return

    const sync = () => {
      const { width, height } = container.getBoundingClientRect()
      // fabric Canvas handles responsive resizing via setDimensions — but since
      // we expose the raw <canvas> element, we set HTML attributes directly and
      // let fabric pick them up on init.
      canvas.width = Math.floor(width)
      canvas.height = Math.floor(height)
    }

    sync()

    const ro = new ResizeObserver(sync)
    ro.observe(container)
    return () => ro.disconnect()
  }, [canvasRef])

  const handleSave = useCallback(() => {
    const json = getJSON()
    onSave?.(json)
  }, [getJSON, onSave])

  if (!isDrawingMode) return null

  return (
    <div
      ref={containerRef}
      className={cn('absolute inset-0 z-10 flex flex-col', className)}
    >
      {/* Fabric canvas — fills the parent completely */}
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />

      {/* Toolbar — rendered above the canvas */}
      <div className="relative z-20 flex items-center gap-2 px-3 py-2 bg-black/70 backdrop-blur-sm pointer-events-auto">
        {/* Drawing tools */}
        <div className="flex items-center gap-1">
          {TOOLS.map((tool) => (
            <button
              key={tool.id}
              onClick={() => setDrawingTool(tool.id as 'pen' | 'rectangle' | 'arrow' | 'text')}
              title={tool.label}
              className={cn(
                'p-1.5 rounded transition-colors',
                drawingTool === tool.id
                  ? 'bg-blue-600 text-white'
                  : 'text-white/70 hover:bg-white/10 hover:text-white',
              )}
            >
              {tool.icon}
            </button>
          ))}
        </div>

        <div className="w-px h-5 bg-white/20 mx-1" />

        {/* Color presets */}
        <div className="flex items-center gap-1">
          {PRESET_COLORS.map((color) => (
            <button
              key={color}
              onClick={() => setDrawingColor(color)}
              title={color}
              className={cn(
                'w-5 h-5 rounded-full border-2 transition-transform',
                drawingColor === color
                  ? 'border-white scale-110'
                  : 'border-transparent hover:scale-105',
              )}
              style={{ backgroundColor: color }}
            />
          ))}
          {/* Custom color picker */}
          <input
            type="color"
            value={drawingColor}
            onChange={(e) => setDrawingColor(e.target.value)}
            className="w-5 h-5 rounded cursor-pointer border-0 bg-transparent"
            title="Custom color"
          />
        </div>

        <div className="w-px h-5 bg-white/20 mx-1" />

        {/* Brush size */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => setBrushSize(Math.max(1, brushSize - 2))}
            className="p-1 text-white/70 hover:text-white rounded hover:bg-white/10"
            aria-label="Decrease brush size"
          >
            <Minus className="w-3 h-3" />
          </button>
          <span className="text-white text-xs w-5 text-center tabular-nums">{brushSize}</span>
          <button
            onClick={() => setBrushSize(Math.min(50, brushSize + 2))}
            className="p-1 text-white/70 hover:text-white rounded hover:bg-white/10"
            aria-label="Increase brush size"
          >
            <Plus className="w-3 h-3" />
          </button>
        </div>

        <div className="w-px h-5 bg-white/20 mx-1" />

        {/* Undo & Clear */}
        <button
          onClick={undo}
          className="p-1.5 text-white/70 hover:text-white rounded hover:bg-white/10 transition-colors"
          title="Undo"
        >
          <RotateCcw className="w-4 h-4" />
        </button>
        <button
          onClick={clear}
          className="p-1.5 text-white/70 hover:text-red-400 rounded hover:bg-white/10 transition-colors"
          title="Clear canvas"
        >
          <Trash2 className="w-4 h-4" />
        </button>

        <div className="flex-1" />

        {/* Done */}
        <button
          onClick={handleSave}
          className="px-3 py-1 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors"
        >
          Done
        </button>
      </div>
    </div>
  )
}
