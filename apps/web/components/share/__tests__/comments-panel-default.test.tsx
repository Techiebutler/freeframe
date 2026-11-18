/**
 * A share link's folder grid used to load with the right-hand comments pane
 * open on a desktop screen, so the first thing a visitor saw was an empty
 * "Select an asset to view comments" placeholder. The grid now starts closed;
 * an asset — a single-asset link, or one opened out of the grid — still opens
 * on its comments, which is what that pane is for.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { FolderShareViewer } from '../folder-share-viewer'

const ASSET = {
  id: 'a1', name: 'Clip.mp4', asset_type: 'video', latest_version_id: 'v1',
  thumbnail_url: null, status: 'ready',
}

function stubDesktop() {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ assets: [ASSET], subfolders: [], total: 1 }),
  })) as unknown as typeof fetch)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  // jsdom has no matchMedia (#188). matches:true is a desktop viewport — the
  // case that used to open the pane on load.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: true, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, dispatchEvent: () => false,
  }))
}

function renderViewer() {
  return render(
    <FolderShareViewer
      token="t" folderName="F" title="T" description={null}
      permission="comment" allowDownload={false} showVersions={false}
      appearance={{ open_in_viewer: true } as never} branding={null}
    />,
  )
}

describe('the share-link comments pane', () => {
  beforeEach(stubDesktop)
  afterEach(() => { vi.unstubAllGlobals() })

  it('loads the folder grid closed', async () => {
    renderViewer()

    await waitFor(() => expect(screen.getByText('Clip.mp4')).toBeInTheDocument())
    expect(screen.queryByText('Select an asset to view comments')).toBeNull()
    // The toggle advertises the action available, not the state you are in.
    expect(screen.getByTitle('Show panel')).toBeInTheDocument()
    expect(screen.queryByTitle('Hide panel')).toBeNull()
  })

  it('opens the folder grid panel from the header toggle', async () => {
    renderViewer()

    await waitFor(() => expect(screen.getByText('Clip.mp4')).toBeInTheDocument())
    fireEvent.click(screen.getByTitle('Show panel'))

    expect(await screen.findByText('Select an asset to view comments')).toBeInTheDocument()
  })

  it('opens an asset on its comments, with no click in between', async () => {
    renderViewer()

    await waitFor(() => expect(screen.getByText('Clip.mp4')).toBeInTheDocument())
    fireEvent.doubleClick(screen.getByText('Clip.mp4'))

    // The grid unmounts (its search box goes) and the review screen's own top
    // bar lands, already showing the panel. The tabs live in that sidebar.
    await waitFor(() => {
      expect(screen.queryByPlaceholderText('Search assets…')).toBeNull()
      expect(screen.getByTitle('Hide panel')).toBeInTheDocument()
    }, { timeout: 3000 })
    await waitFor(() => expect(screen.getByText('Fields')).toBeInTheDocument(), { timeout: 3000 })
    expect(screen.getByText('Comments')).toBeInTheDocument()
  })
})
