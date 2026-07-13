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
