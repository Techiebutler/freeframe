import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const post = vi.fn()
const patch = vi.fn()
const get = vi.fn()
vi.mock('@/lib/api', () => ({
  api: {
    get: (...a: unknown[]) => get(...a),
    patch: (...a: unknown[]) => patch(...a),
    post: (...a: unknown[]) => post(...a),
  },
}))

import { ShareCreateDialog } from '../share-create-dialog'
import { DEFAULT_SHARE_APPEARANCE } from '../share-appearance-fields'
import { useViewStore } from '@/stores/view-store'

// A share link carries its own appearance. The create dialog now edits it
// directly, starting from the share defaults; "Use my current view" copies
// the folder view in once, at the click, and nothing after that re-reads it.

function renderDialog() {
  return render(
    <ShareCreateDialog
      open
      onOpenChange={() => {}}
      projectId="p1"
      currentFolderId={null}
      assets={[]}
      folders={[]}
      preselectedItems={[{ type: 'folder', id: 'f1', name: 'F' }]}
      onShareCreated={() => {}}
    />,
  )
}

function openAppearanceBlock() {
  fireEvent.click(screen.getByRole('button', { name: 'Appearance' }))
}

function createAndSentAppearance(): Record<string, unknown> {
  fireEvent.click(screen.getByRole('button', { name: 'Create' }))
  expect(post).toHaveBeenCalled()
  return (post.mock.calls[0][1] as Record<string, unknown>).appearance as Record<string, unknown>
}

describe('ShareCreateDialog appearance', () => {
  beforeEach(() => {
    post.mockReset().mockResolvedValue({ token: 'tok', title: 't' })
    patch.mockReset().mockResolvedValue({})
    get.mockReset().mockResolvedValue({})
    useViewStore.setState({
      layout: 'grid',
      cardSize: 'M',
      aspectRatio: 'landscape',
      thumbnailScale: 'fit',
      showCardInfo: true,
      sortKey: 'date',
      sortDirection: 'desc',
    })
  })

  it('a new link starts on the share defaults, not on my current view', () => {
    useViewStore.setState({ layout: 'list', cardSize: 'S' })
    renderDialog()
    expect(createAndSentAppearance()).toEqual(DEFAULT_SHARE_APPEARANCE)
  })

  it('picks made in the Appearance block go out with the create request', () => {
    renderDialog()
    openAppearanceBlock()
    fireEvent.click(screen.getByRole('button', { name: 'L' }))
    fireEvent.click(screen.getByRole('button', { name: 'List' }))

    // List layout hides the grid-only rows, like the folder Appearance
    // popover — but the picks stay stored and go out with the request, so
    // switching back to grid (here or later) keeps them.
    expect(screen.queryByRole('button', { name: 'S' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Landscape' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Fit' })).toBeNull()
    expect(createAndSentAppearance()).toEqual({
      ...DEFAULT_SHARE_APPEARANCE,
      layout: 'list',
      card_size: 'l',
    })
  })

  it('the settings scroll box keeps its scrollbar space reserved', () => {
    // Switching Layout to list hides the grid-only rows. That used to drop
    // the scroll box's vertical scrollbar when the list got short, and the
    // freed width visibly widened the dialog. The gutter stays reserved, so
    // the dialog keeps one width through the switch.
    renderDialog()
    openAppearanceBlock()
    const scrollBox = screen.getByRole('button', { name: 'Appearance' }).closest('fieldset')
    expect(scrollBox).not.toBeNull()
    expect(scrollBox!.className).toContain('[scrollbar-gutter:stable]')
  })

  it('offers no theme, accent or open-in-viewer control', () => {
    // Those are not editable on a link: it keeps whatever it stored, new
    // links take the defaults (theme accent, open in viewer, dark theme),
    // and the values still travel with every whole-appearance patch.
    renderDialog()
    openAppearanceBlock()
    expect(screen.queryByRole('button', { name: 'Dark theme' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Light theme' })).toBeNull()
    expect(screen.queryByLabelText('Accent colour hex')).toBeNull()
    expect(screen.queryByRole('button', { name: /pick an accent colour/i })).toBeNull()
    expect(screen.queryByText('Open in viewer')).toBeNull()
  })

  it('Use my current view fills the link from my view, once', () => {
    useViewStore.setState({
      layout: 'list',
      cardSize: 'S',
      aspectRatio: 'portrait',
      thumbnailScale: 'fill',
      showCardInfo: false,
      sortKey: 'name',
      sortDirection: 'asc',
    })
    renderDialog()
    openAppearanceBlock()
    fireEvent.click(screen.getByRole('button', { name: /use my current view/i }))

    // The copy was a one-time fill: moving my view now changes nothing on the link.
    useViewStore.setState({ layout: 'grid', sortKey: 'date', sortDirection: 'desc' })

    // Theme, accent and open-in-viewer are the link's own; the view has no
    // equivalent for them, so they stay on the share defaults.
    expect(createAndSentAppearance()).toEqual({
      layout: 'list',
      theme: 'dark',
      accent_color: null,
      open_in_viewer: true,
      sort_by: 'name',
      card_size: 's',
      aspect_ratio: 'portrait',
      thumbnail_scale: 'fill',
      show_card_info: false,
    })
  })

  it('a view sort with no share equivalent leaves the link on its own sort', () => {
    // Custom sorting cannot exist on a share page; the link keeps its sort.
    useViewStore.setState({ sortKey: 'custom', layout: 'list' })
    renderDialog()
    openAppearanceBlock()
    fireEvent.click(screen.getByRole('button', { name: /use my current view/i }))

    const appearance = createAndSentAppearance()
    expect(appearance.layout).toBe('list')
    expect(appearance.sort_by).toBe('created_at')
  })

  it('the created-link layout switch keeps the rest of the appearance', async () => {
    // PATCH replaces the whole appearance object, so the quick switch must
    // send back everything else the link has, not just the layout.
    get.mockResolvedValue({
      permission: 'view',
      allow_download: false,
      has_password: false,
      show_watermark: false,
      visibility: 'public',
      appearance: {
        ...DEFAULT_SHARE_APPEARANCE,
        layout: 'grid',
        theme: 'light',
        accent_color: '#ff5500',
        card_size: 'l',
        sort_by: 'file_size',
      },
    })
    render(
      <ShareCreateDialog
        open
        onOpenChange={() => {}}
        projectId="p1"
        currentFolderId={null}
        assets={[]}
        folders={[]}
        initialResult={{ token: 'tok', title: 'Link', itemType: 'asset', thumbnailUrl: null }}
        onShareCreated={() => {}}
      />,
    )
    fireEvent.click(await screen.findByText('Settings'))
    fireEvent.click(await screen.findByRole('button', { name: 'list' }))

    await waitFor(() => expect(patch).toHaveBeenCalled())
    expect(patch.mock.calls[0]).toEqual([
      '/share/tok',
      {
        appearance: {
          ...DEFAULT_SHARE_APPEARANCE,
          layout: 'list',
          theme: 'light',
          accent_color: '#ff5500',
          card_size: 'l',
          sort_by: 'file_size',
        },
      },
    ])
  })
})