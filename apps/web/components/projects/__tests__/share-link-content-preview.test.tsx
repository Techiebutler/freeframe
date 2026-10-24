import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { SWRConfig } from 'swr'

const get = vi.fn()
vi.mock('@/lib/api', () => ({
  api: {
    get: (...a: unknown[]) => get(...a),
    patch: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  },
}))

import { ShareLinkContent } from '../share-link-detail'
import type { ShareLinkAppearance } from '@/types'
import { useBrandingStore } from '@/stores/branding-store'

// The share link detail preview mirrors how the share page renders the link
// (folder-share-viewer): card size → grid columns, aspect ratio → thumbnail
// box, fit/fill → object-cover/contain, card info → the name strip, layout →
// grid vs list rows, sort_by → asset order. The settings panel patches the
// same SWR key the content reads, so edits land in the preview directly.

const APPEARANCE: ShareLinkAppearance = {
  layout: 'grid',
  theme: 'dark',
  accent_color: null,
  open_in_viewer: true,
  sort_by: 'created_at',
  card_size: 'm',
  aspect_ratio: 'landscape',
  thumbnail_scale: 'fill',
  show_card_info: true,
}

// Chosen so the sorts disagree: created_at desc puts Zeta (newer) first,
// name puts Alpha first.
const ASSETS = [
  { id: 'a1', name: 'Zeta.png', asset_type: 'image', thumbnail_url: 'http://img/z', file_size: 10, created_at: '2026-10-02T00:00:00Z' },
  { id: 'a2', name: 'Alpha.png', asset_type: 'image', thumbnail_url: 'http://img/a', file_size: 20, created_at: '2026-10-01T00:00:00Z' },
]

function renderContent(appearance: ShareLinkAppearance) {
  get.mockReset().mockResolvedValue({
    id: 'l1', token: 'tok', title: 'Link', folder_id: 'f1', asset_id: null,
    permission: 'comment', visibility: 'public', allow_download: false,
    show_versions: true, show_watermark: false, is_enabled: true,
    has_password: false, appearance, created_at: '2026-10-01T00:00:00Z',
    expires_at: null,
  })
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ShareLinkContent
        token="tok"
        projectId="p1"
        onBack={() => {}}
        frontendUrl="http://localhost:3000"
      />
    </SWRConfig>,
  )
}

/** Resolve once the preview assets have rendered. */
async function assetsShown() {
  return screen.findByText('Zeta.png')
}

function classes(container: HTMLElement): string {
  return Array.from(container.querySelectorAll('*'))
    .map((el) => el.className?.toString() ?? '')
    .join(' ')
}

beforeEach(() => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ assets: ASSETS, subfolders: [] }),
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  useBrandingStore.setState({ loaded: false, primaryColor: null })
})

