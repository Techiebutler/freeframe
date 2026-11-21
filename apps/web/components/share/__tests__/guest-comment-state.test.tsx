import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { GuestCommentItem, type GuestComment } from '../guest-comments'

afterEach(cleanup)
const c = (round_state: GuestComment['round_state']): GuestComment => ({ id: '1', body: 'Logo bigger', created_at: '2026-11-21T14:00:00Z', timecode_start: 3, author: { id: 'u', name: 'Alan' }, round_state })

describe('GuestCommentItem round state', () => {
  it('a comment of an acked round is muted and marked done', () => {
    const { container } = render(<GuestCommentItem comment={c('done')} />)
    expect(screen.getByText('done')).toBeInTheDocument()
    expect(container.firstElementChild?.className).toContain('opacity-60')
  })
  it('open and sent comments look normal', () => {
    for (const s of ['open', 'sent', null] as const) {
      const { container, unmount } = render(<GuestCommentItem comment={c(s)} />)
      expect(screen.queryByText('done')).toBeNull()
      expect(container.firstElementChild?.className).not.toContain('opacity-60')
      unmount()
    }
  })
})
