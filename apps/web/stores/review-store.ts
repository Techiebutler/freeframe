import { create } from 'zustand'
import { Asset, AssetVersion } from '@/types'

type DrawingTool = 'pen' | 'rectangle' | 'arrow' | 'text' | 'eraser'

interface ReviewState {
  currentAsset: Asset | null
  currentVersion: AssetVersion | null
  playheadTime: number
  isDrawingMode: boolean
  drawingTool: DrawingTool
  drawingColor: string
  brushSize: number
  setCurrentAsset: (asset: Asset) => void
  setCurrentVersion: (version: AssetVersion) => void
  setPlayheadTime: (time: number) => void
  toggleDrawingMode: () => void
  setDrawingTool: (tool: DrawingTool) => void
  setDrawingColor: (color: string) => void
  setBrushSize: (size: number) => void
  reset: () => void
}

const initialState = {
  currentAsset: null,
  currentVersion: null,
  playheadTime: 0,
  isDrawingMode: false,
  drawingTool: 'pen' as DrawingTool,
  drawingColor: '#FF3B30',
  brushSize: 4,
}

export const useReviewStore = create<ReviewState>()((set) => ({
  ...initialState,

  setCurrentAsset: (asset: Asset) => {
    set({ currentAsset: asset })
  },

  setCurrentVersion: (version: AssetVersion) => {
    set({ currentVersion: version })
  },

  setPlayheadTime: (time: number) => {
    set({ playheadTime: time })
  },

  toggleDrawingMode: () => {
    set((state) => ({ isDrawingMode: !state.isDrawingMode }))
  },

  setDrawingTool: (tool: DrawingTool) => {
    set({ drawingTool: tool })
  },

  setDrawingColor: (color: string) => {
    set({ drawingColor: color })
  },

  setBrushSize: (size: number) => {
    set({ brushSize: size })
  },

  reset: () => {
    set(initialState)
  },
}))
