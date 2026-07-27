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

const DRAWING = { objects: [], _canvasWidth: 640, _canvasHeight: 360 }

function annotatedComment() {
  return {
    ...(timecodedComment() as Record<string, unknown>),
    annotation: { id: 'ann1', comment_id: 'c1', drawing_data: DRAWING },
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

describe('CommentPanel onShowAnnotation', () => {
  it('routes the Show annotation button through the override instead of the store', () => {
    const onShow = vi.fn()
    render(
      <CommentPanel
        comments={[annotatedComment()]}
        onResolve={noop} onDelete={noop}
        onAddReaction={noop} onRemoveReaction={noop}
        onReply={() => {}}
        onSeekToTimecode={vi.fn()}
        onShowAnnotation={onShow}
      />,
    )
    fireEvent.click(screen.getByTitle('Show annotation'))
    expect(onShow).toHaveBeenCalledWith(DRAWING)
    expect(useReviewStore.getState().activeAnnotation).toBeNull()
  })

  it('routes the whole-row click through the override (annotated comment)', () => {
    const onShow = vi.fn()
    render(
      <CommentPanel
        comments={[annotatedComment()]}
        onResolve={noop} onDelete={noop}
        onAddReaction={noop} onRemoveReaction={noop}
        onReply={() => {}}
        onSeekToTimecode={vi.fn()}
        onShowAnnotation={onShow}
      />,
    )
    fireEvent.click(screen.getByText('Fix the logo'))
    expect(onShow).toHaveBeenCalledWith(DRAWING)
    expect(useReviewStore.getState().activeAnnotation).toBeNull()
  })

  it('row click on a drawing-less comment routes null through the override', () => {
    const onShow = vi.fn()
    render(
      <CommentPanel
        comments={[timecodedComment()]}
        onResolve={noop} onDelete={noop}
        onAddReaction={noop} onRemoveReaction={noop}
        onReply={() => {}}
        onSeekToTimecode={vi.fn()}
        onShowAnnotation={onShow}
      />,
    )
    fireEvent.click(screen.getByText('Fix the logo'))
    expect(onShow).toHaveBeenCalledWith(null)
    expect(useReviewStore.getState().activeAnnotation).toBeNull()
  })

  it('timecode-badge click routes the annotation through the override', () => {
    const onShow = vi.fn()
    render(
      <CommentPanel
        comments={[annotatedComment()]}
        onResolve={noop} onDelete={noop}
        onAddReaction={noop} onRemoveReaction={noop}
        onReply={() => {}}
        onSeekToTimecode={vi.fn()}
        onShowAnnotation={onShow}
      />,
    )
    fireEvent.click(screen.getByText(/0:02/))
    expect(onShow).toHaveBeenCalledWith(DRAWING)
    expect(useReviewStore.getState().activeAnnotation).toBeNull()
  })

  it('defaults to the store when the override is omitted', () => {
    render(
      <CommentPanel
        comments={[annotatedComment()]}
        onResolve={noop} onDelete={noop}
        onAddReaction={noop} onRemoveReaction={noop}
        onReply={() => {}}
        onSeekToTimecode={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTitle('Show annotation'))
    expect(useReviewStore.getState().activeAnnotation).toEqual(DRAWING)
  })
})
