import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { useReviewStore } from '@/stores/review-store'
import { CommentPanel } from '../comment-panel'

// #492: DELETE /comments/{id} lets a project owner remove anyone's comment, but
// the menu was gated on authorship alone, so an owner had no way to reach it.
// Moderation is delete only: the owner must not be offered Edit on someone
// else's words.

beforeEach(() => {
  useReviewStore.getState().reset()
  Element.prototype.scrollIntoView = vi.fn()
})

const noop = async () => {}

function comment(overrides: Record<string, unknown>) {
  return {
    id: 'c1', asset_id: 'a1', version_id: 'v1', parent_id: null,
    author_id: 'u-other', author: { id: 'u-other', name: 'Maya Chen', avatar_url: null },
    body: 'A note', timecode_start: null, timecode_end: null,
    resolved: false, visibility: 'public',
    created_at: '2026-01-01T10:00:00.000Z', updated_at: '2026-01-01T10:00:00.000Z',
    replies: [], reactions: [], attachments: [],
    ...overrides,
  } as never
}

const guestComment = comment({
  id: 'c-guest', author_id: null, author: null,
  guest_author: { id: 'g1', name: 'Guest Reviewer', email: 'g@example.com' },
  body: 'Guest note',
})

function renderPanel(
  comments: never[],
  { canModerate, onDelete = vi.fn().mockResolvedValue(undefined) }:
    { canModerate?: boolean; onDelete?: (id: string) => Promise<void> } = {},
) {
  render(
    <CommentPanel
      comments={comments}
      currentUserId="u-me"
      canModerate={canModerate}
      onResolve={noop} onDelete={onDelete}
      onAddReaction={noop} onRemoveReaction={noop}
      onReply={() => {}}
    />,
  )
  return onDelete
}

function menuButtons() {
  return screen.queryAllByRole('button', { name: 'Comment actions' })
}

describe('CommentPanel moderation menu', () => {
  it('offers no menu on another author\'s comment without canModerate', () => {
    renderPanel([comment({})])
    expect(screen.getByText('A note')).toBeTruthy()
    expect(menuButtons()).toHaveLength(0)
  })

  it('offers Delete and Copy Link, but not Edit, on another author\'s comment to a moderator', () => {
    const onDelete = renderPanel([comment({})], { canModerate: true })

    expect(menuButtons()).toHaveLength(1)
    fireEvent.click(menuButtons()[0])
    expect(screen.getByRole('button', { name: 'Copy Link' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(onDelete).toHaveBeenCalledWith('c1')
  })

  it('lets a moderator delete a guest comment', () => {
    const onDelete = renderPanel([guestComment], { canModerate: true })

    expect(menuButtons()).toHaveLength(1)
    fireEvent.click(menuButtons()[0])
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(onDelete).toHaveBeenCalledWith('c-guest')
  })

  it('reaches replies too', () => {
    const reply = comment({ id: 'r1', parent_id: 'c1', body: 'A reply' })
    const onDelete = renderPanel(
      [comment({ author_id: 'u-me', author: { id: 'u-me', name: 'Me', avatar_url: null }, replies: [reply] })],
      { canModerate: true },
    )

    const buttons = menuButtons()
    expect(buttons).toHaveLength(2)
    fireEvent.click(buttons[1])
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(onDelete).toHaveBeenCalledWith('r1')
  })

  it('still offers Edit on the viewer\'s own comment', () => {
    renderPanel([comment({ author_id: 'u-me', author: { id: 'u-me', name: 'Me', avatar_url: null } })])

    fireEvent.click(menuButtons()[0])
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy()
  })
})
