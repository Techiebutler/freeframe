import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { useReviewStore } from '@/stores/review-store'
import { CommentPanel } from '../comment-panel'

// #439: a share link's reply box used to swallow every failure, so a reply that
// was never sent looked sent. These pin what the inline reply input does with
// each outcome of onSubmitReply, and that no handler means no Reply button.

beforeEach(() => {
  useReviewStore.getState().reset()
  Element.prototype.scrollIntoView = vi.fn()
})

const noop = async () => {}

const parent = {
  id: 'c1', asset_id: 'a1', version_id: 'v1', parent_id: null,
  author: { id: 'u1', name: 'Maya Chen', avatar_url: null },
  body: 'Parent note', timecode_start: null, timecode_end: null,
  resolved: false, visibility: 'public',
  created_at: '2026-01-01T10:00:00.000Z', updated_at: '2026-01-01T10:00:00.000Z',
  replies: [], reactions: [], attachments: [],
} as never

function renderPanel(onSubmitReply?: (parentId: string, body: string) => Promise<void>) {
  return render(
    <CommentPanel
      comments={[parent]}
      onResolve={noop} onDelete={noop}
      onAddReaction={noop} onRemoveReaction={noop}
      onReply={() => {}}
      onSubmitReply={onSubmitReply}
    />,
  )
}

function replyBox() {
  return screen.queryByPlaceholderText('Leave your reply here...') as HTMLInputElement | null
}

async function typeAndSend(text: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
  const input = replyBox()!
  fireEvent.change(input, { target: { value: text } })
  await act(async () => {
    fireEvent.keyDown(input, { key: 'Enter' })
  })
}

describe('CommentPanel inline reply', () => {
  it('offers no Reply button without an onSubmitReply handler', () => {
    renderPanel(undefined)
    expect(screen.getByText('Parent note')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Reply' })).toBeNull()
  })

  it('shows the error and keeps the typed text when the reply is rejected', async () => {
    const onSubmitReply = vi.fn().mockRejectedValue(new Error('x'))
    renderPanel(onSubmitReply)
    await typeAndSend('my reply')

    expect(onSubmitReply).toHaveBeenCalledWith('c1', 'my reply')
    expect((await screen.findByRole('alert')).textContent).toBe('x')
    expect(replyBox()?.value).toBe('my reply')
  })

  it('stays quiet on an empty-message rejection (a dismissed guest prompt) and keeps the text', async () => {
    const onSubmitReply = vi.fn().mockRejectedValue(new Error(''))
    renderPanel(onSubmitReply)
    await typeAndSend('my reply')

    expect(onSubmitReply).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(replyBox()?.value).toBe('my reply')
  })

  it('closes the reply box once the reply is sent', async () => {
    const onSubmitReply = vi.fn().mockResolvedValue(undefined)
    renderPanel(onSubmitReply)
    await typeAndSend('my reply')

    expect(onSubmitReply).toHaveBeenCalledWith('c1', 'my reply')
    await waitFor(() => expect(replyBox()).toBeNull())
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
