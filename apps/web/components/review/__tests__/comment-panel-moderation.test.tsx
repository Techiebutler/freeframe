import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
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

// The comment menu is a Radix DropdownMenu: it opens on pointerdown and its
// entries are menuitems rendered in a portal.
async function openMenu(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
  await screen.findByRole('menu')
}

function menuItem(name: string) {
  return screen.queryByRole('menuitem', { name })
}

describe('CommentPanel moderation menu', () => {
  it('offers no menu on another author\'s comment without canModerate', () => {
    renderPanel([comment({})])
    expect(screen.getByText('A note')).toBeTruthy()
    expect(menuButtons()).toHaveLength(0)
  })

  it('offers Delete and Copy Link, but not Edit, on another author\'s comment to a moderator', async () => {
    const onDelete = renderPanel([comment({})], { canModerate: true })

    expect(menuButtons()).toHaveLength(1)
    await openMenu(menuButtons()[0])
    expect(menuItem('Copy Link')).toBeTruthy()
    expect(menuItem('Edit')).toBeNull()

    fireEvent.click(menuItem('Delete')!)
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith('c1'))
  })

  it('lets a moderator delete a guest comment', async () => {
    const onDelete = renderPanel([guestComment], { canModerate: true })

    expect(menuButtons()).toHaveLength(1)
    await openMenu(menuButtons()[0])
    fireEvent.click(menuItem('Delete')!)
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith('c-guest'))
  })

  it('reaches replies too', async () => {
    const reply = comment({ id: 'r1', parent_id: 'c1', body: 'A reply' })
    const onDelete = renderPanel(
      [comment({ author_id: 'u-me', author: { id: 'u-me', name: 'Me', avatar_url: null }, replies: [reply] })],
      { canModerate: true },
    )

    const buttons = menuButtons()
    expect(buttons).toHaveLength(2)
    await openMenu(buttons[1])
    expect(menuItem('Edit')).toBeNull()
    fireEvent.click(menuItem('Delete')!)
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith('r1'))
  })

  it('still offers Edit on the viewer\'s own comment', async () => {
    renderPanel([comment({ author_id: 'u-me', author: { id: 'u-me', name: 'Me', avatar_url: null } })])

    await openMenu(menuButtons()[0])
    expect(menuItem('Edit')).toBeTruthy()
    expect(menuItem('Delete')).toBeTruthy()
  })
})
