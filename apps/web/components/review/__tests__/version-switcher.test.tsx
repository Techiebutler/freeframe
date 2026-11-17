import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  api: { delete: vi.fn(), get: vi.fn(), post: vi.fn(), put: vi.fn() },
}))

import { api, ApiError } from '@/lib/api'
import { VersionSwitcher, deleteVersionBlocker, restorableFor } from '../version-switcher'
import { useReviewStore } from '@/stores/review-store'
import type { AssetVersion, DeletedAssetVersion } from '@/types'

function makeVersion(partial: Partial<AssetVersion> & { version_number: number }): AssetVersion {
  return {
    id: `v${partial.version_number}`,
    asset_id: 'asset-1',
    processing_status: 'ready',
    created_by: 'user-1',
    created_at: '',
    deleted_at: null,
    files: [],
    ...partial,
  } as AssetVersion
}

describe('VersionSwitcher trigger status indicator (#118)', () => {
  beforeEach(() => {
    useReviewStore.getState().reset()
  })

  it('shows a processing indicator on the always-visible trigger when the newest version is still processing', () => {
    const v1 = makeVersion({ version_number: 1, processing_status: 'ready' })
    const v2 = makeVersion({ version_number: 2, processing_status: 'processing' })
    // Viewer is still on the ready v1 while v2 transcodes.
    useReviewStore.getState().setCurrentVersion(v1)

    render(<VersionSwitcher versions={[v1, v2]} />)

    // Trigger reflects the currently-viewed version...
    expect(screen.getByText('v1')).toBeInTheDocument()
    // ...and surfaces that a newer version is being processed, without opening the dropdown.
    expect(screen.getByTestId('version-status-indicator')).toBeInTheDocument()
    expect(screen.getByTestId('version-status-indicator')).toHaveTextContent(/processing/i)
  })

  it('shows an uploading indicator while the newest version is uploading', () => {
    const v1 = makeVersion({ version_number: 1, processing_status: 'ready' })
    const v2 = makeVersion({ version_number: 2, processing_status: 'uploading' })
    useReviewStore.getState().setCurrentVersion(v1)

    render(<VersionSwitcher versions={[v1, v2]} />)

    expect(screen.getByTestId('version-status-indicator')).toHaveTextContent(/uploading/i)
  })

  it('shows no processing indicator when every version is ready', () => {
    const v1 = makeVersion({ version_number: 1, processing_status: 'ready' })
    const v2 = makeVersion({ version_number: 2, processing_status: 'ready' })
    useReviewStore.getState().setCurrentVersion(v2)

    render(<VersionSwitcher versions={[v1, v2]} />)

    expect(screen.queryByTestId('version-status-indicator')).toBeNull()
  })
})

// ─── Per-version ⋯ menu: delete and restore (#419) ───────────────────────────

const user = () => userEvent.setup({ pointerEventsCheck: 0 })

function makeDeleted(version_number: number, partial: Partial<DeletedAssetVersion> = {}): DeletedAssetVersion {
  return {
    id: `v${version_number}`,
    asset_id: 'asset-1',
    version_number,
    processing_status: 'ready',
    created_by: 'user-1',
    created_at: '',
    deleted_at: '2026-11-01T00:00:00Z',
    restorable_until: null,
    ...partial,
  }
}

async function openMenu() {
  await user().click(screen.getByRole('button', { name: /^v\d/ }))
  return screen.findByRole('menu')
}

/** Opens the ⋯ of one version and answers its submenu. */
async function openActions(n: number) {
  await user().click(await screen.findByRole('menuitem', { name: `Actions for v${n}` }))
  const menus = await screen.findAllByRole('menu')
  return menus[menus.length - 1]
}

function deletedList(rows: DeletedAssetVersion[]) {
  vi.mocked(api.get).mockResolvedValue(rows)
}

