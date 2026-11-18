import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ShareReviewScreen } from '../share-review-screen'
import { FolderShareViewer } from '../folder-share-viewer'
import { useBrandingStore, HARDCODED_DEFAULTS, type BrandingValues } from '@/stores/branding-store'
import { useThemeStore } from '@/stores/theme-store'

// Branding is seeded straight into the store; only the fetch the provider would
// otherwise start is stubbed out.
vi.mock('@/components/shared/branding-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/shared/branding-provider')>()),
  useEnsureBranding: () => {},
}))

import SharePage from '@/app/share/[token]/page'

// #308: a share link's asset view showed no instance branding on either path.
// The single-asset path lost it when #307 moved that path onto
// ShareReviewScreen, whose header (back, asset name, versions, download, panel
// toggle) never had a logo. The folder grid's own logo branch read
// `branding.logo_url`, which the share API never sends for a folder link.

const LOGO = 'https://cdn.example/northwind-dark.png'

function seedBranding(values: Partial<BrandingValues>) {
  useBrandingStore.setState({
    ...HARDCODED_DEFAULTS,
    ...values,
    loaded: true,
    loading: false,
  })
}

describe('share review header shows the instance brand (#308)', () => {
  beforeEach(() => {
    useThemeStore.setState({ theme: 'dark' })
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      // One body for every request: the folder listing reads assets/subfolders,
      // the review provider's stream lookup reads name/asset_type.
      json: async () => ({
        name: 'Clip.mp4',
        asset_type: 'image',
        assets: [{ id: 'a1', name: 'Clip.mp4', asset_type: 'video', latest_version_id: 'v1', thumbnail_url: null, status: 'ready' }],
        subfolders: [],
        total: 1,
      }),
    })) as unknown as typeof fetch)
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: true, media: query, onchange: null,
      addEventListener() {}, removeEventListener() {},
      addListener() {}, removeListener() {}, dispatchEvent: () => false,
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.documentElement.removeAttribute('data-theme')
    useBrandingStore.setState({ ...HARDCODED_DEFAULTS, loaded: false, loading: false })
  })

  function renderSingleAsset() {
    return render(
      <ShareReviewScreen
        token="t" assetId="a1" assetName="Clip.mp4"
        permission="view" allowDownload={false} showVersions={false} theme="dark"
      />,
    )
  }

  it('draws the instance logo beside the asset name on a single-asset link', async () => {
    seedBranding({ orgName: 'Northwind Studios', orgLogoDark: LOGO })
    renderSingleAsset()

    const logo = await screen.findByAltText('Northwind Studios', {}, { timeout: 3000 })
    expect(logo).toHaveAttribute('src', LOGO)
    // In the same bar as the asset name, not somewhere else on the page.
    expect(logo.parentElement).toBe(screen.getByText('Clip.mp4').parentElement)
  })

  it('prefers the sign-in logo, the same cascade the password gate uses', async () => {
    seedBranding({ orgName: 'Northwind Studios', orgLogoDark: LOGO, loginLogoUrl: 'https://cdn.example/login.png' })
    renderSingleAsset()

    const logo = await screen.findByAltText('Northwind Studios', {}, { timeout: 3000 })
    expect(logo).toHaveAttribute('src', 'https://cdn.example/login.png')
  })

  it('falls back to the FreeFrame mark when no logo is set', async () => {
    seedBranding({ orgName: 'Northwind Studios' })
    renderSingleAsset()

    const mark = await screen.findByAltText('FreeFrame', {}, { timeout: 3000 })
    expect(mark).toHaveAttribute('src', '/logo-icon-dark.png')
    expect(mark.parentElement).toBe(screen.getByText('Clip.mp4').parentElement)
  })

  // Instance logo URLs are presigned and expire (#361); a broken image in the
  // header is worse than the default mark.
  it('falls back to the FreeFrame mark when the logo fails to load', async () => {
    seedBranding({ orgName: 'Northwind Studios', orgLogoDark: LOGO })
    renderSingleAsset()

    fireEvent.error(await screen.findByAltText('Northwind Studios', {}, { timeout: 3000 }))
    expect(screen.queryByAltText('Northwind Studios')).toBeNull()
    expect(screen.getByAltText('FreeFrame')).toHaveAttribute('src', '/logo-icon-dark.png')
  })

  it('shows the same logo on the folder grid and on an asset opened from it', async () => {
    seedBranding({ orgName: 'Northwind Studios', orgLogoDark: LOGO })
    render(
      <FolderShareViewer
        token="t" folderName="F" title="T" description={null}
        permission="view" allowDownload={false} showVersions={false}
        appearance={{ open_in_viewer: true } as never} branding={null}
      />,
    )

    await waitFor(() => expect(screen.getByText('Clip.mp4')).toBeInTheDocument())
    expect(screen.getByAltText('Northwind Studios')).toHaveAttribute('src', LOGO)

    fireEvent.doubleClick(screen.getByText('Clip.mp4'))
    await waitFor(() => expect(screen.getByText('Fields')).toBeInTheDocument(), { timeout: 3000 })
    const logo = screen.getByAltText('Northwind Studios')
    expect(logo).toHaveAttribute('src', LOGO)
    // The grid is gone by now, so this is the review header's: right after its
    // back button.
    expect(logo.previousElementSibling?.tagName).toBe('BUTTON')
  })

  // The page renders in the link's own theme, not the viewer's: useShareAppearance
  // sets data-theme from the link. A guest's stored theme defaults to dark, so on
  // a light link the variant has to follow the link, or a light-ink wordmark
  // lands on a light header.
  describe("picks the logo variant for the link's theme, not the viewer's", () => {
    const DARK = 'https://cdn.example/logo-for-dark.png'
    const LIGHT = 'https://cdn.example/logo-for-light.png'

    it('on the folder grid and on an asset opened from it', async () => {
      seedBranding({ orgName: 'Northwind Studios', orgLogoDark: DARK, orgLogoLight: LIGHT })
      render(
        <FolderShareViewer
          token="t" folderName="F" title="T" description={null}
          permission="view" allowDownload={false} showVersions={false}
          appearance={{ open_in_viewer: true, theme: 'light' } as never} branding={null}
        />,
      )

      await waitFor(() => expect(screen.getByText('Clip.mp4')).toBeInTheDocument())
      expect(document.documentElement).toHaveAttribute('data-theme', 'light')
      expect(screen.getByAltText('Northwind Studios')).toHaveAttribute('src', LIGHT)

      fireEvent.doubleClick(screen.getByText('Clip.mp4'))
      await waitFor(() => expect(screen.getByText('Fields')).toBeInTheDocument(), { timeout: 3000 })
      expect(screen.getByAltText('Northwind Studios')).toHaveAttribute('src', LIGHT)
    })

    it("uses the dark variant on a default dark link when the viewer's own theme is light", async () => {
      useThemeStore.setState({ theme: 'light' })
      seedBranding({ orgName: 'Northwind Studios', orgLogoDark: DARK, orgLogoLight: LIGHT })
      render(
        <FolderShareViewer
          token="t" folderName="F" title="T" description={null}
          permission="view" allowDownload={false} showVersions={false}
          appearance={{ open_in_viewer: true } as never} branding={null}
        />,
      )

      await waitFor(() => expect(screen.getByText('Clip.mp4')).toBeInTheDocument())
      expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
      expect(screen.getByAltText('Northwind Studios')).toHaveAttribute('src', DARK)
    })

    it('on a single-asset link', async () => {
      seedBranding({ orgName: 'Northwind Studios', orgLogoDark: DARK, orgLogoLight: LIGHT })
      // One body serves the validate call and the review provider's lookups.
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          permission: 'view',
          asset_id: 'a1',
          asset: { id: 'a1', name: 'Clip.mp4', asset_type: 'image' },
          name: 'Clip.mp4',
          asset_type: 'image',
          appearance: { theme: 'light' },
        }),
      })) as unknown as typeof fetch)
      const routeParams = { token: 't' }
      render(
        <SharePage
          params={Object.assign(Promise.resolve(routeParams), {
            status: 'fulfilled' as const,
            value: routeParams,
          })}
        />,
      )

      const logo = await screen.findByAltText('Northwind Studios', {}, { timeout: 3000 })
      expect(document.documentElement).toHaveAttribute('data-theme', 'light')
      expect(logo).toHaveAttribute('src', LIGHT)
    })
  })
})
