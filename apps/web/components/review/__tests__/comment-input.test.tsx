import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { useReviewStore } from '@/stores/review-store'

// CommentInput calls useReview() unconditionally; mirror the minimal shape
// used by compare-overlay.test.tsx (only pauseVideo is read on submit path).
vi.mock('../review-provider', () => ({
  useReview: () => ({ pauseVideo: vi.fn(), registerPauseHandler: vi.fn() }),
}))

import { CommentInput } from '../comment-input'

beforeEach(() => {
  useReviewStore.getState().reset()
})

async function typeAndSubmit(text: string) {
  const textarea = screen.getByPlaceholderText('Leave your comment...')
  fireEvent.change(textarea, { target: { value: text } })
  fireEvent.keyDown(textarea, { key: 'Enter' })
  await waitFor(() => expect(textarea).toHaveValue(''))
}

describe('CommentInput timecode at playhead 0', () => {
  it('submits timecode 0 (not undefined) when attached and the playhead is at 0:00', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(
      <CommentInput
        assetId="a1"
        projectId="p1"
        assetType="video"
        playheadTimeOverride={0}
        onSubmit={onSubmit}
      />,
    )
    // Badge shows the promised timecode while composing.
    expect(screen.getByText('00:00:00:00')).toBeInTheDocument()

    await typeAndSubmit('remove kite')

    expect(onSubmit).toHaveBeenCalledTimes(1)
    const [body, timecodeStart] = onSubmit.mock.calls[0]
    expect(body).toBe('remove kite')
    expect(timecodeStart).toBe(0)
    expect(timecodeStart).not.toBeUndefined()
  })

  it('submits the real timecode when attached and the playhead is non-zero', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(
      <CommentInput
        assetId="a1"
        projectId="p1"
        assetType="video"
        playheadTimeOverride={26}
        onSubmit={onSubmit}
      />,
    )
    await typeAndSubmit('looks good')
    expect(onSubmit.mock.calls[0][1]).toBe(26)
  })

  it('omits the timecode when detached (no drawing)', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(
      <CommentInput
        assetId="a1"
        projectId="p1"
        assetType="video"
        playheadTimeOverride={12}
        onSubmit={onSubmit}
      />,
    )
    fireEvent.click(screen.getByTitle('Detach timecode'))
    await typeAndSubmit('no timecode please')
    expect(onSubmit.mock.calls[0][1]).toBeUndefined()
  })

  it('reads the playhead from the store when playheadTimeOverride is omitted (normal reviewer path)', async () => {
    useReviewStore.getState().setPlayheadTime(26)
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(
      <CommentInput assetId="a1" projectId="p1" assetType="video" onSubmit={onSubmit} />,
    )
    await typeAndSubmit('from store playhead')
    expect(onSubmit.mock.calls[0][1]).toBe(26)
  })

  it('never attaches a timecode for image assets, even at a non-zero playhead', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(
      <CommentInput
        assetId="a1"
        projectId="p1"
        assetType="image"
        playheadTimeOverride={5}
        onSubmit={onSubmit}
      />,
    )
    await typeAndSubmit('nice crop')
    expect(onSubmit.mock.calls[0][1]).toBeUndefined()
  })
})

describe('CommentInput compare drawing props (annotationActive / onToggleAnnotation)', () => {
  it('routes the pencil through onToggleAnnotation, not the global drawing toggle', () => {
    const onToggle = vi.fn()
    render(
      <CommentInput
        assetId="a1"
        projectId="p1"
        assetType="video"
        onSubmit={vi.fn()}
        annotationActive={false}
        onToggleAnnotation={onToggle}
      />,
    )
    fireEvent.click(screen.getByTitle('Draw annotation'))
    expect(onToggle).toHaveBeenCalledTimes(1)
    // The global store flag is left untouched — the parent owns drawing state.
    expect(useReviewStore.getState().isDrawingMode).toBe(false)
  })

  it('shows the drawing toolbar (not the pencil) when annotationActive is true', () => {
    render(
      <CommentInput
        assetId="a1"
        projectId="p1"
        assetType="video"
        onSubmit={vi.fn()}
        annotationActive
        onToggleAnnotation={vi.fn()}
      />,
    )
    expect(screen.getByTitle('Exit drawing')).toBeInTheDocument()
    expect(screen.queryByTitle('Draw annotation')).not.toBeInTheDocument()
  })

  it('an INACTIVE pane never attaches the shared pending drawing (no cross-pane leak)', async () => {
    // A drawing from the other pane sits in the shared store...
    useReviewStore.getState().setPendingAnnotation({ objects: [{ type: 'path' }] })
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(
      <CommentInput
        assetId="a1"
        projectId="p1"
        assetType="video"
        playheadTimeOverride={4}
        onSubmit={onSubmit}
        annotationActive={false}
        onToggleAnnotation={vi.fn()}
      />,
    )
    await typeAndSubmit('just text on this side')
    // ...but this inactive pane must not pick it up: annotationData stays undefined.
    expect(onSubmit.mock.calls[0][3]).toBeUndefined()
  })

  it('the ACTIVE pane attaches the pending drawing on submit', async () => {
    const drawing = { objects: [{ type: 'path' }] }
    useReviewStore.getState().setPendingAnnotation(drawing)
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(
      <CommentInput
        assetId="a1"
        projectId="p1"
        assetType="video"
        playheadTimeOverride={4}
        onSubmit={onSubmit}
        annotationActive
        onToggleAnnotation={vi.fn()}
      />,
    )
    await typeAndSubmit('see my markup')
    expect(onSubmit.mock.calls[0][3]).toEqual(drawing)
  })

  it('an INACTIVE pane submit leaves the shared drawing state intact (other pane keeps drawing)', async () => {
    // The other pane is mid-draw: global drawing mode on, a drawing pending.
    useReviewStore.getState().setIsDrawingMode(true)
    useReviewStore.getState().setPendingAnnotation({ objects: [{ type: 'path' }] })
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(
      <CommentInput
        assetId="a1"
        projectId="p1"
        assetType="video"
        playheadTimeOverride={4}
        onSubmit={onSubmit}
        annotationActive={false}
        onToggleAnnotation={vi.fn()}
      />,
    )
    await typeAndSubmit('text on the other side')
    // Submitting on the inactive pane must NOT wipe the active pane's drawing/state.
    expect(useReviewStore.getState().isDrawingMode).toBe(true)
    expect(useReviewStore.getState().pendingAnnotation).toEqual({ objects: [{ type: 'path' }] })
  })

  it('an INACTIVE pane does not highlight its pencil from the other pane’s pending drawing', () => {
    useReviewStore.getState().setPendingAnnotation({ objects: [{ type: 'path' }] })
    render(
      <CommentInput
        assetId="a1"
        projectId="p1"
        assetType="video"
        onSubmit={vi.fn()}
        annotationActive={false}
        onToggleAnnotation={vi.fn()}
      />,
    )
    expect(screen.getByTitle('Draw annotation').className).not.toContain('text-accent')
  })
})
