/**
 * Uploading a new version while other uploads hold the queue.
 *
 * A new version waits for its turn like any other file, and the asset page is
 * where the user clicked "New Version", so it says what is happening instead of
 * looking as if nothing was picked: "New version queued, waiting for other
 * uploads." for as long as the file waits.
 *
 * The version exists on the server only once its initiate has answered. The page
 * used to guess at that moment with two timers (800 ms and 2.5 s after the
 * click), which is wrong whenever the file waits longer than that and wasteful
 * when it does not. The store now says when the row receives its version id, by
 * the same counter it already uses when it changes versions behind the page, and
 * the page refetches then.
 *
 * Everything but the page itself and the upload store is replaced; the store and
 * the fake server behind it are real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

const asset = {
  id: 'a2',
  name: 'Episode 4 — rough cut.mov',
  project_id: 'p1',
  asset_type: 'video',
  folder_id: null as string | null,
  latest_version: { id: 'v1', version_number: 1, processing_status: 'ready' },
}

const { refetchVersions, viewState } = vi.hoisted(() => ({
  refetchVersions: vi.fn(),
  viewState: { sortKey: 'custom', sortDirection: 'asc' } as Record<string, unknown>,
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/projects/p1/assets/a2',
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('swr', () => ({
  // The page reads the assets of the folder it is in, and its role there.
  default: (key: string) => ({
    data: typeof key !== 'string' ? undefined
      : key.includes('/assets?folder_id=') ? [{ id: 'a1' }, asset, { id: 'a3' }]
      : key.endsWith('/members') ? [{ user_id: 'u1', role: 'editor' }]
      : undefined,
  }),
  // The upload store revalidates the project grid through this.
  mutate: vi.fn(),
}))
vi.mock('@/components/review/review-provider', () => ({
  ReviewProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useReview: () => ({
    asset,
    versions: [asset.latest_version],
    isLoading: false,
    refetchComments: vi.fn(),
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
vi.mock('@/stores/view-store', () => ({ useViewStore: storeHook(viewState) }))
vi.mock('@/stores/breadcrumb-store', () => ({
  useBreadcrumbStore: storeHook({ setExtraCrumbs: vi.fn(), setLabel: vi.fn() }),
}))
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  api: { get: vi.fn().mockResolvedValue([]), post: vi.fn(), patch: vi.fn() },
}))
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
vi.mock('@/components/review/version-switcher', () => ({ VersionSwitcher: () => null }))
vi.mock('@/components/review/share-dialog', () => ({ ShareDialog: () => null }))
vi.mock('@/components/review/compare/compare-overlay', () => ({ CompareOverlay: () => null }))

import ReviewPage from '../page'
import { ApiError } from '@/lib/api'
import { useUploadStore, __uploadQueueTesting as testing } from '@/stores/upload-store'
import { signInAs, row } from '@/test/upload-session'
import { MB, fakeServer, fileOf, drop, flush } from '@/test/upload-queue-server'

const QUEUED_LINE = 'New version queued, waiting for other uploads.'

function renderPage() {
  return render(<ReviewPage params={{ id: 'p1', assetId: 'a2' }} />)
}

/** What clicking New Version and picking a file does. */
function pickNewVersion(container: HTMLElement, file: File) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  fireEvent.change(input, { target: { files: [file] } })
}

beforeEach(() => {
  vi.clearAllMocks()
  testing.reset()
  window.localStorage.clear()
  useUploadStore.setState({ files: [], versionsRevision: 0, panelOpen: false })
  signInAs('user-1')
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  testing.reset()
})

describe('a new version waiting in the upload queue', () => {
  it('the asset page shows the queued line and refetches when the version id arrives', async () => {
    const server = fakeServer(() => 'wait', 'hang')
    const { container } = renderPage()
    expect(screen.queryByText(QUEUED_LINE)).toBeNull()

    // Two files ahead of it: one starts, the other waits. A big file counts as
    // the whole part budget while it initiates, so nothing else can start.
    await act(async () => {
      drop([fileOf('first.mov', 50 * MB), fileOf('second.mov', 50 * MB)])
      await flush()
    })
    expect(server.names()).toEqual(['first.mov'])

    await act(async () => {
      pickNewVersion(container, fileOf('v2.mov', 50 * MB))
      await flush()
    })

    // It is waiting for the two before it, and says so.
    expect(screen.getByText(QUEUED_LINE)).toBeInTheDocument()
    expect(server.names()).toEqual(['first.mov'])
    // The old guesses at when the version exists are gone: nothing refetches
    // however long it waits.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(refetchVersions).not.toHaveBeenCalled()

    // The first is refused, the second takes its turn and is refused in the same
    // way, and then it is the new version's turn: its initiate is out.
    await act(async () => {
      server.initiates[0].reject(new ApiError(400, 'No'))
      await flush()
    })
    await act(async () => {
      server.initiates[1].reject(new ApiError(400, 'No'))
      await flush()
    })
    expect(server.names()).toEqual(['first.mov', 'second.mov', 'v2.mov'])
    expect(screen.queryByText(QUEUED_LINE)).toBeNull()
    // Its turn has begun but the version does not exist yet.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(refetchVersions).not.toHaveBeenCalled()

    // The initiate answers: the version is on the server, and only now does the
    // page ask for it.
    await act(async () => {
      server.initiates[2].resolve()
      await flush()
    })
    expect(refetchVersions).toHaveBeenCalledTimes(1)
    // Once: no timers follow it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(refetchVersions).toHaveBeenCalledTimes(1)
  })

  it('a new asset\'s initiate says nothing to the version list, which it is not on', async () => {
    const server = fakeServer(() => 'wait', 'hang')
    drop([fileOf('a.mov', 50 * MB)])
    await act(async () => {
      await flush()
    })

    await act(async () => {
      server.initiates[0].resolve()
      await flush()
    })

    expect(useUploadStore.getState().files[0]).toMatchObject({ status: 'uploading', versionId: 'v1' })
    expect(useUploadStore.getState().versionsRevision).toBe(0)
  })

  it('says nothing about another asset\'s queued version, or a queued new asset', () => {
    useUploadStore.setState({
      files: [
        row({ id: 'other', status: 'queued', assetId: 'someone-else', assetName: 'other' }),
        row({ id: 'new', status: 'queued', assetName: 'new' }),
        row({ id: 'mine-started', status: 'starting', assetId: 'a2', assetName: 'mine' }),
      ],
    })

    renderPage()

    expect(screen.queryByText(QUEUED_LINE)).toBeNull()
  })

  it('shows the line for this asset\'s version row while it waits, and not after', () => {
    useUploadStore.setState({ files: [row({ id: 'mine', status: 'queued', assetId: 'a2', assetName: 'mine' })] })

    renderPage()
    expect(screen.getByText(QUEUED_LINE)).toBeInTheDocument()

    act(() => {
      useUploadStore.setState((s) => ({ files: s.files.map((f) => ({ ...f, status: 'starting' as const })) }))
    })
    expect(screen.queryByText(QUEUED_LINE)).toBeNull()
  })
})
