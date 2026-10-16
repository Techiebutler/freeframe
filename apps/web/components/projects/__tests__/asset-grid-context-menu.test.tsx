import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AssetGrid } from '../asset-grid'
import type { Asset, Folder } from '@/types'

// Right-click on an asset or a folder opens the same menu as its ⋯ button. On
// an item that is one of several selected, it acts on the whole selection.

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
// FolderCard asks for thumbnails; nothing here needs them.
vi.mock('swr', () => ({ default: () => ({ data: undefined }) }))

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

const assets = [1, 2, 3].map(makeAsset)
const folders = [
  { id: 'f1', project_id: 'p1', parent_id: null, name: 'Selects', item_count: 0, created_at: '2026-01-01T00:00:00Z' },
] as unknown as Folder[]

const ASSET_ITEMS = ['Create Share Link', 'Download', 'Copy Asset URL', 'Rename', 'Delete']
const FOLDER_ITEMS = ['Create Share Link', 'New Subfolder', 'Rename', 'Delete']

function renderGrid() {
  const h = {
    onAssetShare: vi.fn(),
    onAssetDownload: vi.fn(),
    onAssetRename: vi.fn(),
    onAssetDelete: vi.fn(),
    onFolderShare: vi.fn(async () => {}),
    onFolderNewSubfolder: vi.fn(),
    onFolderRename: vi.fn(async () => {}),
    onFolderDelete: vi.fn(async () => {}),
    onBulkDelete: vi.fn(),
    onBulkDownload: vi.fn(),
    onBulkMove: vi.fn(),
    onCreateShareLink: vi.fn(),
  }
  render(<AssetGrid assets={assets} folders={folders} projectId="p1" selectionShortcuts {...h} />)
  return h
}

const user = () => userEvent.setup({ pointerEventsCheck: 0 })

async function menuItems() {
  return (await screen.findAllByRole('menuitem')).map((i) => i.textContent)
}

async function closeMenu() {
  await user().keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
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

describe.each(['grid', 'list'] as const)('AssetGrid right-click (%s view)', (layout) => {
  beforeEach(() => {
    mockViewState.layout = layout
  })

  it('shows the asset menu, the same as ⋯', async () => {
    const h = renderGrid()
    fireEvent.contextMenu(screen.getByText('Clip 2'))
    expect(await menuItems()).toEqual(ASSET_ITEMS)

    await user().click(screen.getByRole('menuitem', { name: 'Rename' }))
    expect(h.onAssetRename).toHaveBeenCalledWith(assets[1])

    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    await user().click(screen.getByRole('button', { name: 'Clip 2 menu' }))
    expect(await menuItems()).toEqual(ASSET_ITEMS)
  })

  it('does not select or open the asset', async () => {
    const onAssetSelect = vi.fn()
    const onAssetOpen = vi.fn()
    render(<AssetGrid assets={assets} projectId="p1" onAssetSelect={onAssetSelect} onAssetOpen={onAssetOpen} />)
    fireEvent.contextMenu(screen.getByText('Clip 1'))
    await screen.findByRole('menu')
    expect(onAssetSelect).not.toHaveBeenCalled()
    expect(onAssetOpen).not.toHaveBeenCalled()
  })

  it('shows the folder menu, with New Subfolder and Share', async () => {
    const h = renderGrid()
    fireEvent.contextMenu(screen.getByText('Selects'))
    expect(await menuItems()).toEqual(FOLDER_ITEMS)

    await user().click(screen.getByRole('menuitem', { name: 'New Subfolder' }))
    expect(h.onFolderNewSubfolder).toHaveBeenCalledWith('f1')
  })

  it('renames a folder through a dialog, with the new name', async () => {
    // The list row's Rename used to send the folder's current name back, so
    // it changed nothing.
    const h = renderGrid()
    fireEvent.contextMenu(screen.getByText('Selects'))
    await user().click(await screen.findByRole('menuitem', { name: 'Rename' }))

    const dialog = await screen.findByRole('dialog')
    const input = within(dialog).getByRole('textbox')
    await user().clear(input)
    await user().type(input, 'Picks{Enter}')

    await waitFor(() => expect(h.onFolderRename).toHaveBeenCalledWith('f1', 'Picks'))
  })

  it('asks before deleting a folder', async () => {
    // The list row's Delete used to delete at once.
    const h = renderGrid()
    fireEvent.contextMenu(screen.getByText('Selects'))
    await user().click(await screen.findByRole('menuitem', { name: 'Delete' }))

    const dialog = await screen.findByRole('dialog')
    expect(h.onFolderDelete).not.toHaveBeenCalled()
    await user().click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(h.onFolderDelete).toHaveBeenCalledWith('f1'))
  })

  it('acts on the whole selection when the item is one of several selected', async () => {
    const h = renderGrid()
    fireEvent.click(screen.getByText('Clip 1'), { metaKey: true })
    fireEvent.click(screen.getByText('Clip 3'), { metaKey: true })
    fireEvent.click(screen.getByText('Selects'), { metaKey: true })

    fireEvent.contextMenu(screen.getByText('Clip 3'))
    expect(await screen.findByText('3 items selected')).toBeTruthy()
    expect(await menuItems()).toEqual(['Create Share Link', 'Download', 'Move to…', 'Delete'])

    await user().click(screen.getByRole('menuitem', { name: 'Delete' }))
    expect(h.onBulkDelete).toHaveBeenCalledWith(['a1', 'a3'], ['f1'])
    expect(h.onAssetDelete).not.toHaveBeenCalled()
  })

  it('a selected folder gets the selection menu too', async () => {
    renderGrid()
    fireEvent.click(screen.getByText('Clip 1'), { metaKey: true })
    fireEvent.click(screen.getByText('Selects'), { metaKey: true })

    fireEvent.contextMenu(screen.getByText('Selects'))
    expect(await screen.findByText('2 items selected')).toBeTruthy()
  })

  it('an item outside the selection gets its own menu', async () => {
    renderGrid()
    fireEvent.click(screen.getByText('Clip 1'), { metaKey: true })
    fireEvent.click(screen.getByText('Clip 3'), { metaKey: true })

    fireEvent.contextMenu(screen.getByText('Clip 2'))
    expect(await menuItems()).toEqual(ASSET_ITEMS)
    await closeMenu()
  })

  it('a single selected item gets its own menu', async () => {
    renderGrid()
    fireEvent.click(screen.getByText('Clip 1'), { metaKey: true })

    fireEvent.contextMenu(screen.getByText('Clip 1'))
    expect(await menuItems()).toEqual(ASSET_ITEMS)
  })
})
