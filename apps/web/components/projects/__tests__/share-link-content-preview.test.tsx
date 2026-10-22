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
})