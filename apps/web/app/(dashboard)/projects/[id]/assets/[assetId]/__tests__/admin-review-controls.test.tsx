/** The asset review page shares effective owner rights across all comment surfaces. */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

const { v1, v2, asset, replace, nav, auth, viewport } = vi.hoisted(() => {
  const v1 = { id: 'v1', version_number: 1, processing_status: 'ready' }
  const v2 = { id: 'v2', version_number: 2, processing_status: 'ready' }
  return {
    v1,
    v2,
    asset: {
      id: 'a2',
      name: 'Episode 4.mov',
      project_id: 'p1',
      asset_type: 'video',
      folder_id: null as string | null,
      latest_version: v2,
    },
    replace: vi.fn(),
    nav: { query: '' },
    auth: { user: { id: 'u1', name: 'Reviewer' }, isSuperAdmin: false },
    viewport: { wide: true },
  }
})

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace }),
  usePathname: () => '/projects/p1/assets/a2',
  useSearchParams: () => new URLSearchParams(nav.query),
}))
vi.mock('swr', () => ({
  default: (key: string) => ({
    data: typeof key === 'string' && key.endsWith('/members') ? (auth.isSuperAdmin ? [] : [{ user_id: 'u1', role: 'viewer' }]) : undefined,
  }),
}))
vi.mock('@/components/review/review-provider', () => ({
  ReviewProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useReview: () => ({
    asset,
    versions: [v1, v2],
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
vi.mock('@/hooks/use-media-query', () => ({ useMediaQuery: (query: string) => query === '(min-width: 768px)' && viewport.wide }))
vi.mock('@/hooks/use-media-transport', () => ({
  useMediaTransport: () => ({ currentTime: 0, duration: 0, isPlaying: false }),
}))
const { storeHook } = vi.hoisted(() => ({
  storeHook: (state: Record<string, unknown>) =>
    (selector?: (s: Record<string, unknown>) => unknown) =>
      (typeof selector === 'function' ? selector(state) : state),
}))
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: storeHook(auth),
}))
vi.mock('@/stores/review-store', () => ({
  useReviewStore: storeHook({
    currentVersion: v2,
    isDrawingMode: false,
    focusedCommentId: null,
    playheadTime: 0,
    seekTo: vi.fn(),
    setFocusedCommentId: vi.fn(),
    setActiveAnnotation: vi.fn(),
  }),
}))
vi.mock('@/stores/upload-store', () => ({
  useUploadStore: storeHook({ startVersionUpload: vi.fn(), files: [], versionsRevision: 0 }),
  visibleFiles: (s: { files: unknown[] }) => s.files,
}))
vi.mock('@/stores/view-store', () => ({ useViewStore: storeHook({ sortKey: 'custom', sortDirection: 'asc' }) }))
vi.mock('@/stores/breadcrumb-store', () => ({
  useBreadcrumbStore: storeHook({ setExtraCrumbs: vi.fn(), setLabel: vi.fn() }),
}))
vi.mock('@/lib/api', () => ({ api: { get: vi.fn().mockResolvedValue([]), post: vi.fn() } }))
vi.mock('@/components/review/video-player', () => ({ VideoPlayer: () => null }))
vi.mock('@/components/review/audio-player', () => ({ AudioPlayer: () => null }))
vi.mock('@/components/review/image-viewer', () => ({ ImageViewer: () => null }))
vi.mock('@/components/review/annotation-canvas', () => ({ AnnotationCanvas: () => null }))
vi.mock('@/components/review/annotation-overlay', () => ({ AnnotationOverlay: () => null }))
vi.mock('@/components/review/comment-panel', () => ({
  CommentPanel: ({ canModerate }: { canModerate: boolean }) =>
    canModerate ? <button>Delete another author&apos;s comment</button> : null,
}))
vi.mock('@/components/review/comment-input', () => ({
  CommentInput: () => <textarea aria-label="Write a comment" />,
}))
vi.mock('@/components/review/mobile-comment-sheet', () => ({
  MobileCommentSheet: ({ children, composer }: { children: React.ReactNode; composer?: React.ReactNode }) =>
    <>{children}{composer}</>,
  PEEK_PX: 56,
}))
vi.mock('@/components/review/version-switcher', () => ({ VersionSwitcher: () => null }))
vi.mock('@/components/review/share-dialog', () => ({ ShareDialog: () => null }))
vi.mock('@/components/review/compare/compare-overlay', () => ({
  CompareOverlay: ({ canComment, canModerate }: { canComment: boolean; canModerate: boolean }) => (
    <>
      {canComment && <textarea aria-label="Write a comment" />}
      {canModerate && <button>Delete another author&apos;s comment</button>}
    </>
  ),
}))

import ReviewPage from '../page'
import { ToastProvider } from '@/components/shared/toast'

const routeParams = { id: 'p1', assetId: 'a2' }
const fulfilledParams = Object.assign(Promise.resolve(routeParams), {
  status: 'fulfilled' as const,
  value: routeParams,
})

function renderPage() {
  return render(
    <ToastProvider>
      <ReviewPage params={fulfilledParams} />
    </ToastProvider>,
  )
}

beforeEach(() => {
  auth.isSuperAdmin = false
  viewport.wide = true
  nav.query = ''
})

// Reverting the page to membership alone hides both controls from a non-member
// admin. Unconditionally granting owner controls wrongly enables the viewer.
describe('asset review permissions', () => {
  for (const surface of ['desktop', 'mobile sheet', 'compare']) {
    describe(surface, () => {
      function openSurface() {
        viewport.wide = surface !== 'mobile sheet'
        nav.query = surface === 'compare' ? 'compare=v1&right=v2' : ''
        renderPage()
      }

      it('lets a non-member admin compose and moderate', () => {
        auth.isSuperAdmin = true
        openSurface()
        expect(screen.getByRole('textbox', { name: 'Write a comment' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: "Delete another author's comment" })).toBeInTheDocument()
      })

      it('keeps a plain viewer from composing or moderating', () => {
        openSurface()
        expect(screen.queryByRole('textbox', { name: 'Write a comment' })).toBeNull()
        expect(screen.queryByRole('button', { name: "Delete another author's comment" })).toBeNull()
      })
    })
  }
})