describe('VersionSwitcher ⋯ menu (#419)', () => {
  beforeEach(() => {
    useReviewStore.getState().reset()
    vi.mocked(api.delete).mockReset()
    vi.mocked(api.post).mockReset()
    vi.mocked(api.get).mockReset()
    deletedList([])
  })

  it('shows no ⋯ and asks for no deleted versions for someone who may not delete', async () => {
    const v1 = makeVersion({ version_number: 1 })
    const v2 = makeVersion({ version_number: 2 })
    useReviewStore.getState().setCurrentVersion(v2)
    render(<VersionSwitcher versions={[v1, v2]} />)

    await openMenu()

    expect(screen.queryByRole('menuitem', { name: /Actions for/ })).toBeNull()
    expect(screen.queryByText(/delete/i)).toBeNull()
    expect(api.get).not.toHaveBeenCalled()
  })

  it('gives every version of an editor its own ⋯', async () => {
    const v1 = makeVersion({ version_number: 1 })
    const v2 = makeVersion({ version_number: 2 })
    useReviewStore.getState().setCurrentVersion(v2)
    render(<VersionSwitcher versions={[v1, v2]} canDelete />)

    await openMenu()

    expect(screen.getByRole('menuitem', { name: 'Actions for v1' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Actions for v2' })).toBeInTheDocument()
  })

  it('opening ⋯ does not switch to that version', async () => {
    const v1 = makeVersion({ version_number: 1 })
    const v2 = makeVersion({ version_number: 2 })
    useReviewStore.getState().setCurrentVersion(v2)
    render(<VersionSwitcher versions={[v1, v2]} canDelete />)

    await openMenu()
    const actions = await openActions(1)

    expect(within(actions).getByRole('menuitem', { name: 'Delete version' })).toBeInTheDocument()
    expect(useReviewStore.getState().currentVersion?.id).toBe('v2')
  })

  it('works from the keyboard: arrows reach ⋯, Right opens it, Escape closes it', async () => {
    const v1 = makeVersion({ version_number: 1 })
    const v2 = makeVersion({ version_number: 2 })
    useReviewStore.getState().setCurrentVersion(v2)
    render(<VersionSwitcher versions={[v1, v2]} canDelete />)
    const u = user()

    screen.getByRole('button', { name: /^v\d/ }).focus()
    await u.keyboard('{Enter}')
    await screen.findByRole('menu')
    // Opening from the keyboard lands on the first row, and its ⋯ comes next.
    await waitFor(() => expect(document.activeElement).toHaveTextContent('v1'))
    await u.keyboard('{ArrowDown}')
    await waitFor(() => expect(document.activeElement).toHaveAttribute('aria-label', 'Actions for v1'))
    await u.keyboard('{ArrowRight}')
    await waitFor(() => expect(document.activeElement).toHaveTextContent('Delete version'))
    // Left closes the ⋯ alone, Escape the whole menu, back to the trigger.
    await u.keyboard('{ArrowLeft}')
    await waitFor(() => expect(document.activeElement).toHaveAttribute('aria-label', 'Actions for v1'))
    expect(screen.getAllByRole('menu')).toHaveLength(1)
    await u.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^v\d/ }))
    expect(useReviewStore.getState().currentVersion?.id).toBe('v2')

    // And a delete chosen by Enter opens the confirmation.
    await u.keyboard('{Enter}')
    await waitFor(() => expect(document.activeElement).toHaveTextContent('v1'))
    await u.keyboard('{ArrowDown}')
    await u.keyboard('{ArrowRight}')
    await waitFor(() => expect(document.activeElement).toHaveTextContent('Delete version'))
    await u.keyboard('{Enter}')
    expect(await screen.findByRole('dialog')).toHaveTextContent('Delete v1?')
  })

  it('opens ⋯ on a click, not on hover, and closes it on a second click', async () => {
    const v1 = makeVersion({ version_number: 1 })
    const v2 = makeVersion({ version_number: 2 })
    useReviewStore.getState().setCurrentVersion(v2)
    render(<VersionSwitcher versions={[v1, v2]} canDelete />)
    const u = user()

    await openMenu()
    const dots = screen.getByRole('menuitem', { name: 'Actions for v1' })
    // Resting on the ⋯ (Radix opens a hovered submenu after 100 ms) and on
    // its row neither opens the submenu nor switches the version.
    await u.hover(dots)
    await new Promise((r) => setTimeout(r, 300))
    await u.hover(screen.getByRole('menuitem', { name: /^v1/ }))
    await u.hover(dots)
    await new Promise((r) => setTimeout(r, 300))
    expect(screen.getAllByRole('menu')).toHaveLength(1)
    expect(dots).toHaveAttribute('aria-expanded', 'false')
    expect(useReviewStore.getState().currentVersion?.id).toBe('v2')

    await u.click(dots)
    await waitFor(() => expect(screen.getAllByRole('menu')).toHaveLength(2))
    expect(screen.getByRole('menuitem', { name: 'Delete version' })).toBeInTheDocument()
    // Drifting off after the click keeps it open.
    await u.unhover(dots)
    await new Promise((r) => setTimeout(r, 300))
    expect(screen.getAllByRole('menu')).toHaveLength(2)

    await u.click(dots)
    await waitFor(() => expect(screen.getAllByRole('menu')).toHaveLength(1))
    expect(dots).toHaveAttribute('aria-expanded', 'false')
    expect(useReviewStore.getState().currentVersion?.id).toBe('v2')
  })

  it('opens ⋯ from the keyboard with Enter and Space too', async () => {
    const v1 = makeVersion({ version_number: 1 })
    const v2 = makeVersion({ version_number: 2 })
    useReviewStore.getState().setCurrentVersion(v2)
    render(<VersionSwitcher versions={[v1, v2]} canDelete />)
    const u = user()

    await openMenu()
    for (const key of ['{Enter}', ' ']) {
      screen.getByRole('menuitem', { name: 'Actions for v1' }).focus()
      await u.keyboard(key)
      await waitFor(() => expect(document.activeElement).toHaveTextContent('Delete version'))
      await u.keyboard('{ArrowLeft}')
      await waitFor(() => expect(screen.getAllByRole('menu')).toHaveLength(1))
    }
    expect(useReviewStore.getState().currentVersion?.id).toBe('v2')
  })

  it('has no menu, and so nothing to delete, when the asset has one version and none deleted', async () => {
    const v1 = makeVersion({ version_number: 1 })
    useReviewStore.getState().setCurrentVersion(v1)
    render(<VersionSwitcher versions={[v1]} canDelete />)

    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/assets/asset-1/deleted-versions'))
    expect(screen.queryByText(/delete/i)).toBeNull()
    await user().click(screen.getByRole('button', { name: /^v\d/ }))
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('greys out the ⋯, with the reason as a tooltip, when only an upload in flight is left beside it', async () => {
    const v1 = makeVersion({ version_number: 1 })
    const v2 = makeVersion({ version_number: 2, processing_status: 'uploading' })
    useReviewStore.getState().setCurrentVersion(v1)
    render(<VersionSwitcher versions={[v1, v2]} canDelete />)

    await openMenu()
    const dots = screen.getByRole('menuitem', { name: 'Actions for v1' })
    expect(dots).toHaveAttribute('aria-disabled', 'true')
    expect(dots).toHaveAttribute('data-unavailable')
    dots.focus()

    expect(await screen.findByRole('tooltip')).toHaveTextContent('Asset needs at least 1 playable version.')
    await user().click(dots)
    // Nothing opens: there is no submenu to show, and the version menu stays.
    expect(screen.getAllByRole('menu')).toHaveLength(1)
    expect(screen.queryByRole('menuitem', { name: 'Delete version' })).toBeNull()
  })

  it('greys out the ⋯ of the only live version with "Asset needs at least 1 version."', async () => {
    const v1 = makeVersion({ version_number: 1 })
    useReviewStore.getState().setCurrentVersion(v1)
    deletedList([makeDeleted(2)])
    render(<VersionSwitcher versions={[v1]} canDelete />)
    await waitFor(() => expect(api.get).toHaveBeenCalled())

    await openMenu()
    const dots = await screen.findByRole('menuitem', { name: 'Actions for v1' })
    await user().hover(dots)

    expect(dots).toHaveAttribute('aria-disabled', 'true')
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/^Asset needs at least 1 version\.$/)
  })

  it('reaches a greyed-out ⋯ with the arrow keys, and shows its reason there', async () => {
    const v1 = makeVersion({ version_number: 1 })
    useReviewStore.getState().setCurrentVersion(v1)
    deletedList([makeDeleted(2)])
    render(<VersionSwitcher versions={[v1]} canDelete />)
    await waitFor(() => expect(api.get).toHaveBeenCalled())
    const u = user()

    screen.getByRole('button', { name: /^v\d/ }).focus()
    await u.keyboard('{Enter}')
    await screen.findByRole('menu')
    await waitFor(() => expect(document.activeElement).toHaveTextContent('v1'))
    await u.keyboard('{ArrowDown}')

    await waitFor(() => expect(document.activeElement).toHaveAttribute('aria-label', 'Actions for v1'))
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Asset needs at least 1 version.')
  })

  it('points an upload in flight at the uploads panel', async () => {
    const v1 = makeVersion({ version_number: 1 })
    const v2 = makeVersion({ version_number: 2 })
    const v3 = makeVersion({ version_number: 3, processing_status: 'uploading' })
    useReviewStore.getState().setCurrentVersion(v2)
    render(<VersionSwitcher versions={[v1, v2, v3]} canDelete />)

    await openMenu()
    screen.getByRole('menuitem', { name: 'Actions for v3' }).focus()

    expect(await screen.findByRole('tooltip')).toHaveTextContent('Discard it in the uploads panel')
    expect(screen.getByRole('menuitem', { name: 'Actions for v1' })).not.toHaveAttribute('aria-disabled')
  })

  it('says a failed version cannot be restored before deleting it', async () => {
    const v1 = makeVersion({ version_number: 1 })
    const v2 = makeVersion({ version_number: 2, processing_status: 'failed' })
    useReviewStore.getState().setCurrentVersion(v1)
    render(<VersionSwitcher versions={[v1, v2]} canDelete />)

    await openMenu()
    await user().click(within(await openActions(2)).getByRole('menuitem', { name: 'Delete version' }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('A version that failed cannot be restored, so this cannot be undone.')
    expect(dialog).not.toHaveTextContent('where you can restore it')
  })

  it('asks before deleting, and sends nothing when cancelled', async () => {
    const v1 = makeVersion({ version_number: 1 })
    const v2 = makeVersion({ version_number: 2 })
    useReviewStore.getState().setCurrentVersion(v2)
    render(<VersionSwitcher versions={[v1, v2]} canDelete />)

    await openMenu()
    await user().click(within(await openActions(2)).getByRole('menuitem', { name: 'Delete version' }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Delete v2?')
    expect(dialog).toHaveTextContent('v1 becomes the current version, also on share links')
    await user().click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api.delete).not.toHaveBeenCalled()
    // The menu that opened the dialog is gone; the focus goes back to the switcher.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: /^v\d/ })))
  })

  it('deletes the shown version, moves to the new latest and lists it as deleted', async () => {
    const v1 = makeVersion({ version_number: 1 })
    const v2 = makeVersion({ version_number: 2 })
    const v3 = makeVersion({ version_number: 3 })
    useReviewStore.getState().setCurrentVersion(v3)
    vi.mocked(api.delete).mockResolvedValue({ latest_version: v2 })
    const onVersionsChanged = vi.fn()
    const onShownVersionDeleted = vi.fn()
    render(<VersionSwitcher versions={[v1, v2, v3]} canDelete onVersionsChanged={onVersionsChanged} onShownVersionDeleted={onShownVersionDeleted} />)

    await openMenu()
    await user().click(within(await openActions(3)).getByRole('menuitem', { name: 'Delete version' }))
    deletedList([makeDeleted(3)])
    await user().click(await screen.findByRole('button', { name: 'Delete version' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api.delete).toHaveBeenCalledWith('/assets/asset-1/versions/v3')
    expect(useReviewStore.getState().currentVersion?.id).toBe('v2')
    expect(onVersionsChanged).toHaveBeenCalledWith(v2)
    expect(onShownVersionDeleted).toHaveBeenCalledWith(v3, v2)
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2))
  })

  it('deleting another version leaves the one on screen alone', async () => {
    const v1 = makeVersion({ version_number: 1 })
    const v2 = makeVersion({ version_number: 2 })
    const v3 = makeVersion({ version_number: 3 })
    useReviewStore.getState().setCurrentVersion(v2)
    vi.mocked(api.delete).mockResolvedValue({ latest_version: v3 })
    const onShownVersionDeleted = vi.fn()
    render(<VersionSwitcher versions={[v1, v2, v3]} canDelete onShownVersionDeleted={onShownVersionDeleted} />)

    await openMenu()
    await user().click(within(await openActions(1)).getByRole('menuitem', { name: 'Delete version' }))
    await user().click(await screen.findByRole('button', { name: 'Delete version' }))

    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/assets/asset-1/versions/v1'))
    expect(useReviewStore.getState().currentVersion?.id).toBe('v2')
    expect(onShownVersionDeleted).not.toHaveBeenCalled()
  })

  it('moves to the newest ready version left, past one still processing', async () => {
    const v1 = makeVersion({ version_number: 1 })
    const v2 = makeVersion({ version_number: 2, processing_status: 'processing' })
    const v3 = makeVersion({ version_number: 3 })
    useReviewStore.getState().setCurrentVersion(v3)
    // The server's latest counts a processing version as showable.
    vi.mocked(api.delete).mockResolvedValue({ latest_version: v2 })
    render(<VersionSwitcher versions={[v1, v2, v3]} canDelete />)

    await openMenu()
    await user().click(within(await openActions(3)).getByRole('menuitem', { name: 'Delete version' }))
    await user().click(await screen.findByRole('button', { name: 'Delete version' }))

    await waitFor(() => expect(useReviewStore.getState().currentVersion?.id).toBe('v1'))
  })

  it('keeps the dialog open with the server\'s reason when the delete is refused', async () => {
    const v1 = makeVersion({ version_number: 1 })
    const v2 = makeVersion({ version_number: 2 })
    useReviewStore.getState().setCurrentVersion(v2)
    vi.mocked(api.delete).mockRejectedValue(
      new ApiError(409, 'This is the only version of this asset. Delete the asset instead.'),
    )
    const onVersionsChanged = vi.fn()
    render(<VersionSwitcher versions={[v1, v2]} canDelete onVersionsChanged={onVersionsChanged} />)

    await openMenu()
    await user().click(within(await openActions(2)).getByRole('menuitem', { name: 'Delete version' }))
    await user().click(await screen.findByRole('button', { name: 'Delete version' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Delete the asset instead')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(useReviewStore.getState().currentVersion?.id).toBe('v2')
    expect(onVersionsChanged).not.toHaveBeenCalled()
  })
})

describe('VersionSwitcher set as current version', () => {
  beforeEach(() => {
    useReviewStore.getState().reset()
    vi.mocked(api.put).mockReset()
    vi.mocked(api.get).mockReset()
    deletedList([])
  })

  /** v1 and v2 ready, v3 processing, v4 failed; v2 is the current one. */
  function three() {
    const v1 = makeVersion({ version_number: 1, is_current: false })
    const v2 = makeVersion({ version_number: 2, is_current: true })
    const v3 = makeVersion({ version_number: 3, processing_status: 'processing', is_current: false })
    const v4 = makeVersion({ version_number: 4, processing_status: 'failed', is_current: false })
    return [v1, v2, v3, v4]
  }

  it('labels the current version, also for someone who may not change it', async () => {
    const versions = three()
    useReviewStore.getState().setCurrentVersion(versions[0])
    render(<VersionSwitcher versions={versions} />)

    await openMenu()

    expect(within(screen.getByTestId('version-row-v2')).getByText('Current')).toBeInTheDocument()
    for (const n of [1, 3, 4]) {
      expect(within(screen.getByTestId(`version-row-v${n}`)).queryByText('Current')).toBeNull()
    }
  })

  it('offers it behind the ⋯ of a ready version that is not current, and nowhere else', async () => {
    const versions = three()
    useReviewStore.getState().setCurrentVersion(versions[1])
    render(<VersionSwitcher versions={versions} canDelete />)
    await openMenu()

    const actions = await openActions(1)
    expect(within(actions).getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Set as current version', 'Delete version'])
    await user().keyboard('{Escape}')

    for (const n of [2, 3, 4]) {
      await openMenu()
      const menu = await openActions(n)
      expect(within(menu).queryByRole('menuitem', { name: 'Set as current version' })).toBeNull()
      expect(within(menu).getByRole('menuitem', { name: 'Delete version' })).toBeInTheDocument()
      await user().keyboard('{Escape}')
    }
  })

  it('sets it, says so, and leaves the view where it is', async () => {
    const versions = three()
    const latest = { ...versions[0], is_current: true }
    vi.mocked(api.put).mockResolvedValue({ latest_version: latest })
    const onVersionsChanged = vi.fn()
    const onCurrentVersionSet = vi.fn()
    useReviewStore.getState().setCurrentVersion(versions[1])
    render(<VersionSwitcher versions={versions} canDelete
      onVersionsChanged={onVersionsChanged} onCurrentVersionSet={onCurrentVersionSet} />)

    await openMenu()
    const actions = await openActions(1)
    await user().click(within(actions).getByRole('menuitem', { name: 'Set as current version' }))

    await waitFor(() => expect(onCurrentVersionSet).toHaveBeenCalledWith(versions[0]))
    expect(api.put).toHaveBeenCalledWith('/assets/asset-1/current-version', { version_id: 'v1' })
    expect(onVersionsChanged).toHaveBeenCalledWith(latest)
    expect(useReviewStore.getState().currentVersion?.id).toBe('v2')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  })

  it('says why when the server refuses, and keeps the menu open', async () => {
    const versions = three()
    vi.mocked(api.put).mockRejectedValue(
      new ApiError(409, 'Only a version that is ready can be the current version.'))
    const onVersionsChanged = vi.fn()
    const onCurrentVersionSet = vi.fn()
    useReviewStore.getState().setCurrentVersion(versions[1])
    render(<VersionSwitcher versions={versions} canDelete
      onVersionsChanged={onVersionsChanged} onCurrentVersionSet={onCurrentVersionSet} />)

    await openMenu()
    const actions = await openActions(1)
    await user().click(within(actions).getByRole('menuitem', { name: 'Set as current version' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'v1: Only a version that is ready can be the current version.')
    expect(screen.getAllByRole('menu').length).toBeGreaterThan(0)
    expect(onVersionsChanged).not.toHaveBeenCalled()
    expect(onCurrentVersionSet).not.toHaveBeenCalled()
    expect(useReviewStore.getState().currentVersion?.id).toBe('v2')
  })
})

describe('VersionSwitcher deleting around the current version', () => {
  beforeEach(() => {
    useReviewStore.getState().reset()
    vi.mocked(api.delete).mockReset()
    vi.mocked(api.get).mockReset()
    deletedList([])
  })

  async function dialogFor(versions: AssetVersion[], n: number) {
    render(<VersionSwitcher versions={versions} canDelete />)
    await openMenu()
    await user().click(within(await openActions(n)).getByRole('menuitem', { name: 'Delete version' }))
    return screen.findByRole('dialog')
  }

  it('names the next latest when the version set as current is deleted', async () => {
    const v1 = makeVersion({ version_number: 1, is_current: true })
    const v2 = makeVersion({ version_number: 2, is_current: false })
    const v3 = makeVersion({ version_number: 3, is_current: false })
    useReviewStore.getState().setCurrentVersion(v3)

    const dialog = await dialogFor([v1, v2, v3], 1)

    expect(dialog).toHaveTextContent('v3 becomes the current version, also on share links')
  })

  it('promises no change on share links when the newest goes while another is current', async () => {
    const v1 = makeVersion({ version_number: 1, is_current: true })
    const v2 = makeVersion({ version_number: 2, is_current: false })
    useReviewStore.getState().setCurrentVersion(v2)

    const dialog = await dialogFor([v1, v2], 2)

    expect(dialog).toHaveTextContent('Delete v2?')
    expect(dialog).not.toHaveTextContent('becomes the current version')
  })

  it('moves to the version set as current when the one on screen is deleted', async () => {
    const v1 = makeVersion({ version_number: 1, is_current: true })
    const v2 = makeVersion({ version_number: 2, is_current: false })
    const v3 = makeVersion({ version_number: 3, is_current: false })
    useReviewStore.getState().setCurrentVersion(v3)
    vi.mocked(api.delete).mockResolvedValue({ latest_version: v1 })
    const onShownVersionDeleted = vi.fn()
    render(<VersionSwitcher versions={[v1, v2, v3]} canDelete onShownVersionDeleted={onShownVersionDeleted} />)

    await openMenu()
    await user().click(within(await openActions(3)).getByRole('menuitem', { name: 'Delete version' }))
    await user().click(await screen.findByRole('button', { name: 'Delete version' }))

    await waitFor(() => expect(useReviewStore.getState().currentVersion?.id).toBe('v1'))
    expect(onShownVersionDeleted).toHaveBeenCalledWith(v3, v1)
  })
})

describe('VersionSwitcher deleted versions (#419)', () => {
  beforeEach(() => {
    useReviewStore.getState().reset()
    vi.mocked(api.post).mockReset()
    vi.mocked(api.get).mockReset()
  })

  it('lists a deleted version in its place as Deleted, even beside a single live one', async () => {
    const v1 = makeVersion({ version_number: 1 })
    const v3 = makeVersion({ version_number: 3 })
    useReviewStore.getState().setCurrentVersion(v3)
    deletedList([makeDeleted(2)])
    render(<VersionSwitcher versions={[v1, v3]} canDelete />)

    const menu = await openMenu()
    const row = await within(menu).findByTestId('version-row-v2')
    const labels = within(menu).getAllByTestId(/^version-row-v/).map((r) => r.dataset.testid)

    expect(labels).toEqual(['version-row-v1', 'version-row-v2', 'version-row-v3'])
    expect(row).toHaveTextContent('Deleted')
    expect(row).not.toHaveTextContent('Ready')
  })

  it('opens the list for one live version when there is a deleted one to restore', async () => {
    const v1 = makeVersion({ version_number: 1 })
    useReviewStore.getState().setCurrentVersion(v1)
    deletedList([makeDeleted(2)])
    render(<VersionSwitcher versions={[v1]} canDelete />)

    await waitFor(() => expect(api.get).toHaveBeenCalled())
    const menu = await openMenu()

    expect(await within(menu).findByTestId('version-row-v2')).toHaveTextContent('Deleted')
  })

  it('cannot be watched: choosing the row does nothing', async () => {
    const v1 = makeVersion({ version_number: 1 })
    const v3 = makeVersion({ version_number: 3 })
    useReviewStore.getState().setCurrentVersion(v3)
    deletedList([makeDeleted(2)])
    render(<VersionSwitcher versions={[v1, v3]} canDelete />)

    const menu = await openMenu()
    const row = await within(menu).findByTestId('version-row-v2')
    const item = within(row).getAllByRole('menuitem')[0]
    expect(item).toHaveAttribute('data-disabled')
    await user().click(item)

    expect(useReviewStore.getState().currentVersion?.id).toBe('v3')
  })

  it('offers Restore, not Delete, behind its ⋯, and restores it', async () => {
    const v1 = makeVersion({ version_number: 1 })
    const v2 = makeVersion({ version_number: 2 })
    useReviewStore.getState().setCurrentVersion(v2)
    deletedList([makeDeleted(3)])
    const restoredLatest = makeVersion({ version_number: 3 })
    vi.mocked(api.post).mockResolvedValue({ latest_version: restoredLatest })
    const onVersionsChanged = vi.fn()
    render(<VersionSwitcher versions={[v1, v2]} canDelete onVersionsChanged={onVersionsChanged} />)

    await openMenu()
    await screen.findByTestId('version-row-v3')
    const actions = await openActions(3)
    expect(within(actions).queryByRole('menuitem', { name: 'Delete version' })).toBeNull()
    await user().click(within(actions).getByRole('menuitem', { name: 'Restore version' }))

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/assets/asset-1/versions/v3/restore'))
    expect(onVersionsChanged).toHaveBeenCalledWith(restoredLatest)
    // v3 is the new latest, and still the view stays where it was.
    expect(useReviewStore.getState().currentVersion?.id).toBe('v2')
    await openMenu()
    expect(screen.queryByTestId('version-row-v3')).toBeNull()
  })

  it('says why when a restore is refused, and keeps the row', async () => {
    const v1 = makeVersion({ version_number: 1 })
    const v2 = makeVersion({ version_number: 2 })
    useReviewStore.getState().setCurrentVersion(v2)
    deletedList([makeDeleted(3)])
    vi.mocked(api.post).mockRejectedValue(new ApiError(404, 'Deleted version not found'))
    const onVersionsChanged = vi.fn()
    render(<VersionSwitcher versions={[v1, v2]} canDelete onVersionsChanged={onVersionsChanged} />)

    await openMenu()
    await screen.findByTestId('version-row-v3')
    await user().click(within(await openActions(3)).getByRole('menuitem', { name: 'Restore version' }))
    await waitFor(() => expect(api.post).toHaveBeenCalled())

    expect(onVersionsChanged).not.toHaveBeenCalled()
    // The list was asked again, and the reason is in the menu once it is open.
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2))
    // The menu stays open to say why.
    const menu = screen.getAllByRole('menu')[0]
    expect(await within(menu).findByRole('alert')).toHaveTextContent('v3: Deleted version not found')
    expect(within(menu).getByTestId('version-row-v3')).toBeInTheDocument()
  })

  it('names how long it can still be restored, in days', async () => {
    const v1 = makeVersion({ version_number: 1 })
    useReviewStore.getState().setCurrentVersion(v1)
    const until = new Date(Date.now() + 12 * 24 * 60 * 60 * 1000 - 60_000).toISOString()
    deletedList([makeDeleted(2, { restorable_until: until })])
    render(<VersionSwitcher versions={[v1]} canDelete />)

    await waitFor(() => expect(api.get).toHaveBeenCalled())
    const menu = await openMenu()

    expect(await within(menu).findByTestId('version-row-v2')).toHaveTextContent('restorable for 12 days')
  })

  it('drops the deleted versions it holds once the right to restore goes', async () => {
    const v1 = makeVersion({ version_number: 1 })
    const v3 = makeVersion({ version_number: 3 })
    useReviewStore.getState().setCurrentVersion(v3)
    deletedList([makeDeleted(2)])
    const { rerender } = render(<VersionSwitcher versions={[v1, v3]} canDelete />)
    await waitFor(() => expect(api.get).toHaveBeenCalled())
    await openMenu()
    await screen.findByTestId('version-row-v2')
    await user().keyboard('{Escape}')

    rerender(<VersionSwitcher versions={[v1, v3]} canDelete={false} />)
    await openMenu()

    expect(screen.queryByTestId('version-row-v2')).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /Actions for/ })).toBeNull()
  })

  it('never lists deleted versions without the right to restore them', async () => {
    const v1 = makeVersion({ version_number: 1 })
    useReviewStore.getState().setCurrentVersion(v1)
    deletedList([makeDeleted(2)])
    render(<VersionSwitcher versions={[v1]} />)

    expect(api.get).not.toHaveBeenCalled()
    await user().click(screen.getByRole('button', { name: /^v\d/ }))
    expect(screen.queryByRole('menu')).toBeNull()
  })
})

describe('restorableFor', () => {
  const now = Date.parse('2026-11-04T12:00:00Z')
  const at = (iso: string | null) => restorableFor(makeDeleted(2, { restorable_until: iso }), now)

  it('counts whole days up, never weeks', () => {
    expect(at('2026-12-04T11:00:00Z')).toBe('restorable for 30 days')
    expect(at('2026-11-05T11:00:00Z')).toBe('restorable for 1 more day')
  })

  it('says it goes at the next cleanup once the window has passed', () => {
    expect(at('2026-11-04T11:00:00Z')).toBe('removed at the next cleanup')
  })

  it('says nothing while the purge is off', () => {
    expect(at(null)).toBeNull()
  })
})

describe('deleteVersionBlocker', () => {
  const v = (n: number, processing_status: AssetVersion['processing_status'] = 'ready') =>
    makeVersion({ version_number: n, processing_status })

  it('allows a version beside another that is ready or processing', () => {
    for (const other of ['ready', 'processing'] as const) {
      expect(deleteVersionBlocker(v(1), [v(1), v(2, other)])).toBeNull()
    }
    expect(deleteVersionBlocker(v(2, 'failed'), [v(1), v(2, 'failed')])).toBeNull()
  })

  it('refuses the last version that is ready or processing, honestly worded', () => {
    expect(deleteVersionBlocker(v(1), [v(1)])).toBe('Asset needs at least 1 version.')
    for (const other of ['uploading', 'failed'] as const) {
      expect(deleteVersionBlocker(v(1), [v(1), v(2, other)])).toBe('Asset needs at least 1 playable version.')
    }
  })

  it('refuses an upload in flight and points at discarding it', () => {
    expect(deleteVersionBlocker(v(2, 'uploading'), [v(1), v(2, 'uploading')])).toBe(
      'Still uploading. Discard it in the uploads panel.')
  })
})
