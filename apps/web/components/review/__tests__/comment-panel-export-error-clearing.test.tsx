import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

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

const REFUSAL = 'No comments on this version carry a timecode'

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
  useReviewStore.getState().setCurrentAsset({ id: 'a1', asset_type: 'video' } as never)
  useReviewStore.getState().setCurrentVersion({ id: 'v2' } as never)
  Element.prototype.scrollIntoView = vi.fn()
  exportComments.mockReset()
  exportComments.mockRejectedValue(new Error(REFUSAL))
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

async function provokeRefusal() {
  fireEvent.click(screen.getByTitle('Export comments'))
  fireEvent.click(screen.getByText('DaVinci Resolve (EDL)'))
  await screen.findByText(REFUSAL)
}

describe('how long an export refusal stays on screen', () => {
  it('goes away when the version switcher moves to another version', async () => {
    // The panel and the version switcher are siblings in one mounted tree with
    // no `key`, so nothing remounts here: without an explicit clear, a refusal
    // about v2 sits above v1's fully timecoded comments.
    renderPanel()
    await provokeRefusal()

    act(() => {
      useReviewStore.getState().setCurrentVersion({ id: 'v1' } as never)
    })

    await waitFor(() => expect(screen.queryByText(REFUSAL)).toBeNull())
  })

  it('goes away when the panel is pointed at another asset', async () => {
    // The project page's shape: one mounted panel, a different asset selected
    // in the grid behind it.
    const { rerender } = renderPanel({
      exportAsset: { id: 'first', asset_type: 'video' } as never,
      exportVersionId: 'first-version',
    })
    await provokeRefusal()

    rerender(
      <CommentPanel
        comments={[comment]}
        onResolve={noop} onDelete={noop}
        onAddReaction={noop} onRemoveReaction={noop}
        onReply={() => {}}
        exportAsset={{ id: 'second', asset_type: 'video' } as never}
        exportVersionId="second-version"
      />,
    )

    await waitFor(() => expect(screen.queryByText(REFUSAL)).toBeNull())
  })

  it('goes away when the export menu is opened again', async () => {
    renderPanel()
    await provokeRefusal()

    fireEvent.click(screen.getByTitle('Export comments'))

    await waitFor(() => expect(screen.queryByText(REFUSAL)).toBeNull())
  })

  it('survives a render that changes neither asset nor version', async () => {
    // The deps have to be the ids and not the objects: the store hands out a
    // fresh object on every unrelated update, and clearing on those would make
    // the message flicker away before it has been read.
    renderPanel()
    await provokeRefusal()

    act(() => {
      useReviewStore.getState().setCurrentAsset({ id: 'a1', asset_type: 'video' } as never)
    })

    expect(screen.getByText(REFUSAL)).toBeInTheDocument()
  })
})
