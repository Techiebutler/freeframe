/**
 * Where the verdict controls sit on the asset page, and what keeps them live.
 *
 * The top bar is `overflow-hidden`, not scrolled, and already holds the version
 * switcher, Compare, New Version, Share and the sidebar toggle. Three more
 * buttons there are what pushes the toggle off a phone's right edge, where
 * nothing scrolls to it. So the placement is structural, like the credit's in
 * `top-bar-credit.test.tsx`: from `lg` up the controls are in the top bar's
 * right group beside the version switcher, and below it they are in a row of
 * their own under the bar and nowhere inside it.
 *
 * The row has the same fixed height whatever the role and the data are, since
 * the stage cap `--ff-stage-max` is measured from the review area once per
 * layout and a row that arrived later, or grew, would crop the media under the
 * comment sheet.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

const asset = {
  id: 'a2',
  name: 'Episode 4 rough cut.mov',
  project_id: 'p1',
  asset_type: 'video',
  folder_id: null as string | null,
  latest_version: { id: 'v1', version_number: 1, processing_status: 'ready' },
}

const { swrKeys, globalMutate, sse, screenState } = vi.hoisted(() => ({
  swrKeys: [] as string[],
  globalMutate: vi.fn(),
  sse: { options: undefined as undefined | { onApprovalUpdated?: (d: Record<string, string>) => void } },
  screenState: { wide: true, role: 'editor' },
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/projects/p1/assets/a2',
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('swr', () => ({
  default: (key: string) => {
    if (typeof key === 'string') swrKeys.push(key)
    return {
      data: typeof key === 'string' && key.endsWith('/members')
        ? [{ user_id: 'u1', role: screenState.role }]
        : undefined,
    }
  },
  mutate: globalMutate,
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
vi.mock('@/hooks/use-sse', () => ({
  useSSE: (_projectId: unknown, options: typeof sse.options) => {
    sse.options = options
  },
}))
vi.mock('@/hooks/use-page-title', () => ({ usePageTitle: () => undefined }))
// Only the `lg` query is switchable: the top bar has room for the controls from 1024px.
vi.mock('@/hooks/use-media-query', () => ({
  useMediaQuery: (query: string) => (query.includes('min-width: 1024px') ? screenState.wide : false),
}))
vi.mock('@/hooks/use-media-transport', () => ({
  useMediaTransport: () => ({ currentTime: 0, duration: 0, isPlaying: false }),
}))
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
vi.mock('@/stores/view-store', () => ({
  useViewStore: storeHook({ sortKey: 'custom', sortDirection: 'asc' }),
}))
vi.mock('@/stores/breadcrumb-store', () => ({
  useBreadcrumbStore: storeHook({ setExtraCrumbs: vi.fn(), setLabel: vi.fn() }),
}))
vi.mock('@/lib/api', () => ({ api: { get: vi.fn().mockResolvedValue([]), post: vi.fn() } }))
vi.mock('@/components/review/video-player', () => ({ VideoPlayer: () => null }))
vi.mock('@/components/review/audio-player', () => ({ AudioPlayer: () => null }))
vi.mock('@/components/review/image-viewer', () => ({ ImageViewer: () => null }))
vi.mock('@/components/review/annotation-canvas', () => ({ AnnotationCanvas: () => null }))
vi.mock('@/components/review/annotation-overlay', () => ({ AnnotationOverlay: () => null }))
vi.mock('@/components/review/comment-panel', () => ({ CommentPanel: () => null }))
vi.mock('@/components/review/comment-input', () => ({ CommentInput: () => null }))
vi.mock('@/components/review/mobile-comment-sheet', () => ({
  MobileCommentSheet: () => null,
  PEEK_PX: 56,
}))
vi.mock('@/components/review/version-switcher', () => ({
  VersionSwitcher: () => <div data-testid="version-switcher" />,
}))
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
  return render(
    <ToastProvider>
      <ReviewPage params={fulfilledParams} />
    </ToastProvider>,
  )
}

/** The back arrow sits in the bar's left group, which is a child of the bar. */
const topBar = () => screen.getByLabelText('Back to project').parentElement!.parentElement!
const controls = () => screen.getByTestId('verdict-controls')

beforeEach(() => {
  vi.clearAllMocks()
  swrKeys.length = 0
  sse.options = undefined
  screenState.wide = true
  screenState.role = 'editor'
})

describe('the verdict controls on the asset page', () => {
  describe('from lg up', () => {
    it('sit in the top bar, next to the version switcher', () => {
      renderPage()

      expect(topBar().contains(controls())).toBe(true)
      expect(screen.getByTestId('version-switcher').parentElement!.contains(controls())).toBe(true)
      expect(screen.queryByTestId('verdict-row')).not.toBeInTheDocument()
    })

    it('are the three buttons for an editor, in the top bar', () => {
      renderPage()

      const group = screen.getByRole('group', { name: 'Your verdict' })
      expect(topBar().contains(group)).toBe(true)
      expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
    })
  })

  describe('below lg', () => {
    beforeEach(() => {
      screenState.wide = false
    })

    it('sit in a row of their own under the top bar, and nowhere inside it', () => {
      renderPage()

      const row = screen.getByTestId('verdict-row')
      expect(topBar().contains(controls())).toBe(false)
      expect(row.contains(controls())).toBe(true)
      expect(topBar().nextElementSibling).toBe(row)
    })

    it('keep one fixed height that does not depend on what is in the row', () => {
      renderPage()

      const classes = screen.getByTestId('verdict-row').className.split(/\s+/)
      expect(classes).toContain('h-10')
      expect(classes).toContain('shrink-0')
    })

    it('make the row a size container, which the buttons\' labels are hidden against', () => {
      renderPage()

      expect(screen.getByTestId('verdict-row').className.split(/\s+/)).toContain('[container-type:inline-size]')
    })

    it('are there for a viewer too, who has only the indicator to show', () => {
      screenState.role = 'viewer'
      renderPage()

      // The row is mounted with the layout, not once the role or the verdicts arrive.
      expect(screen.getByTestId('verdict-row')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
    })
  })

  describe('for the version on screen', () => {
    it('read that version\'s verdicts', () => {
      renderPage()

      expect(swrKeys).toContain('/assets/a2/verdicts?version_id=v1')
    })

    it('give nothing to someone who is only a viewer', () => {
      screenState.role = 'viewer'
      renderPage()

      expect(screen.queryByRole('group', { name: 'Your verdict' })).not.toBeInTheDocument()
    })
  })

  describe('on approval_updated', () => {
    it('revalidates that version\'s verdicts when the event is about this asset', () => {
      renderPage()

      sse.options!.onApprovalUpdated!({ asset_id: 'a2', version_id: 'v1' })

      expect(globalMutate).toHaveBeenCalledTimes(1)
      expect(globalMutate).toHaveBeenCalledWith('/assets/a2/verdicts?version_id=v1')
    })

    it('uses the version the event names, which may not be the one on screen', () => {
      renderPage()

      sse.options!.onApprovalUpdated!({ asset_id: 'a2', version_id: 'v0' })

      expect(globalMutate).toHaveBeenCalledWith('/assets/a2/verdicts?version_id=v0')
    })

    it('ignores an event about another asset in the project', () => {
      renderPage()

      sse.options!.onApprovalUpdated!({ asset_id: 'someone-elses', version_id: 'v1' })

      expect(globalMutate).not.toHaveBeenCalled()
    })
  })
})
