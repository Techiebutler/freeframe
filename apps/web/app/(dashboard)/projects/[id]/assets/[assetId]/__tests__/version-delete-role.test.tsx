/**
 * Who the review page offers "Delete version" to (#419).
 *
 * Deleting a version needs the role deleting the asset needs, editor or above,
 * and the server refuses anyone else with a 403. The page hands the switcher
 * that decision from the project role; the switcher itself is tested in
 * components/review/__tests__/version-switcher.test.tsx. After a delete
 * nothing else refetches (it produces no event), so the page does.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'

const asset = {
  id: 'a2',
  name: 'Episode 4 — rough cut.mov',
  project_id: 'p1',
  asset_type: 'video',
  folder_id: null as string | null,
  latest_version: { id: 'v1', version_number: 1, processing_status: 'ready' },
}
/** What GET /projects/p1/assets?folder_id=… returns, per folder. */
const { assetsByFolder, swrKeys, viewState, member, switcherProps, refetchVersions, refetchComments, routerPush } = vi.hoisted(() => ({
  assetsByFolder: {} as Record<string, unknown[]>,
  swrKeys: [] as string[],
  viewState: { sortKey: 'custom', sortDirection: 'asc' } as Record<string, unknown>,
  member: { role: 'editor' as string },
  switcherProps: [] as Array<Record<string, unknown>>,
  refetchVersions: vi.fn(),
  refetchComments: vi.fn(),
  routerPush: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn() }),
  usePathname: () => '/projects/p1/assets/a2',
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('swr', () => ({
  default: (key: string) => {
    if (typeof key === 'string') swrKeys.push(key)
    const folder = typeof key === 'string' ? key.match(/\/assets\?folder_id=(.+)$/)?.[1] : undefined
    return {
    data: typeof key !== 'string' ? undefined
      : folder ? assetsByFolder[folder]
      : key.endsWith('/members') ? [{ user_id: 'u1', role: member.role }]
      : undefined,
    }
  },
}))
vi.mock('@/components/review/review-provider', () => ({
  ReviewProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useReview: () => ({
    asset,
    versions: [asset.latest_version],
    isLoading: false,
    refetchComments,
    refetchVersions,
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
vi.mock('@/hooks/use-media-query', () => ({ useMediaQuery: () => false }))
vi.mock('@/hooks/use-media-transport', () => ({
  useMediaTransport: () => ({ currentTime: 0, duration: 0, isPlaying: false }),
}))
/** These stores are read both bare and through a selector, so the mock has to
 *  answer either shape. Hoisted, because vi.mock's factories are. */
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
    currentVersion: { id: 'v1', version_number: 1 },
    isDrawingMode: false,
    focusedCommentId: null,
    playheadTime: 0,
    seekTo: vi.fn(),
    setFocusedCommentId: vi.fn(),
    setActiveAnnotation: vi.fn(),
  }),
}))
vi.mock('@/stores/upload-store', () => ({
  // `files` is read by the page to say a new version is queued; none are.
  useUploadStore: storeHook({ startVersionUpload: vi.fn(), files: [], versionsRevision: 0 }),
  visibleFiles: (s: { files: unknown[] }) => s.files,
}))
vi.mock('@/stores/view-store', () => ({ useViewStore: storeHook(viewState) }))
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
/** useMediaQuery is false here, so the page hands its composer to the sheet. */
const { sheetComposers } = vi.hoisted(() => ({
  sheetComposers: [] as Array<{ props: Record<string, unknown> } | undefined>,
}))
vi.mock('@/components/review/mobile-comment-sheet', () => ({
  MobileCommentSheet: ({ composer }: { composer?: { props: Record<string, unknown> } }) => {
    sheetComposers.push(composer)
    return null
  },
  PEEK_PX: 56,
}))
vi.mock('@/components/review/version-switcher', () => ({
  VersionSwitcher: (props: Record<string, unknown>) => {
    switcherProps.push(props)
    return null
  },
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

beforeEach(() => {
  switcherProps.length = 0
  refetchVersions.mockClear()
  refetchComments.mockClear()
})

describe('Delete version on the review page', () => {
  it.each([
    ['owner', true],
    ['editor', true],
    ['reviewer', false],
    ['viewer', false],
  ])('a %s may delete: %s', (role, allowed) => {
    member.role = role
    renderPage()

    const last = switcherProps[switcherProps.length - 1]
    expect(last.canDelete).toBe(allowed)
  })

  it('refetches the versions and the comments once a version is deleted or restored', () => {
    member.role = 'editor'
    renderPage()

    const last = switcherProps[switcherProps.length - 1]
    ;(last.onVersionsChanged as (v: unknown) => void)(null)

    expect(refetchVersions).toHaveBeenCalledTimes(1)
    expect(refetchComments).toHaveBeenCalledTimes(1)
  })

  it('says so when the version on screen was deleted and the view moved', async () => {
    member.role = 'editor'
    renderPage()

    const last = switcherProps[switcherProps.length - 1]
    act(() => {
      ;(last.onShownVersionDeleted as (d: unknown, n: unknown) => void)(
        { id: 'v3', version_number: 3 }, { id: 'v2', version_number: 2 })
    })

    expect(await screen.findByText('v3 deleted — now showing v2')).toBeInTheDocument()
  })

  it('leaves the arrow keys to an open menu instead of going to the next asset', () => {
    member.role = 'editor'
    assetsByFolder.root = [{ id: 'a1', name: 'a', created_at: '' }, asset, { id: 'a3', name: 'c', created_at: '' }]
    routerPush.mockClear()
    renderPage()
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    const item = document.createElement('div')
    menu.appendChild(item)
    document.body.appendChild(menu)

    fireEvent.keyDown(item, { key: 'ArrowLeft' })
    fireEvent.keyDown(item, { key: 'ArrowRight' })
    expect(routerPush).not.toHaveBeenCalled()

    // Outside a menu the arrows still walk the folder.
    fireEvent.keyDown(document.body, { key: 'ArrowLeft' })
    expect(routerPush).toHaveBeenCalledWith('/projects/p1/assets/a1')
    menu.remove()
    delete assetsByFolder.root
  })
})
