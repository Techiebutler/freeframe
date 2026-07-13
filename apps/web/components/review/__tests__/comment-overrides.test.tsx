import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { useReviewStore } from '@/stores/review-store'
import { CommentPanel } from '../comment-panel'

beforeEach(() => {
  useReviewStore.getState().reset()
  // jsdom does not implement scrollIntoView; CommentItem calls it when it
  // becomes focused (which the timecode click below also triggers via the
  // bubbled row onClick). Unrelated to the override contract under test.
  Element.prototype.scrollIntoView = vi.fn()
})

const noop = async () => {}

function timecodedComment() {
  return {
    id: 'c1', asset_id: 'a1', version_id: 'v1', parent_id: null,
    author: { id: 'u1', name: 'Maya Chen', avatar_url: null },
    body: 'Fix the logo', timecode_start: 2.52, timecode_end: null,
    resolved: false, visibility: 'public',
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    replies: [], reactions: [], attachments: [],
  } as never
}

describe('CommentPanel onSeekToTimecode', () => {
  it('routes timecode clicks through the override instead of the store', () => {
    const onSeek = vi.fn()
    const storeSeek = vi.spyOn(useReviewStore.getState(), 'seekTo')
    render(
      <CommentPanel
        comments={[timecodedComment()]}
        onResolve={noop} onDelete={noop}
        onAddReaction={noop} onRemoveReaction={noop}
        onReply={() => {}}
        onSeekToTimecode={onSeek}
      />,
    )
    fireEvent.click(screen.getByText(/0:02/))
    expect(onSeek).toHaveBeenCalledWith(2.52, true)
    expect(storeSeek).not.toHaveBeenCalled()
  })
})
