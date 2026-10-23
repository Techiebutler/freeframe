/**
 * A compare URL names both panes (#299).
 *
 * The left pane has always come from `compare=`. The right pane is the review
 * store's current version, which a reload does not keep, so a reloaded or shared
 * compare link came back with the newest version on the right: a different pair
 * than the one it was copied from. The page now writes `right=` when compare
 * opens, removes it when compare closes, and hands it to the provider, which
 * opens on that version instead of the newest.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const { v1, v2, asset, replace, nav, providerProps, overlayProps } = vi.hoisted(() => {
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
    providerProps: [] as Array<Record<string, unknown>>,
    overlayProps: [] as Array<{ onClose(): void }>,
  }
})

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace }),
  usePathname: () => '/projects/p1/assets/a2',
  useSearchParams: () => new URLSearchParams(nav.query),
}))
vi.mock('swr', () => ({
  default: (key: string) => ({
    data: typeof key === 'string' && key.endsWith('/members') ? [{ user_id: 'u1', role: 'editor' }] : undefined,
  }),
}))
vi.mock('@/components/review/review-provider', () => ({
  ReviewProvider: (props: { children: React.ReactNode } & Record<string, unknown>) => {
    providerProps.push(props)
    return <>{props.children}</>
  },
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
vi.mock('@/hooks/use-media-query', () => ({ useMediaQuery: () => true }))
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
vi.mock('@/components/review/comment-panel', () => ({ CommentPanel: () => null }))
vi.mock('@/components/review/comment-input', () => ({ CommentInput: () => null }))
vi.mock('@/components/review/mobile-comment-sheet', () => ({ MobileCommentSheet: () => null, PEEK_PX: 56 }))
vi.mock('@/components/review/version-switcher', () => ({ VersionSwitcher: () => null }))
vi.mock('@/components/review/share-dialog', () => ({ ShareDialog: () => null }))
vi.mock('@/components/review/compare/compare-overlay', () => ({
  CompareOverlay: (props: { onClose(): void }) => {
    overlayProps.push(props)
    return null
  },
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

const lastReplace = () => new URL(replace.mock.calls.at(-1)?.[0], 'http://x').searchParams

beforeEach(() => {
  replace.mockClear()
  providerProps.length = 0
  overlayProps.length = 0
  nav.query = ''
})

describe('the compare URL names the right pane', () => {
  it('opening compare writes the shown version as the right pane', () => {
    renderPage()
    fireEvent.click(screen.getByTitle('Compare versions'))
    expect(lastReplace().get('compare')).toBe('v1')
    expect(lastReplace().get('right')).toBe('v2')
  })

  it('closing compare removes the right pane with the other compare params', () => {
    nav.query = 'compare=v1&right=v2&offA=1&offFor=v1:v2&commentId=c1'
    renderPage()
    overlayProps.at(-1)?.onClose()
    const p = lastReplace()
    expect(['compare', 'right', 'offA', 'offFor'].map((k) => p.get(k))).toEqual([null, null, null, null])
    expect(p.get('commentId')).toBe('c1')
  })

  it('a loaded compare URL asks the provider to open on its right pane', () => {
    nav.query = 'compare=v1&right=v2'
    renderPage()
    expect(providerProps.at(-1)?.initialVersionId).toBe('v2')
  })

  it('a stray right= outside compare does not pick the version', () => {
    nav.query = 'right=v1'
    renderPage()
    expect(providerProps.at(-1)?.initialVersionId ?? null).toBeNull()
  })
})
