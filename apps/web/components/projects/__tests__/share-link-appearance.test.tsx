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
import { DEFAULT_SHARE_APPEARANCE } from '../share-appearance-fields'

// The link panel's Appearance section edits the same block the create dialog
// shows, but without the current-view copy: while editing a saved link there
// is no folder view on screen to copy from. The panel still patches the whole
// appearance object, since the API replaces it wholesale.

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
  })

  it('does not offer "Use my current view" when editing a saved link', async () => {
    renderPanel()
    await openAppearanceSection()
    // That copy only makes sense in the create dialog, where the folder view
    // is on screen behind the modal. Here there is no view to copy.
    expect(
      screen.queryByRole('button', { name: /use my current view/i }),
    ).toBeNull()
  })

  it('shows the stored theme, accent and open in viewer, and can clear the accent', async () => {
    renderPanel()
    await openAppearanceSection()
    expect(screen.getByRole('button', { name: 'Light' }).getAttribute('aria-pressed')).toBe('true')
    expect((screen.getByLabelText('Accent colour hex') as HTMLInputElement).value).toBe('ff0000')
    expect(screen.getByRole('switch', { name: 'Open in Viewer' }).getAttribute('aria-checked')).toBe('false')

    fireEvent.click(screen.getByRole('button', { name: 'Clear accent colour' }))
    await waitFor(() => expect(patch).toHaveBeenCalled())
    expect(patch.mock.calls[0]).toEqual([
      '/share/tok',
      { appearance: { ...LINK_APPEARANCE, accent_color: null } },
    ])
  })

  it('an asset link offers only theme and accent', async () => {
    get.mockResolvedValue({
      id: 'l1', token: 'tok', title: 'Link', asset_id: 'a1', folder_id: null,
      permission: 'comment', visibility: 'public', allow_download: false,
      show_versions: true, show_watermark: false, is_enabled: true, has_password: false,
      appearance: LINK_APPEARANCE, created_at: '2026-10-01T00:00:00Z', expires_at: null,
    })
    renderPanel()
    await openAppearanceSection()
    expect(screen.getByRole('button', { name: 'Light' })).toBeTruthy()
    expect(screen.getByLabelText('Accent colour hex')).toBeTruthy()
    expect(screen.queryByRole('group', { name: 'Layout' })).toBeNull()
    expect(screen.queryByRole('switch', { name: 'Open in Viewer' })).toBeNull()
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

  it('a link with no stored appearance edits from the share defaults', async () => {
    get.mockResolvedValue({
      id: 'l1', token: 'tok', title: 'Link', permission: 'comment', visibility: 'public',
      allow_download: false, show_versions: true, show_watermark: false, is_enabled: true,
      has_password: false, appearance: null, created_at: '2026-10-01T00:00:00Z',
      expires_at: null,
    })
    renderPanel()
    await openAppearanceSection()
    fireEvent.click(screen.getByRole('button', { name: 'S' }))

    // The same values the API and the create dialog start a link on, not a
    // second set of fallbacks (open_in_viewer off, name sort, fit).
    await waitFor(() => expect(patch).toHaveBeenCalled())
    expect(patch.mock.calls[0]).toEqual([
      '/share/tok',
      { appearance: { ...DEFAULT_SHARE_APPEARANCE, card_size: 's' } },
    ])
  })
})
