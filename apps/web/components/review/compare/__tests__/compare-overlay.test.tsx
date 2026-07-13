import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useReviewStore } from '@/stores/review-store'

const replace = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  usePathname: () => '/projects/p1/assets/a1',
  useSearchParams: () => new URLSearchParams('compare=v-1'),
}))

const createComment = vi.fn().mockResolvedValue({})
vi.mock('@/hooks/use-comments', () => ({
  useComments: () => ({
    comments: [], isLoading: false,
    createComment, resolveComment: vi.fn(), deleteComment: vi.fn(),
    addReaction: vi.fn(), removeReaction: vi.fn(),
  }),
}))
vi.mock('@/hooks/use-stream-url', () => ({ useStreamUrl: () => ({ url: null, error: false }) }))
// CommentInput calls useReview() unconditionally; the overlay mounts it on render
// (right comment panel defaults open), so provide the minimal context shape it uses.
vi.mock('@/components/review/review-provider', () => ({
  useReview: () => ({ pauseVideo: vi.fn(), registerPauseHandler: vi.fn() }),
}))
vi.mock('@/hooks/use-video-player', () => ({
  useVideoPlayer: () => ({
    videoRef: { current: null }, state: { duration: 60 },
    controls: { play: vi.fn(), pause: vi.fn(), seek: vi.fn() },
  }),
}))

import { CompareOverlay } from '../compare-overlay'

function makeVersion(n: number, status = 'ready') {
  return {
    id: `v-${n}`, asset_id: 'a1', version_number: n, processing_status: status,
    created_at: new Date().toISOString(), files: [{ fps: 25, duration_seconds: 60 }],
  } as never
}

const asset = { id: 'a1', name: 'Demo', asset_type: 'image' } as never

beforeEach(() => {
  useReviewStore.getState().reset()
  replace.mockClear()
})

describe('CompareOverlay', () => {
  it('renders exactly the minimalist chrome: two selects, mode toggle (image), close', () => {
    render(
      <CompareOverlay asset={asset} versions={[makeVersion(1), makeVersion(3)]} rightVersion={makeVersion(3)} onClose={vi.fn()} />,
    )
    expect(screen.getByTestId('compare-select-a')).toBeInTheDocument()
    expect(screen.getByTestId('compare-select-b')).toBeInTheDocument()
    expect(screen.getByLabelText('Close compare')).toBeInTheDocument()
    expect(screen.getByLabelText(/wipe|side-by-side/i)).toBeInTheDocument()
  })

  it('ESC closes', () => {
    const onClose = vi.fn()
    render(
      <CompareOverlay asset={asset} versions={[makeVersion(1), makeVersion(3)]} rightVersion={makeVersion(3)} onClose={onClose} />,
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('ignores hotkeys while typing in a comment input', () => {
    const onClose = vi.fn()
    render(
      <CompareOverlay asset={asset} versions={[makeVersion(1), makeVersion(3)]} rightVersion={makeVersion(3)} onClose={onClose} />,
    )
    // Right comment panel is open by default — type into its CommentInput textarea.
    const textarea = screen.getByPlaceholderText('Leave your comment...')
    fireEvent.keyDown(textarea, { key: 'Escape' })
    fireEvent.keyDown(textarea, { key: ' ' })
    expect(onClose).not.toHaveBeenCalled()
  })
})
