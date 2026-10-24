import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ShareBrandMark } from '../share-brand-mark'
import { FolderShareViewer } from '../folder-share-viewer'
import { useBrandingStore, HARDCODED_DEFAULTS, type BrandingValues } from '@/stores/branding-store'
import { useThemeStore } from '@/stores/theme-store'
import type { ShareBranding } from '@/types'

vi.mock('@/components/shared/branding-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/shared/branding-provider')>()),
  useEnsureBranding: () => {},
}))

import SharePage from '@/app/share/[token]/page'

// The share API sends the project's branding for every link type: a logo URL
// already resolved (the cover when the project uses it as its logo), the
// project colour, and the footer text. Share pages put the project logo ahead
// of the instance's, take the colour when the link has none of its own, and
// show the footer wherever they have a footer.

const PROJECT_LOGO = 'https://cdn.example/project-logo.webp'
const INSTANCE_LOGO = 'https://cdn.example/instance-dark.png'

const BRANDING: ShareBranding = {
  logo_url: PROJECT_LOGO,
  primary_color: '#cc3300',
  custom_footer: 'Confidential: Northwind only',
}

function seedBranding(values: Partial<BrandingValues>) {
  useBrandingStore.setState({ ...HARDCODED_DEFAULTS, ...values, loaded: true, loading: false })
}

function injectedAccent(): string | null {
  return document.getElementById('ff-share-accent')?.textContent ?? null
}

function stubFetch(body: (url: string) => unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => body(String(url)),
  })) as unknown as typeof fetch)
}

const LISTING = {
  name: 'Clip.mp4',
  asset_type: 'image',
  assets: [{ id: 'a1', name: 'Clip.mp4', asset_type: 'video', latest_version_id: 'v1', thumbnail_url: null, status: 'ready' }],
  subfolders: [],
  total: 1,
}

function renderSharePage() {
  const routeParams = { token: 't' }
  return render(
    <SharePage
      params={Object.assign(Promise.resolve(routeParams), {
        status: 'fulfilled' as const,
        value: routeParams,
      })}
    />,
  )
}

beforeEach(() => {
  useThemeStore.setState({ theme: 'dark' })
  seedBranding({ orgName: 'Northwind Studios', orgLogoDark: INSTANCE_LOGO })
  stubFetch(() => LISTING)
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
  document.getElementById('ff-share-accent')?.remove()
  useBrandingStore.setState({ ...HARDCODED_DEFAULTS, loaded: false, loading: false })
})

describe('ShareBrandMark', () => {
  it('shows the project logo ahead of the instance logo', () => {
    render(<ShareBrandMark theme="dark" projectLogoUrl={PROJECT_LOGO} />)
    expect(screen.getByAltText('Project logo')).toHaveAttribute('src', PROJECT_LOGO)
    expect(screen.queryByAltText('Northwind Studios')).toBeNull()
  })

  it('falls back to the instance logo, then the FreeFrame mark, as each fails to load', () => {
    render(<ShareBrandMark theme="dark" projectLogoUrl={PROJECT_LOGO} />)
    fireEvent.error(screen.getByAltText('Project logo'))
    const instance = screen.getByAltText('Northwind Studios')
    expect(instance).toHaveAttribute('src', INSTANCE_LOGO)
    fireEvent.error(instance)
    expect(screen.getByAltText('FreeFrame')).toBeInTheDocument()
  })

  it('keeps the instance cascade when the project has no logo', () => {
    render(<ShareBrandMark theme="dark" projectLogoUrl={null} />)
    expect(screen.getByAltText('Northwind Studios')).toHaveAttribute('src', INSTANCE_LOGO)
  })

  it('loads an API-relative logo path from the API', () => {
    render(<ShareBrandMark theme="dark" projectLogoUrl="/share/t/logo" />)
    expect(screen.getByAltText('Project logo').getAttribute('src')).toMatch(/^https?:\/\/.+\/share\/t\/logo$/)
  })
})

describe('folder and project links', () => {
  function renderGrid(appearance: Record<string, unknown> = {}, branding: ShareBranding | null = BRANDING) {
    return render(
      <FolderShareViewer
        token="t" folderName="F" title="T" description={null}
        permission="view" allowDownload={false} showVersions={false}
        appearance={{ open_in_viewer: true, ...appearance } as never}
        branding={branding}
      />,
    )
  }

  it('show the project logo in the header and on an asset opened from the grid', async () => {
    renderGrid()
    await waitFor(() => expect(screen.getByText('Clip.mp4')).toBeInTheDocument())
    expect(screen.getByAltText('Project logo')).toHaveAttribute('src', PROJECT_LOGO)

    fireEvent.doubleClick(screen.getByText('Clip.mp4'))
    await waitFor(() => expect(screen.getByText('Fields')).toBeInTheDocument(), { timeout: 3000 })
    expect(screen.getByAltText('Project logo')).toHaveAttribute('src', PROJECT_LOGO)
  })

  it('render the footer text', async () => {
    renderGrid()
    expect(await screen.findByText('Confidential: Northwind only')).toBeInTheDocument()
  })

  it('take the project colour when the link has no accent', async () => {
    renderGrid()
    await waitFor(() => expect(injectedAccent()).toContain('--accent: #cc3300'))
  })

  it("keep the link's own accent over the project colour", async () => {
    renderGrid({ accent_color: '#00aa55' })
    await waitFor(() => expect(injectedAccent()).toContain('--accent: #00aa55'))
    expect(injectedAccent()).not.toContain('#cc3300')
  })

  it('a project link resolved by the share page gets all three', async () => {
    stubFetch((url) =>
      /\/share\/t(\?|$)/.test(url)
        ? {
            permission: 'view',
            project_id: 'p1',
            project_name: 'Northwind',
            appearance: { theme: 'dark' },
            branding: BRANDING,
          }
        : LISTING,
    )
    renderSharePage()
    expect(await screen.findByText('Confidential: Northwind only', {}, { timeout: 3000 })).toBeInTheDocument()
    expect(screen.getByAltText('Project logo')).toHaveAttribute('src', PROJECT_LOGO)
    await waitFor(() => expect(injectedAccent()).toContain('--accent: #cc3300'))
  })
})

describe('single-asset links', () => {
  it('show the project logo and colour in the review header', async () => {
    stubFetch(() => ({
      permission: 'view',
      asset_id: 'a1',
      asset: { id: 'a1', name: 'Clip.mp4', asset_type: 'image' },
      name: 'Clip.mp4',
      asset_type: 'image',
      appearance: { theme: 'dark' },
      branding: BRANDING,
    }))
    renderSharePage()

    const logo = await screen.findByAltText('Project logo', {}, { timeout: 3000 })
    expect(logo).toHaveAttribute('src', PROJECT_LOGO)
    await waitFor(() => expect(injectedAccent()).toContain('--accent: #cc3300'))
  })
})
