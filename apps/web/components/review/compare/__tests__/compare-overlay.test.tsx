import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useReviewStore } from '@/stores/review-store'

const replace = vi.fn()
// Configurable per test (image tests flip mode / provide stream urls).
let searchParamsString = 'compare=v-1'
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  usePathname: () => '/projects/p1/assets/a1',
  useSearchParams: () => new URLSearchParams(searchParamsString),
}))

// Per-side capture: record which version's hook instance received each create.
const createComment = vi.fn().mockResolvedValue({})
const createCommentCalls: Array<{ versionId: string | null; args: unknown[] }> = []
// Per-side comments fixture keyed by versionId — lets a single test give one
// side (and only that side) markers/comments without touching the other side.
const commentsByVersion: Record<string, unknown[]> = {}
vi.mock('@/hooks/use-comments', () => ({
  useComments: (_assetId: string, versionId: string | null) => ({
    comments: (versionId && commentsByVersion[versionId]) || [],
    isLoading: false,
    createComment: (...args: unknown[]) => {
      createCommentCalls.push({ versionId, args })
      return createComment(...args)
    },
    resolveComment: vi.fn(), deleteComment: vi.fn(),
    addReaction: vi.fn(), removeReaction: vi.fn(),
  }),
}))
let streamUrl: string | null = null
vi.mock('@/hooks/use-stream-url', () => ({ useStreamUrl: () => ({ url: streamUrl, error: false }) }))
// AnnotationOverlay lazy-imports fabric inside a rAF; stub the exact API
// surface it touches (new Canvas(el, opts) → setDimensions → loadFromJSON
// (awaited) → getObjects → renderAll → dispose) so no real canvas is needed.
vi.mock('fabric', () => ({
  Canvas: class {
    setDimensions() {}
    async loadFromJSON() { return this }
    getObjects() { return [] }
    renderAll() {}
    dispose() {}
  },
}))
// CommentInput calls useReview() unconditionally; the overlay mounts it on render
// (right comment panel defaults open), so provide the minimal context shape it uses.
vi.mock('@/components/review/review-provider', () => ({
  useReview: () => ({ pauseVideo: vi.fn(), registerPauseHandler: vi.fn() }),
}))
// Authoring mounts a real AnnotationCanvas (Fabric) over the active pane; the
// fabric stub above lacks the drawing API (PencilBrush/.on), so swap the canvas
// for a sentinel — these tests assert the WIRING (which pane, one-at-a-time),
// not Fabric drawing behavior.
vi.mock('@/components/review/annotation-canvas', () => ({
  AnnotationCanvas: () => <div data-testid="annotation-canvas" />,
}))
vi.mock('@/hooks/use-video-player', () => ({
  useVideoPlayer: () => ({
    videoRef: { current: null }, state: { duration: 60 },
    controls: { play: vi.fn(), pause: vi.fn(), seek: vi.fn() },
  }),
}))
// Stable fn references (module-level, not recreated per render) so marker-click
// tests can assert on calls; transportIsPlaying is read at render time.
const transportSeekTo = vi.fn()
const transportToggle = vi.fn()
const transportSetIsPlaying = vi.fn()
let transportIsPlaying = false
// Pin the transport clock so pane-local timecodes are deterministic (t = 12.5s).
vi.mock('../use-synced-transport', () => ({
  useSyncedTransport: () => ({
    playerA: { videoRef: { current: null } },
    playerB: { videoRef: { current: null } },
    t: 12.5, total: 60, isPlaying: transportIsPlaying,
    toggle: transportToggle, seekTo: transportSeekTo, setIsPlaying: transportSetIsPlaying,
  }),
}))

import { CompareOverlay } from '../compare-overlay'

function makeVersion(n: number, status = 'ready') {
  return {
    id: `v-${n}`, asset_id: 'a1', version_number: n, processing_status: status,
    created_at: new Date().toISOString(), files: [{ fps: 25, duration_seconds: 60 }],
  } as never
}

function makeComment(id: string, versionId: string, over: Record<string, unknown> = {}) {
  return {
    id, asset_id: 'a1', version_id: versionId, parent_id: null,
    author_id: 'u1', guest_author_id: null,
    timecode_start: 5, timecode_end: null,
    body: 'Fix the color grade', resolved: false, visibility: 'all',
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), deleted_at: null,
    author: { id: 'u1', name: 'Alice', avatar_url: null }, guest_author: null,
    replies: [], annotation: null, reactions: [],
    ...over,
  } as never
}

