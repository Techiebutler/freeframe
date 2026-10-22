/**
 * A share link used to land with the right-hand comments pane open on desktop,
 * so the first thing a guest saw was a "Select an asset to view comments"
 * placeholder eating a third of the grid. The pane now belongs to the asset
 * viewer: the folder grid starts closed (the header toggle still opens it), and
 * the review screen opens its own sidebar as it always has.
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

describe('the share-link folder grid', () => {
  beforeEach(stubDesktop)
  afterEach(() => { vi.unstubAllGlobals() })

  it('loads with the comments pane closed on a desktop viewport', async () => {
    renderViewer()

    await waitFor(() => expect(screen.getByText('Clip.mp4')).toBeInTheDocument())
    expect(screen.queryByText('Select an asset to view comments')).toBeNull()
    // The toggle advertises the action available, not the state you are in.
    expect(screen.getByTitle('Show panel')).toBeInTheDocument()
    expect(screen.queryByTitle('Hide panel')).toBeNull()
  })

  it('opens the pane from the header toggle', async () => {
    renderViewer()

    await waitFor(() => expect(screen.getByText('Clip.mp4')).toBeInTheDocument())
    fireEvent.click(screen.getByTitle('Show panel'))

    expect(await screen.findByText('Select an asset to view comments')).toBeInTheDocument()
  })

  it('opens the comments pane once the viewer is entered, with no extra click', async () => {
    renderViewer()

    await waitFor(() => expect(screen.getByText('Clip.mp4')).toBeInTheDocument())
    fireEvent.doubleClick(screen.getByText('Clip.mp4'))

    // The tabs live in the review screen's sidebar, so they only show if that
    // sidebar came up open.
    await waitFor(() => expect(screen.getByText('Fields')).toBeInTheDocument(), { timeout: 3000 })
    expect(screen.getByText('Comments')).toBeInTheDocument()
  })
})
