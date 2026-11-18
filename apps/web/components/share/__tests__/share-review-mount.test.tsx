import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { FolderShareViewer } from '../folder-share-viewer'
import { useBrandingStore, HARDCODED_DEFAULTS } from '@/stores/branding-store'

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

  it('opens an asset with one touch on mobile', async () => {
    render(
      <FolderShareViewer
        token="t" folderName="F" title="T" description={null}
        permission="comment" allowDownload={false} showVersions={false}
        appearance={{ open_in_viewer: true } as never} branding={null}
      />,
    )

    const assetName = await screen.findByText('Clip.mp4')
    fireEvent.pointerUp(assetName, { pointerType: 'touch' })

    await waitFor(() => expect(screen.getByText('Fields')).toBeInTheDocument(), { timeout: 3000 })
  })

  it('scopes the share appearance without changing the dashboard theme', async () => {
    document.documentElement.setAttribute('data-theme', 'dark')
    document.documentElement.style.setProperty('--accent', '#5b8def')

    const { container, rerender } = render(
      <FolderShareViewer
        embedded token="t" folderName="F" title="T" description={null}
        permission="view" allowDownload={false} showVersions={false}
        appearance={{ theme: 'light', accent_color: '#e11d48' } as never} branding={null}
      />,
    )

    await screen.findByText('Clip.mp4')
    const preview = container.firstElementChild as HTMLElement
    expect(preview).toHaveAttribute('data-theme', 'light')
    expect(preview.style.getPropertyValue('--accent')).toBe('#e11d48')
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#5b8def')

    rerender(
      <FolderShareViewer
        embedded token="t" folderName="F" title="T" description={null}
        permission="view" allowDownload={false} showVersions={false}
        appearance={{ theme: 'dark', accent_color: '#14b8a6' } as never} branding={null}
      />,
    )

    expect(preview).toHaveAttribute('data-theme', 'dark')
    expect(preview.style.getPropertyValue('--accent')).toBe('#14b8a6')
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#5b8def')
  })

  it('uses global branding only when the share has no project branding', async () => {
    useBrandingStore.setState({ ...HARDCODED_DEFAULTS, orgName: 'Instance Brand', orgLogoDark: 'https://cdn.test/global-dark.png', loaded: true, loading: false })
    const { container } = render(<FolderShareViewer token="t" folderName="F" title="T" description={null} permission="view" allowDownload={false} showVersions={false} appearance={{ theme: 'dark' } as never} branding={null} />)
    await screen.findByText('Clip.mp4')
    expect(container.querySelector('img[src="https://cdn.test/global-dark.png"]')).toBeInTheDocument()
    useBrandingStore.setState({ ...HARDCODED_DEFAULTS, loaded: false, loading: false })
  })

  it('allows inline title and description editing only when embedded for configuration', async () => {
    const onTitleCommit = vi.fn()
    const onDescriptionCommit = vi.fn()

    render(
      <FolderShareViewer
        embedded editableHeader token="t" folderName="F" title="T" description={null}
        permission="view" allowDownload={false} showVersions={false}
        appearance={{ open_in_viewer: true } as never} branding={null}
        onTitleCommit={onTitleCommit}
        onDescriptionCommit={onDescriptionCommit}
      />,
    )

    fireEvent.click(screen.getByRole('heading', { name: 'T' }))
    const titleInput = screen.getByLabelText('Share link title')
    fireEvent.change(titleInput, { target: { value: 'New title' } })
    fireEvent.blur(titleInput)
    expect(onTitleCommit).toHaveBeenCalledWith('New title')

    fireEvent.click(screen.getByText('Add a description…'))
    const descriptionInput = screen.getByLabelText('Share link description')
    fireEvent.change(descriptionInput, { target: { value: 'New description' } })
    fireEvent.blur(descriptionInput)
    expect(onDescriptionCommit).toHaveBeenCalledWith('New description')
  })

  // An internal comment is team-only: the share listing never returns one and
  // the API refuses one from a caller without access to the asset. So the share
  // composer offers no Public / Internal choice, guest or signed in.
  it('gives the share composer no visibility toggle', async () => {
    render(
      <FolderShareViewer
        token="t" folderName="F" title="T" description={null}
        permission="comment" allowDownload={false} showVersions={false}
        appearance={{ open_in_viewer: true } as never} branding={null}
      />,
    )

    await waitFor(() => expect(screen.getByText('Clip.mp4')).toBeInTheDocument())
    fireEvent.doubleClick(screen.getByText('Clip.mp4'))

    await waitFor(() => expect(screen.getAllByPlaceholderText('Leave your comment...').length).toBeGreaterThan(0), { timeout: 3000 })
    expect(screen.queryByRole('button', { name: 'Public' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Internal' })).toBeNull()
  })
})
