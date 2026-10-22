import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SWRConfig } from 'swr'

const get = vi.fn()
const patch = vi.fn()
vi.mock('@/lib/api', () => ({
  api: {
    get: (...a: unknown[]) => get(...a),
    patch: (...a: unknown[]) => patch(...a),
    post: vi.fn(),
  },
}))

import { ShareLinkSettingsPanel } from '../share-link-detail'
import { useViewStore } from '@/stores/view-store'

// Existing links get the same "Use my current view" action the create dialog
// has: one click fills the link's appearance from the folder view, and the
// link then owns the result. Fields the view has no equivalent for (theme,
// accent, open-in-viewer) are left exactly as the link has them.

const LINK_APPEARANCE = {
  layout: 'grid',
  theme: 'light',
  accent_color: '#ff0000',
  open_in_viewer: false,
  sort_by: 'file_size',
  card_size: 'm',
  aspect_ratio: 'landscape',
  thumbnail_scale: 'fit',
  show_card_info: true,
}

function renderPanel() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ShareLinkSettingsPanel token="tok" />
    </SWRConfig>,
  )
}

async function openAppearanceSection() {
  // The panel loads over SWR and keeps Appearance collapsed by default.
  fireEvent.click(await screen.findByRole('button', { name: 'Appearance' }))
}

describe('ShareLinkSettingsPanel appearance', () => {
  beforeEach(() => {
    get.mockReset().mockResolvedValue({
      id: 'l1', token: 'tok', title: 'Link', permission: 'comment', visibility: 'public',
      allow_download: false, show_versions: true, show_watermark: false, is_enabled: true,
      has_password: false, appearance: LINK_APPEARANCE, created_at: '2026-10-01T00:00:00Z',
      expires_at: null,
    })
    patch.mockReset().mockResolvedValue({})
    useViewStore.setState({
      layout: 'list',
      cardSize: 'L',
      aspectRatio: 'square',
      thumbnailScale: 'fill',
      showCardInfo: false,
      sortKey: 'date',
      sortDirection: 'asc',
    })
  })

  it('Use my current view copies the view into the link, keeping the rest', async () => {
    renderPanel()
    await openAppearanceSection()
    fireEvent.click(await screen.findByRole('button', { name: /use my current view/i }))

    await waitFor(() => expect(patch).toHaveBeenCalled())
    expect(patch.mock.calls[0]).toEqual([
      '/share/tok',
      {
        appearance: {
          ...LINK_APPEARANCE,
          // Copied from the view:
          layout: 'list',
          card_size: 'l',
          aspect_ratio: 'square',
          thumbnail_scale: 'fill',
          show_card_info: false,
          sort_by: 'created_at',
        },
      },
    ])
  })

  it('editing one setting still patches the whole stored appearance', async () => {
    renderPanel()
    await openAppearanceSection()
    fireEvent.click(screen.getByRole('button', { name: 'S' }))

    await waitFor(() => expect(patch).toHaveBeenCalled())
    expect(patch.mock.calls[0]).toEqual([
      '/share/tok',
      { appearance: { ...LINK_APPEARANCE, card_size: 's' } },
    ])
  })
})