/**
 * The asset page on a phone: media above, comments below, both on screen.
 *
 * Below `md` the review page does not tuck the comments into a bottom sheet
 * that covers the player (and then needs a play/pause of its own). It splits
 * the column: the viewer keeps its own transport on top, the comments and the
 * composer sit underneath, and a drag handle between them moves the split.
 * The player and the provider are faked here; the page and its split hook are
 * real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { setViewportWidth } from '@/test/setup'

const { asset } = vi.hoisted(() => ({
  asset: {
    id: 'a2',
    name: 'Episode 4 — rough cut.mov',
    project_id: 'p1',
    asset_type: 'video',
    folder_id: null as string | null,
    latest_version: { id: 'v1', version_number: 1, processing_status: 'ready' },
  },
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/projects/p1/assets/a2',
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('swr', () => ({
  default: (key: string) => ({
    data: typeof key === 'string' && key.endsWith('/members') ? [{ user_id: 'u1', role: 'editor' }] : undefined,
  }),
  mutate: vi.fn(),
}))
vi.mock('@/components/review/review-provider', () => ({
  ReviewProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useReview: () => ({
    asset,
    versions: [asset.latest_version],
    isLoading: false,
    refetchComments: vi.fn(),
    refetchVersions: vi.fn(),
  }),
}))
vi.mock('@/hooks/use-comments', () => ({
  useComments: () => ({
    comments: [],
    createComment: vi.fn(),
    resolveComment: vi.fn(),
    deleteComment: vi.fn(),
    updateComment: vi.fn(),
    refetch: vi.fn(),
  }),
}))
vi.mock('@/hooks/use-sse', () => ({ useSSE: () => undefined }))
vi.mock('@/hooks/use-page-title', () => ({ usePageTitle: () => undefined }))
const { storeHook } = vi.hoisted(() => ({
  storeHook: (state: Record<string, unknown>) =>
    (selector?: (s: Record<string, unknown>) => unknown) =>
      (typeof selector === 'function' ? selector(state) : state),
}))
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: storeHook({ user: { id: 'u1', name: 'Reviewer' } }),
}))
vi.mock('@/stores/review-store', () => ({
  useReviewStore: storeHook({
    currentVersion: { id: 'v1', version_number: 1, processing_status: 'ready' },
    isDrawingMode: false,
    focusedCommentId: null,
    seekTo: vi.fn(),
    setFocusedCommentId: vi.fn(),
    setActiveAnnotation: vi.fn(),
  }),
}))
vi.mock('@/stores/view-store', () => ({ useViewStore: storeHook({ sortKey: 'custom', sortDirection: 'asc' }) }))
vi.mock('@/stores/breadcrumb-store', () => ({
  useBreadcrumbStore: storeHook({ setExtraCrumbs: vi.fn(), setLabel: vi.fn() }),
}))
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  api: { get: vi.fn().mockResolvedValue([]), post: vi.fn(), patch: vi.fn() },
}))
vi.mock('@/components/review/video-player', () => ({ VideoPlayer: () => <video data-testid="media" /> }))
vi.mock('@/components/review/audio-player', () => ({ AudioPlayer: () => <audio data-testid="media" /> }))
vi.mock('@/components/review/image-viewer', () => ({ ImageViewer: () => null }))
vi.mock('@/components/review/annotation-canvas', () => ({ AnnotationCanvas: () => null }))
vi.mock('@/components/review/annotation-overlay', () => ({ AnnotationOverlay: () => null }))
vi.mock('@/components/review/comment-panel', () => ({ CommentPanel: () => <div data-testid="comments" /> }))
vi.mock('@/components/review/comment-input', () => ({ CommentInput: () => <div data-testid="composer" /> }))
vi.mock('@/components/review/version-switcher', () => ({ VersionSwitcher: () => null }))
vi.mock('@/components/review/share-dialog', () => ({ ShareDialog: () => null }))
vi.mock('@/components/review/compare/compare-overlay', () => ({ CompareOverlay: () => null }))

import ReviewPage from '../page'
import { ToastProvider } from '@/components/shared/toast'

const routeParams = { id: 'p1', assetId: 'a2' }
const fulfilledParams = Object.assign(Promise.resolve(routeParams), {
  status: 'fulfilled' as const,
  value: routeParams,
})

function renderPage() {
  render(
    <ToastProvider>
      <ReviewPage params={fulfilledParams} />
    </ToastProvider>,
  )
  const media = screen.getByTestId('media')
  // The viewer column is the one holding the media; the comments column is
  // the one holding the comment list.
  const mediaColumn = media.closest('.bg-bg-primary') as HTMLElement
  const commentsColumn = screen.getByTestId('comments').closest('.bg-bg-secondary') as HTMLElement
  return { media, mediaColumn, commentsColumn }
}

beforeEach(() => {
  asset.asset_type = 'video'
  setViewportWidth(390)
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => true)
})

afterEach(() => {
  setViewportWidth(1024)
})

describe('the asset page on a phone', () => {
  it('shows the player and the comments together, neither inside the other', () => {
    const { media, mediaColumn, commentsColumn } = renderPage()

    expect(mediaColumn).not.toBeNull()
    expect(commentsColumn).not.toBeNull()
    // Siblings in one split, so the comments never cover the player and the
    // player's own controls stay the way to play and pause it.
    expect(mediaColumn.parentElement).toBe(commentsColumn.parentElement)
    expect(commentsColumn.contains(media)).toBe(false)
    expect(mediaColumn.contains(screen.getByTestId('composer'))).toBe(false)
    expect(screen.queryByTestId('mobile-comment-sheet')).toBeNull()
  })

  it('shares the height between them', () => {
    const { mediaColumn, commentsColumn } = renderPage()

    expect(mediaColumn.style.height).toBe('46%')
    expect(commentsColumn.style.height).toBe('54%')
  })

  it('keeps an audio file on screen in the same split', () => {
    asset.asset_type = 'audio'
    const { media, mediaColumn } = renderPage()

    expect(media.tagName).toBe('AUDIO')
    expect(mediaColumn.style.height).toBe('46%')
  })

  it('moves the split when the handle is dragged, within limits', () => {
    const { mediaColumn, commentsColumn } = renderPage()
    const container = mediaColumn.parentElement!
    container.getBoundingClientRect = () =>
      ({ top: 100, height: 1000, bottom: 1100, left: 0, right: 390, width: 390, x: 0, y: 100, toJSON() {} }) as DOMRect
    const handle = screen.getByRole('separator', { name: 'Resize media and comments' })

    act(() => { fireEvent.pointerDown(handle, { pointerId: 1, clientY: 700 }) })
    expect(mediaColumn.style.height).toBe('60%')
    expect(commentsColumn.style.height).toBe('40%')

    // Dragged past the bottom, the comments keep 30% of the column.
    act(() => { fireEvent.pointerMove(handle, { pointerId: 1, clientY: 1090 }) })
    expect(mediaColumn.style.height).toBe('70%')

    // Released, the handle no longer follows the pointer.
    act(() => { fireEvent.pointerUp(handle, { pointerId: 1, clientY: 1090 }) })
    act(() => { fireEvent.pointerMove(handle, { pointerId: 1, clientY: 300 }) })
    expect(mediaColumn.style.height).toBe('70%')
  })

  it('gives the player the whole column when the comments are closed', () => {
    const { mediaColumn } = renderPage()

    fireEvent.click(screen.getByTitle('Toggle sidebar'))

    expect(screen.queryByTestId('comments')).toBeNull()
    expect(screen.queryByRole('separator', { name: 'Resize media and comments' })).toBeNull()
    expect(mediaColumn.style.height).toBe('')
    expect(mediaColumn).toHaveClass('flex-1')
  })
})
