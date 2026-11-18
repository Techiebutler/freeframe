import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AssetGrid } from '../asset-grid'
import { CommentCountBadge } from '@/components/shared/comment-count-badge'
import type { Asset } from '@/types'

// Thumbnails in the project grid show their comment count, with the same badge
// a share link's grid uses.

const mockViewState = vi.hoisted(() => ({ showCardInfo: true }))
vi.mock('@/stores/view-store', () => ({
  useViewStore: () => ({
    layout: 'grid',
    cardSize: 'M',
    aspectRatio: 'landscape',
    thumbnailScale: 'fill',
    showCardInfo: mockViewState.showCardInfo,
    titleLines: '2',
    flattenFolders: false,
    showFileSize: true,
    showUploader: true,
    sortKey: 'custom',
    sortDirection: 'asc',
  }),
}))

function makeAsset(n: number, comment_count?: number): Asset {
  return {
    id: `a${n}`,
    project_id: 'p1',
    name: `Clip ${n}`,
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
    comment_count,
  }
}

beforeEach(() => {
  mockViewState.showCardInfo = true
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('comment count on project thumbnails', () => {
  it('shows each asset’s count', () => {
    render(<AssetGrid assets={[makeAsset(1, 3), makeAsset(2, 1)]} projectId="p1" />)
    expect(screen.getByTitle('3 comments').textContent).toBe('3')
    expect(screen.getByTitle('1 comment').textContent).toBe('1')
  })

  it('shows nothing for an asset without comments', () => {
    render(<AssetGrid assets={[makeAsset(1, 0), makeAsset(2)]} projectId="p1" />)
    expect(screen.queryByTitle(/comments?$/)).toBeNull()
  })

  it('is on the thumbnail, so it shows with the info row hidden too', () => {
    mockViewState.showCardInfo = false
    render(<AssetGrid assets={[makeAsset(1, 2)]} projectId="p1" />)
    expect(screen.getByTitle('2 comments')).toBeTruthy()
  })

  it('is the badge the share grid uses', () => {
    const { container: grid } = render(<AssetGrid assets={[makeAsset(1, 5)]} projectId="p1" />)
    const { container: badge } = render(<CommentCountBadge count={5} />)
    expect(grid.querySelector('[title="5 comments"]')!.outerHTML).toBe(badge.firstElementChild!.outerHTML)
  })
})
