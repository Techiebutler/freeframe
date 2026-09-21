/**
 * The credit and the asset navigator must not be drawn on top of each other.
 *
 * The credit arrived with #203 as `absolute left-1/2 -translate-x-1/2`, and the
 * navigator is centred on the same spot by the two `flex-1` blocks either side
 * of it. So on any asset with a neighbour, "Powered by FreeFrame" was drawn
 * straight across "5 of 7" -- and being an `<a href>` it won the hit test:
 * `elementFromPoint` at the centre of the "next asset" chevron returned the
 * credit's anchor, so the chevron could not be clicked at all.
 *
 * What the fix establishes is structural rather than geometric, which is why
 * this is testable in jsdom where the overlap itself is not: one flex row
 * holding the navigator and then the credit, with nothing absolutely
 * positioned. The assertion is that the credit's own parent contains the
 * counter -- not merely that the two "share a parent", since the counter's
 * parent is the inner navigator div rather than the group.
 *
 * The credit is hidden below `lg`. In flow it is 147px that neither the middle
 * group nor the block on the right can give back, so the surplus leaves the bar
 * past its right edge, where the page root's `overflow-hidden` clips it and
 * nothing scrolls to it -- taking the sidebar toggle with it from about 744px
 * down, which is an iPad in portrait.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

const asset = {
  id: 'a2',
  name: 'Episode 4 — rough cut.mov',
  project_id: 'p1',
  asset_type: 'video',
  latest_version: { id: 'v1', version_number: 1, processing_status: 'ready' },
}
const allAssets = [{ id: 'a1' }, asset, { id: 'a3' }]

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/projects/p1/assets/a2',
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('swr', () => ({
  default: (key: string) => ({
    data: typeof key === 'string' && key.endsWith('/assets') ? allAssets : undefined,
  }),
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
  useUploadStore: storeHook({ startVersionUpload: vi.fn() }),
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
vi.mock('@/components/review/version-switcher', () => ({ VersionSwitcher: () => null }))
vi.mock('@/components/review/share-dialog', () => ({ ShareDialog: () => null }))
vi.mock('@/components/review/compare/compare-overlay', () => ({ CompareOverlay: () => null }))

import ReviewPage from '../page'

function renderPage() {
  return render(<ReviewPage params={{ id: 'p1', assetId: 'a2' }} />)
}

describe('the credit and the asset navigator in the top bar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('puts the credit in the same row as the navigator, not over it', () => {
    renderPage()

    const credit = screen.getByTitle('FreeFrame on GitHub')
    const counter = screen.getByText('2 of 3')

    // The credit's own parent is the centre group, and the counter is inside
    // it. "Share a parent" would not hold: the counter sits in the navigator's
    // own div, one level further down.
    expect(credit.parentElement).not.toBeNull()
    expect(credit.parentElement!.contains(counter)).toBe(true)
  })

  it('puts the navigator first and keeps the group from shrinking', () => {
    renderPage()

    const credit = screen.getByTitle('FreeFrame on GitHub')
    const counter = screen.getByText('2 of 3')
    const group = credit.parentElement!

    // Order decides which of the two sits on the bar's centre line. The
    // navigator is the control; the credit is what stands beside it.
    expect(
      counter.compareDocumentPosition(credit) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    // Without shrink-0 the group is what yields when the bar runs out of room,
    // and the navigator's chevrons are 28px targets that have nothing to give.
    expect(group.className).toContain('shrink-0')
  })

  it('positions neither of them absolutely', () => {
    renderPage()

    const credit = screen.getByTitle('FreeFrame on GitHub')
    const group = credit.parentElement!

    expect(credit.className).not.toContain('absolute')
    expect(group.className).not.toContain('absolute')
    // Overlapping is what `left-1/2 -translate-x-1/2` did, so the fix is only
    // real while that is gone from both.
    expect(credit.className).not.toContain('left-1/2')
    expect(group.className).not.toContain('left-1/2')
  })

  it('keeps the credit out of the bar below lg, where it costs the controls', () => {
    renderPage()

    const credit = screen.getByTitle('FreeFrame on GitHub')

    // Whole class, not a substring: `overflow-hidden` satisfies a substring
    // match, and `overflow-hidden lg:inline-flex` leaves twMerge the base
    // `inline-flex` to keep, which restores the overlap at every width with
    // this test still green.
    expect(credit.className.split(/\s+/)).toContain('hidden')
    expect(credit.className.split(/\s+/)).toContain('lg:inline-flex')
  })
})
