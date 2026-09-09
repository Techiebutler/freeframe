import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const { exportComments, FakeFpsRequiredError } = vi.hoisted(() => {
  class FakeFpsRequiredError extends Error {}
  return { exportComments: vi.fn(), FakeFpsRequiredError }
})

vi.mock('@/lib/export-comments', () => ({
  exportComments,
  FpsRequiredError: FakeFpsRequiredError,
}))

import { useReviewStore } from '@/stores/review-store'
import { CommentPanel } from '../comment-panel'

const noop = async () => {}

/** The asset someone opened earlier and left behind in the review store. */
const STALE = { id: 'previously-opened', asset_type: 'video' } as never
/** The asset the project page is actually showing. */
const SELECTED = { id: 'selected-in-grid', asset_type: 'video' } as never

const comment = {
  id: 'c1', asset_id: 'a1', version_id: 'v1', parent_id: null,
  author: { id: 'u1', name: 'Maya Chen', avatar_url: null },
  body: 'check the cut', timecode_start: 12, timecode_end: null,
  resolved: false, visibility: 'public',
  created_at: '2026-09-05T10:00:00.000Z', updated_at: '2026-09-05T10:00:00.000Z',
  replies: [], reactions: [], attachments: [],
} as never

beforeEach(() => {
  useReviewStore.getState().reset()
  // The state that makes this bug reachable: the store is never cleared, so
  // after opening any asset and navigating back it still holds one.
  useReviewStore.getState().setCurrentAsset(STALE)
  useReviewStore.getState().setCurrentVersion({ id: 'stale-version' } as never)
  Element.prototype.scrollIntoView = vi.fn()
  exportComments.mockReset()
  exportComments.mockResolvedValue(undefined)
})

function renderPanel(props: Record<string, unknown> = {}) {
  return render(
    <CommentPanel
      comments={[comment]}
      onResolve={noop} onDelete={noop}
      onAddReaction={noop} onRemoveReaction={noop}
      onReply={() => {}}
      {...props}
    />,
  )
}

function chooseExport(label: string) {
  fireEvent.click(screen.getByTitle('Export comments'))
  fireEvent.click(screen.getByText(label))
}

describe('which asset the export acts on', () => {
  it('uses the asset it was given, not the one left in the store', async () => {
    // The bug: on the project page this exported the previously opened asset's
    // comments, as a successful download named after it. "Nothing happens" was
    // the good case; this was one click away.
    renderPanel({ exportAsset: SELECTED, exportVersionId: 'selected-version' })

    chooseExport('DaVinci Resolve (EDL)')

    await waitFor(() => expect(exportComments).toHaveBeenCalled())
    expect(exportComments.mock.calls[0][0]).toMatchObject({
      assetId: 'selected-in-grid',
      versionId: 'selected-version',
    })
  })

  it('still reads the store when it was told nothing', async () => {
    // The review screen passes neither prop and must keep working.
    renderPanel()

    chooseExport('DaVinci Resolve (EDL)')

    await waitFor(() => expect(exportComments).toHaveBeenCalled())
    expect(exportComments.mock.calls[0][0]).toMatchObject({
      assetId: 'previously-opened',
    })
  })

  it('treats an explicit null as "nothing selected", not as "ask the store"', async () => {
    // The distinction the whole fix rests on. `undefined` means the caller has
    // no opinion; `null` means it has one and the answer is nothing. Collapsing
    // them puts the stale asset back.
    renderPanel({ exportAsset: null })

    chooseExport('CSV')

    expect(await screen.findByText('Select an asset to export its comments')).toBeTruthy()
    expect(exportComments).not.toHaveBeenCalled()
  })

  it('offers the NLE formats for the given asset, not the stored one', () => {
    // The menu is gated on asset_type. With an audio asset selected and a video
    // asset stale in the store, the gate must follow the selection.
    renderPanel({ exportAsset: { id: 'a-song', asset_type: 'audio' } as never })

    fireEvent.click(screen.getByTitle('Export comments'))

    expect(screen.queryByText('DaVinci Resolve (EDL)')).toBeNull()
    expect(screen.getByText('CSV')).toBeTruthy()
  })

  it('says so instead of returning silently when there is no version either', async () => {
    // An asset but no version: reachable on a project page whose selected asset
    // has no readable latest_version yet.
    useReviewStore.getState().reset()
    useReviewStore.getState().setCurrentAsset(STALE)
    renderPanel({ exportAsset: SELECTED, exportVersionId: undefined })

    chooseExport('CSV')

    expect(await screen.findByText('Select an asset to export its comments')).toBeTruthy()
  })
})
