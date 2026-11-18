import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AssetGrid } from '../asset-grid'
import type { Asset, Folder } from '@/types'

// Mocked for the same reason as in asset-grid-tap-to-open.test.tsx: the real
// store persists to localStorage, which this environment doesn't provide.
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

const assets = [1, 2, 3, 4, 5].map(makeAsset)

const folder = {
  id: 'f1',
  project_id: 'p1',
  parent_id: null,
  name: 'Selects',
  item_count: 0,
  created_at: '2026-01-01T00:00:00Z',
} as unknown as Folder

const folders = [
  folder,
  { ...folder, id: 'f2', name: 'B-roll' } as Folder,
  { ...folder, id: 'f3', name: 'Music' } as Folder,
]

/** The bulk action bar's count, or 0 when it isn't showing. */
function selectedCount(): number {
  const bar = screen.queryByText(/items? selected/i)
  return bar ? parseInt(bar.textContent!, 10) : 0
}

function clip(n: number) {
  return screen.getByText(`Clip ${n}`)
}

function folderNamed(name: string) {
  return screen.getByText(name)
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe.each(['grid', 'list'] as const)('AssetGrid selection shortcuts (%s view)', (layout) => {
  beforeEach(() => {
    mockViewState.layout = layout
  })

  it('shift-click selects every clip between the last clicked one and this one', () => {
    const onAssetSelect = vi.fn()
    render(<AssetGrid assets={assets} projectId="p1" selectionShortcuts onAssetSelect={onAssetSelect} />)

    fireEvent.click(clip(2))
    fireEvent.click(clip(4), { shiftKey: true })

    expect(selectedCount()).toBe(3)
    // The shift-click is not a click on clip 4: the side panel stays on clip 2.
    expect(onAssetSelect).toHaveBeenCalledTimes(1)
  })

  it('shift-click works backwards, too', () => {
    render(<AssetGrid assets={assets} projectId="p1" selectionShortcuts />)

    fireEvent.click(clip(5))
    fireEvent.click(clip(2), { shiftKey: true })

    expect(selectedCount()).toBe(4)
  })

  it('shift-click starts from the clip shown in the side panel when nothing was clicked yet', () => {
    render(<AssetGrid assets={assets} projectId="p1" selectionShortcuts selectedAssetId="a1" />)

    fireEvent.click(clip(3), { shiftKey: true })

    expect(selectedCount()).toBe(3)
  })

  it('shift-click with no starting point selects just that clip', () => {
    render(<AssetGrid assets={assets} projectId="p1" selectionShortcuts />)

    fireEvent.click(clip(3), { shiftKey: true })

    expect(selectedCount()).toBe(1)
  })

  it('⌘-click adds a clip to the selection and removes it again', () => {
    const onAssetSelect = vi.fn()
    render(<AssetGrid assets={assets} projectId="p1" selectionShortcuts onAssetSelect={onAssetSelect} />)

    fireEvent.click(clip(1), { metaKey: true })
    fireEvent.click(clip(4), { metaKey: true })
    expect(selectedCount()).toBe(2)

    fireEvent.click(clip(1), { metaKey: true })
    expect(selectedCount()).toBe(1)
    expect(onAssetSelect).not.toHaveBeenCalled()
  })

  it('a shift-click range starts from the last ⌘-clicked clip and keeps what was already selected', () => {
    render(<AssetGrid assets={assets} projectId="p1" selectionShortcuts />)

    fireEvent.click(clip(1), { metaKey: true })
    fireEvent.click(clip(3), { metaKey: true })
    fireEvent.click(clip(5), { shiftKey: true })

    // 1, plus 3 through 5
    expect(selectedCount()).toBe(4)
  })

  it('Ctrl-click toggles too, for Windows and Linux', () => {
    render(<AssetGrid assets={assets} projectId="p1" selectionShortcuts />)

    fireEvent.click(clip(2), { ctrlKey: true })
    fireEvent.click(clip(3), { ctrlKey: true })

    expect(selectedCount()).toBe(2)
  })

  it('Option-click is an ordinary click', () => {
    const onAssetSelect = vi.fn()
    render(<AssetGrid assets={assets} projectId="p1" selectionShortcuts onAssetSelect={onAssetSelect} />)

    fireEvent.click(clip(2), { altKey: true })

    expect(selectedCount()).toBe(0)
    expect(onAssetSelect).toHaveBeenCalledTimes(1)
  })

  it('Esc deselects everything, including what the page has selected', () => {
    const onDeselectAll = vi.fn()
    render(
      <AssetGrid
        assets={assets}
        projectId="p1"
        folders={[folder]}
        selectionShortcuts
        selectedAssetId="a1"
        onDeselectAll={onDeselectAll}
      />,
    )
    fireEvent.keyDown(document.body, { key: 'a', metaKey: true })
    expect(selectedCount()).toBe(6)

    fireEvent.keyDown(document.body, { key: 'Escape' })

    expect(selectedCount()).toBe(0)
    expect(onDeselectAll).toHaveBeenCalledTimes(1)
  })

  it('Esc with nothing selected leaves the key to whatever else wants it', () => {
    const onDeselectAll = vi.fn()
    render(<AssetGrid assets={assets} projectId="p1" selectionShortcuts onDeselectAll={onDeselectAll} />)

    fireEvent.keyDown(document.body, { key: 'Escape' })

    expect(onDeselectAll).not.toHaveBeenCalled()
  })

  it('Esc in a text field cancels the edit, not the selection', () => {
    const onDeselectAll = vi.fn()
    render(
      <>
        <input aria-label="rename" />
        <AssetGrid assets={assets} projectId="p1" selectionShortcuts selectedAssetId="a1" onDeselectAll={onDeselectAll} />
      </>,
    )
    fireEvent.click(clip(2), { metaKey: true })

    fireEvent.keyDown(screen.getByLabelText('rename'), { key: 'Escape' })

    expect(selectedCount()).toBe(1)
    expect(onDeselectAll).not.toHaveBeenCalled()
  })

  it('a modifier click does not reach the page as a click on empty space', () => {
    const onBackgroundClick = vi.fn()
    render(
      <div onClick={onBackgroundClick}>
        <AssetGrid assets={assets} projectId="p1" selectionShortcuts />
      </div>,
    )

    fireEvent.click(clip(1), { metaKey: true })
    fireEvent.click(clip(2), { shiftKey: true })

    expect(onBackgroundClick).not.toHaveBeenCalled()
  })

  it.each([
    ['⌘-A', { metaKey: true }],
    ['Ctrl-A', { ctrlKey: true }],
  ])('%s selects every clip and folder shown', (_name, mods) => {
    render(<AssetGrid assets={assets} projectId="p1" folders={[folder]} selectionShortcuts />)

    fireEvent.keyDown(document.body, { key: 'a', ...mods })

    expect(selectedCount()).toBe(6)
  })

  it('⌘-A in a text field selects the text, not the clips', () => {
    render(
      <>
        <input aria-label="search" />
        <AssetGrid assets={assets} projectId="p1" selectionShortcuts />
      </>,
    )

    fireEvent.keyDown(screen.getByLabelText('search'), { key: 'a', metaKey: true })

    expect(selectedCount()).toBe(0)
  })

  it('⌘-click adds a folder to the selection and removes it again, without opening it', () => {
    const onFolderOpen = vi.fn()
    render(
      <AssetGrid assets={assets} projectId="p1" folders={folders} selectionShortcuts onFolderOpen={onFolderOpen} />,
    )

    fireEvent.click(folderNamed('Selects'), { metaKey: true })
    fireEvent.click(folderNamed('Music'), { ctrlKey: true })
    expect(selectedCount()).toBe(2)

    fireEvent.click(folderNamed('Selects'), { metaKey: true })
    expect(selectedCount()).toBe(1)
    expect(onFolderOpen).not.toHaveBeenCalled()
  })

  it('shift-click selects a range of folders', () => {
    const onFolderOpen = vi.fn()
    render(
      <AssetGrid assets={assets} projectId="p1" folders={folders} selectionShortcuts onFolderOpen={onFolderOpen} />,
    )

    fireEvent.click(folderNamed('Selects'), { metaKey: true })
    fireEvent.click(folderNamed('Music'), { shiftKey: true })

    expect(selectedCount()).toBe(3)
    expect(onFolderOpen).not.toHaveBeenCalled()
  })

  it('a shift-click range runs from a folder into the clips, in the order shown', () => {
    render(<AssetGrid assets={assets} projectId="p1" folders={folders} selectionShortcuts />)

    fireEvent.click(folderNamed('B-roll'), { metaKey: true })
    fireEvent.click(clip(2), { shiftKey: true })

    // B-roll, Music, Clip 1, Clip 2
    expect(selectedCount()).toBe(4)
  })

  it('a shift-click range runs from a clip back into the folders', () => {
    render(<AssetGrid assets={assets} projectId="p1" folders={folders} selectionShortcuts />)

    fireEvent.click(clip(1))
    fireEvent.click(folderNamed('Music'), { shiftKey: true })

    // Music, Clip 1
    expect(selectedCount()).toBe(2)
  })

  it('a modifier click on a folder does not reach the page as a click on empty space', () => {
    const onBackgroundClick = vi.fn()
    render(
      <div onClick={onBackgroundClick}>
        <AssetGrid assets={assets} projectId="p1" folders={folders} selectionShortcuts />
      </div>,
    )

    fireEvent.click(folderNamed('Selects'), { metaKey: true })
    fireEvent.click(folderNamed('Music'), { shiftKey: true })

    expect(onBackgroundClick).not.toHaveBeenCalled()
  })

  it('does nothing extra where the shortcuts are not turned on', () => {
    const onAssetSelect = vi.fn()
    render(<AssetGrid assets={assets} projectId="p1" onAssetSelect={onAssetSelect} />)

    fireEvent.click(clip(1))
    fireEvent.click(clip(3), { shiftKey: true })
    fireEvent.click(clip(4), { metaKey: true })
    fireEvent.keyDown(document.body, { key: 'a', metaKey: true })
    fireEvent.keyDown(document.body, { key: 'Escape' })

    expect(selectedCount()).toBe(0)
    expect(onAssetSelect).toHaveBeenCalledTimes(3)
  })
})
