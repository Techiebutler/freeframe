import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

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
  body: 'check the cut', timecode_start: 12, timecode_end: null,
  resolved: false, visibility: 'public',
  created_at: '2026-09-05T10:00:00.000Z', updated_at: '2026-09-05T10:00:00.000Z',
  replies: [], reactions: [], attachments: [],
} as never

beforeEach(() => {
  useReviewStore.getState().reset()
  useReviewStore.getState().setCurrentAsset({ id: 'a1', asset_type: 'video' } as never)
  useReviewStore.getState().setCurrentVersion({ id: 'v1' } as never)
  Element.prototype.scrollIntoView = vi.fn()
  exportComments.mockReset()
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

/**
 * `exportComments` sends `Authorization: Bearer ${getAccessToken()}` and nothing
 * else, and a share-link guest has no access token, so the request is a
 * guaranteed 401. Offering the control at all is the bug: before the export
 * errors were surfaced the 401 went to `console.error` and nobody saw it, and
 * afterwards a guest gets a bare "Export failed (401)" instead.
 *
 * Export also returns every comment on the version including author names, so
 * widening a share link to reach it is a decision of its own rather than
 * something that should arrive as a bug fix.
 */
describe('the export control is offered only to someone who can authenticate', () => {
  it('is absent when the panel says export is not available', () => {
    renderPanel({ canExport: false })
    expect(screen.queryByTitle('Export comments')).toBeNull()
  })

  it('is present by default, so the signed-in review screen is unaffected', () => {
    renderPanel()
    expect(screen.getByTitle('Export comments')).toBeTruthy()
  })
})