const asset = { id: 'a1', name: 'Demo', asset_type: 'image' } as never
const videoAsset = { id: 'a1', name: 'Demo', asset_type: 'video' } as never

beforeEach(() => {
  useReviewStore.getState().reset()
  replace.mockClear()
  createComment.mockClear()
  createCommentCalls.length = 0
  for (const k of Object.keys(commentsByVersion)) delete commentsByVersion[k]
  transportSeekTo.mockClear()
  transportToggle.mockClear()
  transportSetIsPlaying.mockClear()
  transportIsPlaying = false
  searchParamsString = 'compare=v-1'
  streamUrl = null
  // jsdom does not implement scrollIntoView; CommentItem calls it when it
  // becomes focused (marker click → setFocusedCommentId). Unrelated to the
  // marker-click contract under test (see comment-overrides.test.tsx).
  Element.prototype.scrollIntoView = vi.fn()
  // jsdom does not implement ResizeObserver; VideoFrameConstraint (which
  // positions each video pane's AnnotationOverlay over the rendered video
  // box) observes the pane container for aspect-fit recalculation.
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
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

  it('shows the asset name, centered in the top bar', () => {
    render(
      <CompareOverlay asset={asset} versions={[makeVersion(1), makeVersion(3)]} rightVersion={makeVersion(3)} onClose={vi.fn()} />,
    )
    expect(screen.getByText('Demo')).toBeInTheDocument()
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

  it('hides the comment composer for view-only users (canComment=false)', () => {
    render(
      <CompareOverlay asset={videoAsset} versions={[makeVersion(1), makeVersion(3)]} rightVersion={makeVersion(3)} onClose={vi.fn()} canComment={false} />,
    )
    // Panels still render (comments are readable), but neither side's composer does.
    expect(screen.queryByPlaceholderText('Leave your comment...')).not.toBeInTheDocument()
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

describe('CompareOverlay per-side audio toggle', () => {
  it('defaults to B audible / A muted, and exclusive-unmutes on click (A→B mutes, B unmute, mute-audible→both muted)', () => {
    const { container } = render(
      <CompareOverlay asset={videoAsset} versions={[makeVersion(1), makeVersion(3)]} rightVersion={makeVersion(3)} onClose={vi.fn()} />,
    )
    // badgeA = v1 (left, id v-1 per the mocked ?compare=v-1 param), badgeB = v3 (rightVersion = makeVersion(3))
    const videos = container.querySelectorAll('video')
    expect(videos).toHaveLength(2)
    const [videoA, videoB] = Array.from(videos) as HTMLVideoElement[]

    // Default: B carries audio.
    expect(videoA.muted).toBe(true)
    expect(videoB.muted).toBe(false)
    expect(screen.getByLabelText('Unmute v1')).toBeInTheDocument()
    expect(screen.getByLabelText('Mute v3')).toBeInTheDocument()

    // Click the muted side (A) — unmutes A AND mutes B (exclusive unmute).
    fireEvent.click(screen.getByLabelText('Unmute v1'))
    expect(videoA.muted).toBe(false)
    expect(videoB.muted).toBe(true)
    expect(screen.getByLabelText('Mute v1')).toBeInTheDocument()
    expect(screen.getByLabelText('Unmute v3')).toBeInTheDocument()

    // Click the now-audible side (A) again — mutes it; B stays muted (both muted).
    fireEvent.click(screen.getByLabelText('Mute v1'))
    expect(videoA.muted).toBe(true)
    expect(videoB.muted).toBe(true)
    expect(screen.getByLabelText('Unmute v1')).toBeInTheDocument()
    expect(screen.getByLabelText('Unmute v3')).toBeInTheDocument()
  })

  it('re-enforces exclusive mute on the elements after external drift (React muted-prop quirk)', () => {
    const { container } = render(
      <CompareOverlay asset={videoAsset} versions={[makeVersion(1), makeVersion(3)]} rightVersion={makeVersion(3)} onClose={vi.fn()} />,
    )
    const [videoA, videoB] = Array.from(container.querySelectorAll('video')) as HTMLVideoElement[]

    // Default enforcement right after mount + effects.
    expect(videoA.muted).toBe(true)
    expect(videoB.muted).toBe(false)

    // Simulate external drift (React muted-prop update quirk, facebook/react#10389,
    // or an HLS re-attachment resurrecting audio): BOTH sides audible.
    videoA.muted = false
    videoB.muted = false

    // Any state-changing interaction must re-enforce the tri-state exclusively.
    // Clicking B's toggle (audioSide 'b' → 'none') leaves A's muted PROP unchanged
    // (true → true), so React's prop diff alone would never repair A's drifted
    // element — only the imperative enforcement effect does.
    fireEvent.click(screen.getByLabelText('Mute v3'))
    expect(videoA.muted).toBe(true)
    expect(videoB.muted).toBe(true)

    // And never both audible after further toggling.
    fireEvent.click(screen.getByLabelText('Unmute v1'))
    expect(videoA.muted).toBe(false)
    expect(videoB.muted).toBe(true)
  })
})

describe('CompareOverlay marker click', () => {
  it('seeks with the offset, pauses via toggle (not setIsPlaying), focuses the comment, and opens the closed panel', () => {
    commentsByVersion['v-1'] = [makeComment('c1', 'v-1')]
    transportIsPlaying = true
    render(
      <CompareOverlay asset={videoAsset} versions={[makeVersion(1), makeVersion(3)]} rightVersion={makeVersion(3)} onClose={vi.fn()} />,
    )
    // Left panel starts closed — its CommentPanel content isn't rendered yet.
    expect(screen.queryByText('Fix the color grade')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('marker-a-c1'))

    // offA defaults to 0 (mocked searchParams carries no offA/offB).
    expect(transportSeekTo).toHaveBeenCalledWith(5)
    expect(transportToggle).toHaveBeenCalledTimes(1)
    expect(transportSetIsPlaying).not.toHaveBeenCalled()
    expect(useReviewStore.getState().focusedCommentId).toBe('c1')
    expect(screen.getByText('Fix the color grade')).toBeInTheDocument()
  })

  it('does not pause when already paused', () => {
    commentsByVersion['v-1'] = [makeComment('c2', 'v-1')]
    transportIsPlaying = false
    render(
      <CompareOverlay asset={videoAsset} versions={[makeVersion(1), makeVersion(3)]} rightVersion={makeVersion(3)} onClose={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('marker-a-c2'))
    expect(transportSeekTo).toHaveBeenCalledWith(5)
    expect(transportToggle).not.toHaveBeenCalled()
    expect(useReviewStore.getState().focusedCommentId).toBe('c2')
  })
})

describe('CompareOverlay per-pane annotation display', () => {
  const DRAWING = { objects: [], _canvasWidth: 640, _canvasHeight: 360 }

  it('marker click on an annotated comment mounts the overlay in that video pane only; store untouched', () => {
    commentsByVersion['v-1'] = [
      makeComment('c1', 'v-1', { annotation: { id: 'ann1', comment_id: 'c1', drawing_data: DRAWING } }),
    ]
    const { container } = render(
      <CompareOverlay asset={videoAsset} versions={[makeVersion(1), makeVersion(3)]} rightVersion={makeVersion(3)} onClose={vi.fn()} />,
    )
    expect(screen.queryByTestId('annotation-overlay')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('marker-a-c1'))

    const overlays = screen.getAllByTestId('annotation-overlay')
    expect(overlays).toHaveLength(1)
    // The overlay renders inside pane A's VideoFrameConstraint (video-frame
    // coordinates — the space drawings are authored in), which sits in the
    // same pane container as pane A's <video>.
    const videos = container.querySelectorAll('video')
    const constraint = overlays[0].parentElement as HTMLElement
    expect(constraint).toHaveClass('overflow-hidden')
    expect(constraint.parentElement).toContainElement(videos[0] as HTMLElement)
    expect(constraint.parentElement).not.toContainElement(videos[1] as HTMLElement)
    // Per-side state, not the global store (which would leak to the normal view).
    expect(useReviewStore.getState().activeAnnotation).toBeNull()
  })

  it('marker click on a drawing-less comment clears that side annotation', () => {
    commentsByVersion['v-1'] = [
      makeComment('c1', 'v-1', { annotation: { id: 'ann1', comment_id: 'c1', drawing_data: DRAWING } }),
      makeComment('c2', 'v-1', { timecode_start: 10 }),
    ]
    render(
      <CompareOverlay asset={videoAsset} versions={[makeVersion(1), makeVersion(3)]} rightVersion={makeVersion(3)} onClose={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('marker-a-c1'))
    expect(screen.getAllByTestId('annotation-overlay')).toHaveLength(1)

    fireEvent.click(screen.getByTestId('marker-a-c2'))
    expect(screen.queryByTestId('annotation-overlay')).not.toBeInTheDocument()
  })

  it('image side-by-side: annotated comment row click mounts the overlay inside that pane transform wrapper', () => {
    searchParamsString = 'compare=v-1&mode=sbs'
    streamUrl = '/img.webp'
    commentsByVersion['v-3'] = [
      makeComment('c9', 'v-3', {
        timecode_start: null,
        annotation: { id: 'ann9', comment_id: 'c9', drawing_data: DRAWING },
      }),
    ]
    render(
      <CompareOverlay asset={asset} versions={[makeVersion(1), makeVersion(3)]} rightVersion={makeVersion(3)} onClose={vi.fn()} />,
    )
    // Right panel is open by default — click the comment row (side B).
    fireEvent.click(screen.getByText('Fix the color grade'))

    const overlay = screen.getByTestId('annotation-overlay')
    // Same wrapper as pane B's <img> — drawings zoom/pan with the image.
    expect(overlay.parentElement).toContainElement(screen.getByAltText('v3'))
    expect(overlay.parentElement).not.toContainElement(screen.getByAltText('v1'))
    expect(useReviewStore.getState().activeAnnotation).toBeNull()
  })

  it('wipe: a v2 (right) marker is clipped to the RIGHT of the divider — no bleed onto v1', () => {
    streamUrl = '/img.webp'
    commentsByVersion['v-3'] = [
      makeComment('c9', 'v-3', {
        timecode_start: null,
        annotation: { id: 'ann9', comment_id: 'c9', drawing_data: DRAWING },
      }),
    ]
    render(
      <CompareOverlay asset={asset} versions={[makeVersion(1), makeVersion(3)]} rightVersion={makeVersion(3)} onClose={vi.fn()} />,
    )
    fireEvent.click(screen.getByText('Fix the color grade'))

    const overlay = screen.getByTestId('annotation-overlay')
    expect(screen.getByTestId('wipe-stage')).toContainElement(overlay)
    // Side B is visible right of the divider (split defaults to 50%), so its
    // annotation is clipped to that half — matching the B-image clip.
    expect((screen.getByTestId('wipe-overlay-clip') as HTMLElement).style.clipPath).toBe('inset(0 0 0 50%)')
  })

  it('wipe: a v1 (left) marker is clipped to the LEFT of the divider — no bleed onto v2', () => {
    streamUrl = '/img.webp'
    commentsByVersion['v-1'] = [
      makeComment('c1', 'v-1', {
        timecode_start: null,
        annotation: { id: 'ann1', comment_id: 'c1', drawing_data: DRAWING },
      }),
    ]
    render(
      <CompareOverlay asset={asset} versions={[makeVersion(1), makeVersion(3)]} rightVersion={makeVersion(3)} onClose={vi.fn()} />,
    )
    // Left panel is closed by default — open it, then click the v1 comment row.
    fireEvent.click(screen.getByLabelText('Toggle left comments'))
    fireEvent.click(screen.getByText('Fix the color grade'))

    const overlay = screen.getByTestId('annotation-overlay')
    expect(screen.getByTestId('wipe-stage')).toContainElement(overlay)
    // Side A is visible left of the divider, so its annotation is clipped there.
    expect((screen.getByTestId('wipe-overlay-clip') as HTMLElement).style.clipPath).toBe('inset(0 50% 0 0)')
  })

  it('starting playback clears the shown drawings (normal-player parity)', () => {
    commentsByVersion['v-1'] = [
      makeComment('c1', 'v-1', { annotation: { id: 'ann1', comment_id: 'c1', drawing_data: DRAWING } }),
    ]
    transportIsPlaying = false
    const { rerender } = render(
      <CompareOverlay asset={videoAsset} versions={[makeVersion(1), makeVersion(3)]} rightVersion={makeVersion(3)} onClose={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('marker-a-c1'))
    expect(screen.getAllByTestId('annotation-overlay')).toHaveLength(1)

    // Transport flips to playing (scrubber button / space key). Fresh JSX —
    // an identical element reference would let React bail out of the render.
    transportIsPlaying = true
    rerender(
      <CompareOverlay asset={videoAsset} versions={[makeVersion(1), makeVersion(3)]} rightVersion={makeVersion(3)} onClose={vi.fn()} />,
    )
    expect(screen.queryByTestId('annotation-overlay')).not.toBeInTheDocument()
  })
})

describe('CompareOverlay comment click pause parity', () => {
  it('comment row click while playing seeks pane-local AND pauses via toggle', () => {
    commentsByVersion['v-3'] = [makeComment('c3', 'v-3')]
    transportIsPlaying = true
    render(
      <CompareOverlay asset={videoAsset} versions={[makeVersion(1), makeVersion(3)]} rightVersion={makeVersion(3)} onClose={vi.fn()} />,
    )
    // Right panel is open by default — CommentItem's row click passes pause=true.
    fireEvent.click(screen.getByText('Fix the color grade'))
    expect(transportSeekTo).toHaveBeenCalledWith(5)
    expect(transportToggle).toHaveBeenCalledTimes(1)
  })

  it('does not pause when already paused', () => {
    commentsByVersion['v-3'] = [makeComment('c3', 'v-3')]
    transportIsPlaying = false
    render(
      <CompareOverlay asset={videoAsset} versions={[makeVersion(1), makeVersion(3)]} rightVersion={makeVersion(3)} onClose={vi.fn()} />,
    )
    fireEvent.click(screen.getByText('Fix the color grade'))
    expect(transportSeekTo).toHaveBeenCalledWith(5)
    expect(transportToggle).not.toHaveBeenCalled()
  })
})

describe('CompareOverlay annotation authoring', () => {
  it('video: clicking a pane pencil enters drawing on that pane and mounts a canvas over it', () => {
    render(
      <CompareOverlay asset={videoAsset} versions={[makeVersion(1), makeVersion(3)]} rightVersion={makeVersion(3)} onClose={vi.fn()} />,
    )
    expect(screen.queryByTestId('annotation-canvas')).not.toBeInTheDocument()
    // Only the right panel is open by default → exactly one composer / pencil (pane B).
    fireEvent.click(screen.getByTitle('Draw annotation'))
    expect(screen.getByTestId('annotation-canvas')).toBeInTheDocument()
    expect(screen.getByTitle('Exit drawing')).toBeInTheDocument()
    // Exiting removes the canvas and restores the pencil.
    fireEvent.click(screen.getByTitle('Exit drawing'))
    expect(screen.queryByTestId('annotation-canvas')).not.toBeInTheDocument()
    expect(screen.getByTitle('Draw annotation')).toBeInTheDocument()
  })

  it('video: only one pane draws at a time — clicking the other pane switches sides', () => {
    render(
      <CompareOverlay asset={videoAsset} versions={[makeVersion(1), makeVersion(3)]} rightVersion={makeVersion(3)} onClose={vi.fn()} />,
    )
    fireEvent.click(screen.getByLabelText('Toggle left comments')) // open pane A too
    expect(screen.getAllByTitle('Draw annotation')).toHaveLength(2)
    fireEvent.click(screen.getAllByTitle('Draw annotation')[0]) // pane A starts drawing
    expect(screen.getAllByTestId('annotation-canvas')).toHaveLength(1)
    expect(screen.getByTitle('Exit drawing')).toBeInTheDocument()
    // Pane B still shows its pencil; clicking it moves drawing to B (still ONE canvas).
    fireEvent.click(screen.getByTitle('Draw annotation'))
    expect(screen.getAllByTestId('annotation-canvas')).toHaveLength(1)
    expect(screen.getByTitle('Exit drawing')).toBeInTheDocument()
  })

  it('image wipe: authoring is disabled (single ambiguous stage) — no pencil', () => {
    streamUrl = 'http://x/img' // wipe renders once both urls resolve
    render(
      <CompareOverlay asset={asset} versions={[makeVersion(1), makeVersion(3)]} rightVersion={makeVersion(3)} onClose={vi.fn()} />,
    )
    expect(screen.queryByTitle('Draw annotation')).not.toBeInTheDocument()
  })

  it('image side-by-side: authoring is enabled and mounts a canvas over the active pane', () => {
    streamUrl = 'http://x/img'
    searchParamsString = 'compare=v-1&mode=sbs'
    render(
      <CompareOverlay asset={asset} versions={[makeVersion(1), makeVersion(3)]} rightVersion={makeVersion(3)} onClose={vi.fn()} />,
    )
    fireEvent.click(screen.getByTitle('Draw annotation')) // pane B (right panel open)
    expect(screen.getByTestId('annotation-canvas')).toBeInTheDocument()
  })
})
