/**
 * The mobile comment sheet's play/pause button on the asset page (#412).
 *
 * The page has to hand the sheet's transport two things: its media column, so
 * the transport can find the element at all, and the player's own toggle, so a
 * <video> keeps the iOS first-tap retry and the disarm on pause (#404). The
 * player and the provider are faked here; the transport hook and the sheet are
 * real. The retry itself is pinned end to end on the share screen, where the
 * real player and provider can run (share-sheet-transport.test.tsx).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within, act } from '@testing-library/react'

const { asset, togglePlayback } = vi.hoisted(() => ({
  asset: {
    id: 'a2',
    name: 'Episode 4 — rough cut.mov',
    project_id: 'p1',
    asset_type: 'video',
    folder_id: null as string | null,
    latest_version: { id: 'v1', version_number: 1, processing_status: 'ready' },
  },
  togglePlayback: vi.fn(),
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
    togglePlayback,
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
// A portrait phone: not `md`, not landscape, so the comments are a sheet.
vi.mock('@/hooks/use-media-query', () => ({ useMediaQuery: () => false }))
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
    playheadTime: 12,
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
vi.mock('@/components/review/comment-panel', () => ({ CommentPanel: () => null }))
vi.mock('@/components/review/comment-input', () => ({ CommentInput: () => null }))
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

function openSheet() {
  const view = render(
    <ToastProvider>
      <ReviewPage params={fulfilledParams} />
    </ToastProvider>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Open comments' }))
  const media = view.getByTestId('media') as HTMLMediaElement
  const play = vi.fn(() => Promise.resolve())
  media.play = play
  media.pause = vi.fn()
  Object.defineProperty(media, 'paused', { configurable: true, get: () => true })
  return { media, play, sheet: within(screen.getByTestId('mobile-comment-sheet')) }
}

beforeEach(() => {
  vi.clearAllMocks()
  asset.asset_type = 'video'
})

describe('the sheet play/pause button on the asset page', () => {
  it("toggles a video through the player's own toggle", () => {
    const { play, sheet } = openSheet()

    fireEvent.click(sheet.getByRole('button', { name: 'Play' }))

    expect(togglePlayback).toHaveBeenCalledTimes(1)
    expect(play).not.toHaveBeenCalled()
  })

  it('plays an audio element directly', () => {
    asset.asset_type = 'audio'
    const { play, sheet } = openSheet()

    fireEvent.click(sheet.getByRole('button', { name: 'Play' }))

    expect(play).toHaveBeenCalledTimes(1)
    expect(togglePlayback).not.toHaveBeenCalled()
  })

  it('says Pause while the media plays', () => {
    const { media, sheet } = openSheet()

    act(() => { media.dispatchEvent(new Event('play')) })

    expect(sheet.getByRole('button', { name: 'Pause' })).toBeInTheDocument()
  })
})
