/**
 * Comments on a share link show their authors' pictures, for top-level
 * comments and replies alike. A guest has no account, so no picture: initials.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ShareCommentList, type GuestComment } from '../folder-share-viewer'

/** jsdom never loads images, so Radix Avatar would stay on the fallback. */
class LoadedImage {
  complete = true
  naturalWidth = 1
  src = ''
  referrerPolicy = ''
  crossOrigin: string | null = null
  addEventListener() {}
  removeEventListener() {}
}

function comment(over: Partial<GuestComment>): GuestComment {
  return {
    id: 'c1', body: 'Nice', guest_name: '', guest_email: '',
    created_at: '2026-01-01T00:00:00Z', ...over,
  }
}

describe('share comment list avatars', () => {
  beforeEach(() => { vi.stubGlobal('Image', LoadedImage) })
  afterEach(() => { vi.unstubAllGlobals() })

  it('shows a member author’s picture on a comment and on a reply', () => {
    render(
      <ShareCommentList
        loading={false}
        canComment={false}
        comments={[comment({
          author: { id: 'u1', name: 'Ada Lovelace', avatar_url: 'https://s3.test/avatars/u1/a.webp' },
          replies: [comment({
            id: 'r1',
            author: { id: 'u2', name: 'Grace Hopper', avatar_url: 'https://s3.test/avatars/u2/g.webp' },
          })],
        })]}
      />,
    )

    expect((screen.getByAltText('Ada Lovelace') as HTMLImageElement).src)
      .toBe('https://s3.test/avatars/u1/a.webp')
    expect((screen.getByAltText('Grace Hopper') as HTMLImageElement).src)
      .toBe('https://s3.test/avatars/u2/g.webp')
  })

  it('uses a member’s circle colour when they have no picture', () => {
    render(
      <ShareCommentList
        loading={false}
        canComment={false}
        comments={[comment({ author: { id: 'u1', name: 'Ada Lovelace', avatar_color: '#a1b2c3' } })]}
      />,
    )

    const circle = screen.getByText('AL').closest('span[style]') as HTMLElement
    expect(circle.style.backgroundColor).toBe('rgb(161, 178, 195)')
  })

  it('shows a guest’s initials, with no picture', () => {
    render(
      <ShareCommentList
        loading={false}
        canComment={false}
        comments={[comment({ guest_author: { id: 'g1', name: 'Guest Person', email: 'g@x.test' } })]}
      />,
    )

    expect(screen.getByText('GP')).toBeInTheDocument()
    expect(screen.queryByRole('img')).toBeNull()
  })
})
