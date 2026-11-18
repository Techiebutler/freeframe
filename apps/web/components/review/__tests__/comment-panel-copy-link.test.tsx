import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { useReviewStore } from '@/stores/review-store'
import { CommentPanel } from '../comment-panel'

// On plain HTTP navigator.clipboard is undefined; Copy Link in the comment
// menu used to throw a TypeError. It must use the execCommand fallback.

let copied: string | null
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
const originalExecCommand = document.execCommand

beforeEach(() => {
  useReviewStore.getState().reset()
  Element.prototype.scrollIntoView = vi.fn()
  copied = null
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
  document.execCommand = vi.fn(() => {
    const event = new Event('copy', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', {
      value: { setData: (_t: string, v: string) => { copied = v } },
    })
    ;(document.activeElement ?? document.body).dispatchEvent(event)
    return true
  }) as never
})

afterEach(() => {
  vi.restoreAllMocks()
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard)
  else delete (navigator as { clipboard?: unknown }).clipboard
  document.execCommand = originalExecCommand
})

const noop = async () => {}

const own = {
  id: 'c1', asset_id: 'a1', version_id: 'v1', parent_id: null,
  author_id: 'u-me', author: { id: 'u-me', name: 'Me', avatar_url: null },
  body: 'My note', timecode_start: null, timecode_end: null,
  resolved: false, visibility: 'public',
  created_at: '2026-01-01T10:00:00.000Z', updated_at: '2026-01-01T10:00:00.000Z',
  replies: [], reactions: [], attachments: [],
} as never

describe('CommentPanel Copy Link on plain HTTP', () => {
  it('copies the comment link via the fallback and closes the menu', async () => {
    render(
      <CommentPanel
        comments={[own]}
        currentUserId="u-me"
        onResolve={noop} onDelete={noop}
        onAddReaction={noop} onRemoveReaction={noop}
        onReply={() => {}}
      />,
    )
    // The comment menu is a Radix DropdownMenu: it opens on pointerdown and
    // its entries are menuitems.
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Comment actions' }), { button: 0, ctrlKey: false })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy Link' }))

    await waitFor(() => expect(copied).not.toBeNull())
    expect(new URL(copied as unknown as string).searchParams.get('commentId')).toBe('c1')
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: 'Copy Link' })).toBeNull())
    // A rejected copy would surface as an unhandled error, which fails the
    // vitest run on its own; no manual listener needed.
  })
})
