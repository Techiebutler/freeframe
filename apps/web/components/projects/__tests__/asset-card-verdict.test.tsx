import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AssetGrid } from '../asset-grid'
import type { Asset, VerdictSummary } from '@/types'

// A thumbnail in the project grid carries the verdicts on the asset's latest
// version: a small coloured badge, from the listing's `verdict_summary`.

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

const counts = (overrides: Partial<VerdictSummary> = {}): VerdictSummary => ({
  approved: 0,
  changes_requested: 0,
  rejected: 0,
  ...overrides,
})

function makeAsset(n: number, verdict_summary?: VerdictSummary | null): Asset {
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
    verdict_summary,
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

describe('verdict badge on project thumbnails', () => {
  it('shows a red badge, labelled with its count, for a rejection', () => {
    render(
      <AssetGrid
        assets={[makeAsset(1, counts({ rejected: 1 }))]}
        projectId="p1"
      />,
    )
    const badge = screen.getByRole('img', { name: '1 verdict, rejected' })
    expect(badge.textContent).toBe('1')
    expect(badge.getAttribute('data-tone')).toBe('rejected')
  })

  it('counts every verdict and takes the most serious one’s colour', () => {
    render(
      <AssetGrid
        assets={[makeAsset(1, counts({ approved: 2, changes_requested: 1 }))]}
        projectId="p1"
      />,
    )
    const badge = screen.getByRole('img', { name: '3 verdicts, changes needed' })
    expect(badge.textContent).toBe('3')
    expect(badge.getAttribute('data-tone')).toBe('changes')
  })

  it('gives each asset its own badge', () => {
    render(
      <AssetGrid
        assets={[
          makeAsset(1, counts({ approved: 1 })),
          makeAsset(2, counts({ rejected: 2 })),
        ]}
        projectId="p1"
      />,
    )
    expect(screen.getByRole('img', { name: '1 verdict, approved' }).getAttribute('data-tone')).toBe('approved')
    expect(screen.getByRole('img', { name: '2 verdicts, rejected' }).getAttribute('data-tone')).toBe('rejected')
  })

  it('shows nothing for an asset with no summary', () => {
    render(<AssetGrid assets={[makeAsset(1), makeAsset(2, null)]} projectId="p1" />)
    expect(screen.queryByRole('img', { name: /verdicts?$/ })).toBeNull()
  })

  it('shows nothing, not an empty pill, when every count is zero', () => {
    const { container } = render(
      <AssetGrid assets={[makeAsset(1, counts())]} projectId="p1" />,
    )
    expect(screen.queryByRole('img', { name: /verdicts?$/ })).toBeNull()
    expect(container.querySelector('[data-testid="card-verdict"]')).toBeNull()
  })

  it('is on the thumbnail, so it shows with the info row hidden too', () => {
    mockViewState.showCardInfo = false
    render(
      <AssetGrid
        assets={[makeAsset(1, counts({ approved: 1 }))]}
        projectId="p1"
      />,
    )
    expect(screen.getByRole('img', { name: '1 verdict, approved' })).toBeTruthy()
  })

  it('sits in the thumbnail’s free corner, clear of the comment count', () => {
    const asset = { ...makeAsset(1, counts({ approved: 1 })), comment_count: 4 }
    render(<AssetGrid assets={[asset]} projectId="p1" />)
    const comments = screen.getByTitle('4 comments')
    const pill = screen.getByTestId('card-verdict')
    expect(pill.contains(screen.getByRole('img', { name: '1 verdict, approved' }))).toBe(true)
    expect(pill.parentElement).toBe(comments.parentElement)
    // Top-right: the other three corners hold the checkbox, the comment count
    // and the duration.
    expect(pill.className).toContain('top-2')
    expect(pill.className).toContain('right-2')
  })
})
