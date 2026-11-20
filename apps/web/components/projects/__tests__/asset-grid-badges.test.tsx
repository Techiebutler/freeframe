import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AssetGrid } from '../asset-grid'
import { DurationBadge, VersionCountBadge } from '@/components/shared/asset-thumbnail-badges'
import type { Asset } from '@/types'

// Thumbnails in the project grid show a version chip and a duration chip, with
// the same badges a share link's grid uses.

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

function makeAsset(n: number): Asset {
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

describe('version and duration chips on project thumbnails', () => {
  it('shows the version once an asset has been revised', () => {
    render(<AssetGrid assets={[makeAsset(1)]} projectId="p1" versionCounts={{ a1: 3 }} />)
    expect(screen.getByTitle('Version 3').textContent).toBe('3')
  })

  it('shows no chip for a first version or an asset without versions', () => {
    render(
      <AssetGrid
        assets={[makeAsset(1), makeAsset(2)]}
        projectId="p1"
        versionCounts={{ a1: 1 }}
      />,
    )
    expect(screen.queryByTitle(/^Version/)).toBeNull()
  })

  it('shows the duration of the latest version', () => {
    render(<AssetGrid assets={[makeAsset(1), makeAsset(2)]} projectId="p1" durations={{ a1: 30, a2: 3725 }} />)
    expect(screen.getByText('00:30')).toBeTruthy()
    expect(screen.getByText('1:02:05')).toBeTruthy()
  })

  it('shows no duration for an image or an unknown length', () => {
    render(<AssetGrid assets={[makeAsset(1), makeAsset(2)]} projectId="p1" durations={{ a2: 0 }} />)
    expect(screen.queryByText(/^\d{1,2}:\d{2}/)).toBeNull()
  })

  it('are the badges the share grid uses', () => {
    const { container: grid } = render(
      <AssetGrid assets={[makeAsset(1)]} projectId="p1" versionCounts={{ a1: 2 }} durations={{ a1: 90 }} />,
    )
    const { container: version } = render(<VersionCountBadge count={2} title="Version 2" className="left-9" />)
    const { container: duration } = render(<DurationBadge seconds={90} />)
    expect(grid.querySelector('[title="Version 2"]')!.outerHTML).toBe(version.firstElementChild!.outerHTML)
    expect(grid.innerHTML).toContain(duration.firstElementChild!.outerHTML)
  })
})
