import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useReviewStore } from '@/stores/review-store'

const replace = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  usePathname: () => '/projects/p1/assets/a1',
  useSearchParams: () => new URLSearchParams('compare=v-1'),
}))

// Per-side capture: record which version's hook instance received each create.
const createComment = vi.fn().mockResolvedValue({})
const createCommentCalls: Array<{ versionId: string | null; args: unknown[] }> = []
vi.mock('@/hooks/use-comments', () => ({
  useComments: (_assetId: string, versionId: string | null) => ({
    comments: [], isLoading: false,
    createComment: (...args: unknown[]) => {
      createCommentCalls.push({ versionId, args })
      return createComment(...args)
    },
    resolveComment: vi.fn(), deleteComment: vi.fn(),
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
// Pin the transport clock so pane-local timecodes are deterministic (t = 12.5s).
vi.mock('../use-synced-transport', () => ({
  useSyncedTransport: () => ({
    playerA: { videoRef: { current: null } },
    playerB: { videoRef: { current: null } },
    t: 12.5, total: 60, isPlaying: false,
    toggle: vi.fn(), seekTo: vi.fn(), setIsPlaying: vi.fn(),
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
const videoAsset = { id: 'a1', name: 'Demo', asset_type: 'video' } as never

beforeEach(() => {
  useReviewStore.getState().reset()
  replace.mockClear()
  createComment.mockClear()
  createCommentCalls.length = 0
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

describe('CompareOverlay per-side comment submission', () => {
  it('right panel submits with the pane-local timecode', async () => {
    render(
      <CompareOverlay asset={videoAsset} versions={[makeVersion(1), makeVersion(3)]} rightVersion={makeVersion(3)} onClose={vi.fn()} />,
    )
    const textarea = screen.getByPlaceholderText('Leave your comment...')
    fireEvent.change(textarea, { target: { value: 'right side note' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await waitFor(() => expect(textarea).toHaveValue(''))
    expect(createCommentCalls).toHaveLength(1)
    expect(createCommentCalls[0].versionId).toBe('v-3')
    expect(createCommentCalls[0].args[0]).toBe('right side note')
    // localTime(t=12.5, { offset: 0, duration: 60 }) = 12.5
    expect(createCommentCalls[0].args[1]).toBeCloseTo(12.5)
  })

  it('omits the timecode when the toggle is detached', async () => {
    render(
      <CompareOverlay asset={videoAsset} versions={[makeVersion(1), makeVersion(3)]} rightVersion={makeVersion(3)} onClose={vi.fn()} />,
    )
    fireEvent.click(screen.getByTitle('Detach timecode'))
    const textarea = screen.getByPlaceholderText('Leave your comment...')
    fireEvent.change(textarea, { target: { value: 'detached note' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await waitFor(() => expect(textarea).toHaveValue(''))
    expect(createCommentCalls).toHaveLength(1)
    expect(createCommentCalls[0].args[1]).toBeUndefined()
  })

  it('left panel submits against the left version', async () => {
    render(
      <CompareOverlay asset={videoAsset} versions={[makeVersion(1), makeVersion(3)]} rightVersion={makeVersion(3)} onClose={vi.fn()} />,
    )
    fireEvent.click(screen.getByLabelText('Toggle left comments'))
    // Both panels open — DOM order puts the left panel's textarea first.
    const textareas = screen.getAllByPlaceholderText('Leave your comment...')
    fireEvent.change(textareas[0], { target: { value: 'left side note' } })
    fireEvent.keyDown(textareas[0], { key: 'Enter' })
    await waitFor(() => expect(textareas[0]).toHaveValue(''))
    expect(createCommentCalls).toHaveLength(1)
    expect(createCommentCalls[0].versionId).toBe('v-1')
    expect(createCommentCalls[0].args[0]).toBe('left side note')
  })
})
