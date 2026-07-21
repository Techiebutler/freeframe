import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { FolderShareViewer } from '../folder-share-viewer'

// Regression for #192: ShareReviewInner used to resolve its hooks with bare
// CommonJS require('@/...') calls. Node's loader does not understand the '@'
// alias from vitest.config.ts, so the subtree threw "Cannot find module" the
// moment a guest opened an asset — making the whole share-review UI untestable.
describe('folder share — opening an asset mounts the review UI (#192)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        assets: [{ id: 'a1', name: 'Clip.mp4', asset_type: 'video', latest_version_id: 'v1', thumbnail_url: null, status: 'ready' }],
        subfolders: [],
        total: 1,
      }),
    })) as unknown as typeof fetch)
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    // jsdom has no matchMedia (#188); the panel default reads it during render.
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: true, media: query, onchange: null,
      addEventListener() {}, removeEventListener() {},
      addListener() {}, removeListener() {}, dispatchEvent: () => false,
    }))
  })

  afterEach(() => { vi.unstubAllGlobals() })

  it('renders the review panel tabs after double-clicking an asset', async () => {
    render(
      <FolderShareViewer
        token="t" folderName="F" title="T" description={null}
        permission="comment" allowDownload={false} showVersions={false}
        appearance={{ open_in_viewer: true } as never} branding={null}
      />,
    )

    await waitFor(() => expect(screen.getByText('Clip.mp4')).toBeInTheDocument())
    fireEvent.doubleClick(screen.getByText('Clip.mp4'))

    // These tabs live inside ShareReviewInner, so they only appear if that
    // subtree mounted — i.e. if its hook imports resolved.
    await waitFor(() => expect(screen.getByText('Fields')).toBeInTheDocument(), { timeout: 3000 })
    expect(screen.getByText('Comments')).toBeInTheDocument()
  })
})
