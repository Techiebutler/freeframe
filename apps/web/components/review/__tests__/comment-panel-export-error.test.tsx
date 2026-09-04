import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// vi.hoisted, because vi.mock is lifted above the imports and its factory may
// not reach a plain top-level binding.
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

const comment = {
  id: 'c1', asset_id: 'a1', version_id: 'v1', parent_id: null,
  author: { id: 'u1', name: 'Maya Chen', avatar_url: null },
  body: '30:20 audio cuts out', timecode_start: null, timecode_end: null,
  resolved: false, visibility: 'public',
  created_at: '2026-09-04T10:00:00.000Z', updated_at: '2026-09-04T10:00:00.000Z',
  replies: [], reactions: [], attachments: [],
} as never

beforeEach(() => {
  useReviewStore.getState().reset()
  useReviewStore.getState().setCurrentAsset({ id: 'a1', asset_type: 'video' } as never)
  useReviewStore.getState().setCurrentVersion({ id: 'v1' } as never)
  Element.prototype.scrollIntoView = vi.fn()
  exportComments.mockReset()
})

function renderPanel() {
  return render(
    <CommentPanel
      comments={[comment]}
      onResolve={noop} onDelete={noop}
      onAddReaction={noop} onRemoveReaction={noop}
      onReply={() => {}}
    />,
  )
}

function chooseExport(label: string) {
  fireEvent.click(screen.getByTitle('Export comments'))
  fireEvent.click(screen.getByText(label))
}

describe('a failed comment export', () => {
  it('shows the reason in the panel instead of the console', async () => {
    // The failure this exists for: a version whose comments carry their times
    // in the text rather than as a timecode exports to an empty marker file, so
    // the server refuses and explains. Sending that to console.error left the
    // click looking like it had done nothing at all.
    exportComments.mockRejectedValue(
      new Error("None of this version's comments are attached to a timecode."),
    )
    renderPanel()

    chooseExport('DaVinci Resolve (EDL)')

    expect(
      await screen.findByText("None of this version's comments are attached to a timecode."),
    ).toBeTruthy()
  })

  it('says something even when the error carries no message', async () => {
    exportComments.mockRejectedValue(new Error(''))
    renderPanel()

    chooseExport('CSV')

    expect(await screen.findByText('Export failed')).toBeTruthy()
  })

  it('leaves the frame-rate case to its prompt rather than the message line', async () => {
    // That one is answerable: the user picks a rate and the export retries. It
    // must not also leave an error sitting in the panel.
    exportComments.mockRejectedValue(new FakeFpsRequiredError())
    renderPanel()

    chooseExport('DaVinci Resolve (EDL)')

    await waitFor(() => expect(exportComments).toHaveBeenCalled())
    expect(screen.queryByText(/Export failed/)).toBeNull()
  })

  it('clears a previous failure when the next export is attempted', async () => {
    exportComments.mockRejectedValueOnce(new Error('Unsupported frame rate 12'))
    renderPanel()
    chooseExport('CSV')
    expect(await screen.findByText('Unsupported frame rate 12')).toBeTruthy()

    exportComments.mockResolvedValueOnce(undefined)
    chooseExport('CSV')

    await waitFor(() =>
      expect(screen.queryByText('Unsupported frame rate 12')).toBeNull(),
    )
  })
})
