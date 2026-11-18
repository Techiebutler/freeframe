import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AssetGrid } from '../asset-grid'
import type { Asset } from '@/types'

// AssetGrid reads layout (and several cosmetic settings) from useViewStore,
// which persists to localStorage — this test environment doesn't provide a
// working one (a known, pre-existing gap; see the ~30 unrelated failures
// elsewhere in this suite for the same root cause), and the persist
// middleware resolves its storage engine at module-import time, before any
// per-test stubbing could take effect anyway. Mocking the store module
// entirely sidesteps both problems and keeps this test about the actual
// regression (click routing), not view-store's persistence.
const mockViewState = vi.hoisted(() => ({ layout: 'grid' as 'grid' | 'list' }))
vi.mock('@/stores/view-store', () => ({
  useViewStore: () => ({
    layout: mockViewState.layout,
    cardSize: 'M',
    aspectRatio: 'landscape',
    thumbnailScale: 'fill',
    showCardInfo: true,
    titleLines: '2',
    flattenFolders: false,
    showFileSize: true,
    showUploader: true,
    sortKey: 'custom',
    sortDirection: 'asc',
  }),
}))

const asset: Asset = {
  id: 'a1',
  project_id: 'p1',
  name: 'Test asset',
  description: null,
  asset_type: 'video',
  status: 'in_review',
  rating: null,
  assignee_id: null,
  folder_id: null,
  due_date: null,
  keywords: [],
  created_by: 'u1',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  deleted_at: null,
}

function setCoarsePointer(isCoarse: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(pointer: coarse)' ? isCoarse : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
}

describe('AssetGrid single-tap-to-open on touch', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('grid view', () => {
    beforeEach(() => {
      mockViewState.layout = 'grid'
    })

    it('a single click opens the asset directly on a coarse (touch) pointer', () => {
      setCoarsePointer(true)
      const onAssetSelect = vi.fn()
      const onAssetOpen = vi.fn()
      render(
        <AssetGrid assets={[asset]} projectId="p1" onAssetSelect={onAssetSelect} onAssetOpen={onAssetOpen} />,
      )
      fireEvent.click(screen.getByText('Test asset'))
      expect(onAssetOpen).toHaveBeenCalledWith(asset)
      expect(onAssetSelect).not.toHaveBeenCalled()
    })

    it('a single click only selects on a fine (mouse) pointer — desktop unchanged', () => {
      setCoarsePointer(false)
      const onAssetSelect = vi.fn()
      const onAssetOpen = vi.fn()
      render(
        <AssetGrid assets={[asset]} projectId="p1" onAssetSelect={onAssetSelect} onAssetOpen={onAssetOpen} />,
      )
      fireEvent.click(screen.getByText('Test asset'))
      expect(onAssetSelect).toHaveBeenCalled()
      expect(onAssetOpen).not.toHaveBeenCalled()
    })

    it('double-click still opens regardless of pointer type', () => {
      setCoarsePointer(false)
      const onAssetOpen = vi.fn()
      render(<AssetGrid assets={[asset]} projectId="p1" onAssetOpen={onAssetOpen} />)
      fireEvent.doubleClick(screen.getByText('Test asset'))
      expect(onAssetOpen).toHaveBeenCalledWith(asset)
    })
  })

  describe('list view', () => {
    beforeEach(() => {
      mockViewState.layout = 'list'
    })

    it('a single click opens the asset directly on a coarse (touch) pointer', () => {
      setCoarsePointer(true)
      const onAssetSelect = vi.fn()
      const onAssetOpen = vi.fn()
      render(
        <AssetGrid assets={[asset]} projectId="p1" onAssetSelect={onAssetSelect} onAssetOpen={onAssetOpen} />,
      )
      fireEvent.click(screen.getByText('Test asset'))
      expect(onAssetOpen).toHaveBeenCalledWith(asset)
      expect(onAssetSelect).not.toHaveBeenCalled()
    })

    it('a single click only selects on a fine (mouse) pointer — desktop unchanged', () => {
      setCoarsePointer(false)
      const onAssetSelect = vi.fn()
      const onAssetOpen = vi.fn()
      render(
        <AssetGrid assets={[asset]} projectId="p1" onAssetSelect={onAssetSelect} onAssetOpen={onAssetOpen} />,
      )
      fireEvent.click(screen.getByText('Test asset'))
      expect(onAssetSelect).toHaveBeenCalled()
      expect(onAssetOpen).not.toHaveBeenCalled()
    })
  })
})