describe('ShareLinkContent preview', () => {
  it('defaults to the medium grid and created_at order', async () => {
    const { container } = renderContent(APPEARANCE)
    await assetsShown()
    const cls = classes(container)
    expect(cls).toContain('grid-cols-3')
    expect(cls).toContain('aspect-[16/10]')
    // created_at desc: Zeta (newer) precedes Alpha.
    const zeta = screen.getByText('Zeta.png')
    const alpha = screen.getByText('Alpha.png')
    expect(zeta.compareDocumentPosition(alpha) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('card size, aspect ratio and fit/fill flow into the cards', async () => {
    const { container } = renderContent({
      ...APPEARANCE,
      card_size: 'l',
      aspect_ratio: 'square',
      thumbnail_scale: 'fit',
    })
    await assetsShown()
    const cls = classes(container)
    expect(cls).toContain('grid-cols-2')
    expect(cls).toContain('aspect-square')
    expect(container.querySelector('img.object-contain')).not.toBeNull()
  })

  it('sort_by name reorders the preview', async () => {
    renderContent({ ...APPEARANCE, sort_by: 'name' })
    await assetsShown()
    const zeta = screen.getByText('Zeta.png')
    const alpha = screen.getByText('Alpha.png')
    expect(alpha.compareDocumentPosition(zeta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('show_card_info false drops the name strip', async () => {
    renderContent({ ...APPEARANCE, show_card_info: false })
    await waitFor(() => expect(screen.getAllByAltText(/\.png/).length).toBeGreaterThan(0))
    expect(screen.queryByText('Zeta.png')).toBeNull()
    expect(screen.queryByText('Alpha.png')).toBeNull()
  })

  it('list layout replaces the grid with rows', async () => {
    const { container } = renderContent({ ...APPEARANCE, layout: 'list' })
    await assetsShown()
    expect(classes(container)).not.toContain('grid-cols-')
    // Names stay visible in rows even though the grid card info strip is gone.
    expect(screen.getByText('Zeta.png')).toBeTruthy()
    expect(screen.getByText('Alpha.png')).toBeTruthy()
  })

  it('sorts every fetched asset before taking the six it shows', async () => {
    // Thirteen assets, the alphabetically first one last: the sort must see
    // all of them, not only the first dozen the API happened to return.
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: `m${i}`, name: `M${String(i).padStart(2, '0')}.png`, asset_type: 'image',
      thumbnail_url: null, file_size: 1, created_at: '2026-10-01T00:00:00Z',
    }))
    const first = { ...many[0], id: 'aa', name: 'AA-first.png' }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ assets: [...many, first], subfolders: [] }),
    }))
    renderContent({ ...APPEARANCE, sort_by: 'name' })
    expect(await screen.findByText('AA-first.png')).toBeTruthy()
  })

  it('fetches the share page\'s first page and labels the whole count', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ assets: ASSETS, subfolders: [], total: 40 }),
    })
    vi.stubGlobal('fetch', fetchMock)
    renderContent(APPEARANCE)
    await assetsShown()
    // The share page loads 24 at a time and sorts what it has loaded.
    expect(String(fetchMock.mock.calls[0][0])).toContain('per_page=24')
    expect(screen.getByText(/40\s+Assets/)).toBeTruthy()
  })

  it('list rows always crop, as the share page\'s do', async () => {
    const { container } = renderContent({ ...APPEARANCE, layout: 'list', thumbnail_scale: 'fit' })
    await assetsShown()
    expect(container.querySelector('img.object-contain')).toBeNull()
    expect(container.querySelector('img.object-cover')).not.toBeNull()
  })

  describe('theme and accent', () => {
    const frame = () => screen.getByTestId('share-preview-frame')

    it('the frame takes the link\'s theme, and only the frame', async () => {
      renderContent({ ...APPEARANCE, theme: 'light' })
      await assetsShown()
      expect(frame().getAttribute('data-theme')).toBe('light')
      // The app around the preview keeps its own palette.
      expect(document.documentElement.getAttribute('data-theme')).not.toBe('light')
    })

    it('a dark link previews dark', async () => {
      renderContent(APPEARANCE)
      await assetsShown()
      expect(frame().getAttribute('data-theme')).toBe('dark')
    })

    it('the link\'s accent paints the frame, not the app', async () => {
      renderContent({ ...APPEARANCE, accent_color: '#ff5500' })
      await assetsShown()
      expect(frame().style.getPropertyValue('--accent')).toBe('#ff5500')
      expect(document.documentElement.style.getPropertyValue('--accent')).toBe('')
    })

    it('with no accent of its own, the link previews the instance branding', async () => {
      useBrandingStore.setState({ loaded: true, primaryColor: '#00aa00' })
      renderContent(APPEARANCE)
      await assetsShown()
      expect(frame().style.getPropertyValue('--accent')).toBe('#00aa00')
    })

    it('with no accent anywhere, the frame keeps the theme\'s own', async () => {
      renderContent(APPEARANCE)
      await assetsShown()
      expect(frame().style.getPropertyValue('--accent')).toBe('')
    })

    it('an asset link falls back to the project\'s branding first', async () => {
      useBrandingStore.setState({ loaded: true, primaryColor: '#00aa00' })
      get.mockReset().mockImplementation((url: string) => {
        if (url === '/projects/p1/branding') return Promise.resolve({ primary_color: '#0000cc' })
        if (url === '/assets/a1') return Promise.resolve({ ...ASSETS[0], id: 'a1' })
        return Promise.resolve({
          id: 'l1', token: 'tok', title: 'Link', folder_id: null, asset_id: 'a1',
          permission: 'comment', visibility: 'public', allow_download: false,
          show_versions: true, show_watermark: false, is_enabled: true,
          has_password: false, appearance: APPEARANCE, created_at: '2026-10-01T00:00:00Z',
          expires_at: null,
        })
      })
      render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          <ShareLinkContent token="tok" projectId="p1" onBack={() => {}} frontendUrl="http://localhost:3000" />
        </SWRConfig>,
      )
      await waitFor(() => expect(frame().style.getPropertyValue('--accent')).toBe('#0000cc'))
      // A single asset opens in the review screen, which has no footer.
      expect(screen.queryByTestId('share-preview-footer')).toBeNull()
    })
  })

  // The share API now sends the project's branding for every link type, so a
  // folder or project link previews it too: colour, logo and footer.
  describe('project branding on a folder link', () => {
    const frame = () => screen.getByTestId('share-preview-frame')

    function renderWithBranding(branding: Record<string, unknown>, project: Record<string, unknown> = {}) {
      useBrandingStore.setState({ loaded: true, primaryColor: '#00aa00' })
      get.mockReset().mockImplementation((url: string) => {
        if (url === '/projects/p1/branding') return Promise.resolve(branding)
        if (url === '/projects/p1') return Promise.resolve({ id: 'p1', name: 'P', poster_url: null, ...project })
        return Promise.resolve({
          id: 'l1', token: 'tok', title: 'Link', folder_id: 'f1', asset_id: null,
          permission: 'comment', visibility: 'public', allow_download: false,
          show_versions: true, show_watermark: false, is_enabled: true,
          has_password: false, appearance: APPEARANCE, created_at: '2026-10-01T00:00:00Z',
          expires_at: null,
        })
      })
      return render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          <ShareLinkContent token="tok" projectId="p1" onBack={() => {}} frontendUrl="http://localhost:3000" />
        </SWRConfig>,
      )
    }

    it('takes the project colour ahead of the instance one', async () => {
      renderWithBranding({ primary_color: '#0000cc', use_cover_as_logo: false, logo_url: null, custom_footer: null })
      await waitFor(() => expect(frame().style.getPropertyValue('--accent')).toBe('#0000cc'))
    })

    it('shows the project logo and footer', async () => {
      renderWithBranding({
        primary_color: null,
        use_cover_as_logo: false,
        logo_url: 'https://cdn.example/logo.webp',
        custom_footer: 'All rights reserved',
      })
      expect(await screen.findByText('All rights reserved')).toBeTruthy()
      expect(screen.getByAltText('Project logo')).toHaveAttribute('src', 'https://cdn.example/logo.webp')
    })

    it('shows the cover when the project uses it as its logo', async () => {
      renderWithBranding(
        { primary_color: null, use_cover_as_logo: true, logo_url: 'https://cdn.example/logo.webp', custom_footer: null },
        { poster_url: 'https://cdn.example/cover.jpg' },
      )
      await waitFor(() =>
        expect(screen.getByAltText('Project logo')).toHaveAttribute('src', 'https://cdn.example/cover.jpg'),
      )
    })
  })
})
