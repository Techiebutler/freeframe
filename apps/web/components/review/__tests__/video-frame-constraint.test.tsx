import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { stubGeometry, restoreGeometry } from '@/test/geometry'
import * as React from 'react'
import { render, screen } from '@testing-library/react'
import { VideoFrameConstraint } from '../video-player'

vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }))

/**
 * VideoFrameConstraint had no direct coverage: the compare and wipe suites stub
 * ResizeObserver to a no-op precisely to route AROUND its layout math, so
 * nothing pinned the box it computes. These tests pin it, which is what lets the
 * fit itself move into the shared `containBox` helper without guessing.
 *
 * The main player's <video> is `absolute inset-0 w-full h-full object-contain`,
 * so it fills its container and letterboxes internally. The compare panes use
 * `max-h-full max-w-full` instead, where the element only ever SHRINKS and so
 * hugs the picture — the same distinction the <img> constraint exists for.
 * Measuring the element's own box is correct for both.
 */
function Harness() {
  const videoRef = React.useRef<HTMLVideoElement>(null)
  return (
    <div>
      <video ref={videoRef} />
      <VideoFrameConstraint videoRef={videoRef as React.RefObject<HTMLVideoElement>}>
        <div data-testid="child" />
      </VideoFrameConstraint>
    </div>
  )
}

const wrapper = () => screen.getByTestId('child').parentElement as HTMLElement

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
})

afterEach(() => {
  restoreGeometry()
})

describe('VideoFrameConstraint', () => {
  /**
   * The main player's <video> is `absolute inset-0 w-full h-full`, so its own
   * box is exactly the container's and sits at its origin. These cases describe
   * that player, so the element box tracks the container.
   */
  const fillingPlayer = (w: number, h: number) => ({
    clientWidth: w,
    clientHeight: h,
    offsetWidth: w,
    offsetHeight: h,
    offsetLeft: 0,
    offsetTop: 0,
  })

  it('letterboxes top/bottom when the video is wider than its container', () => {
    // 16:9 video in a square container: full width, bars above and below.
    stubGeometry({ videoWidth: 1920, videoHeight: 1080, ...fillingPlayer(800, 800) })
    render(<Harness />)

    expect(wrapper()).toHaveStyle({
      position: 'absolute',
      left: '0px',
      top: '175px',
      width: '800px',
      height: '450px',
    })
  })

  it('pillarboxes left/right when the video is taller than its container', () => {
    stubGeometry({ videoWidth: 1080, videoHeight: 1920, ...fillingPlayer(800, 800) })
    render(<Harness />)

    expect(wrapper()).toHaveStyle({
      left: '175px',
      top: '0px',
      width: '450px',
      height: '800px',
    })
  })

  it('adds no bars when the video and container already share an aspect ratio', () => {
    stubGeometry({ videoWidth: 1920, videoHeight: 1080, ...fillingPlayer(1600, 900) })
    render(<Harness />)

    expect(wrapper()).toHaveStyle({ left: '0px', top: '0px', width: '1600px', height: '900px' })
  })

  it('covers the whole element until the video reports its dimensions', () => {
    // videoWidth is 0 until loadedmetadata, so there is no aspect to fit yet.
    // The overlay must not collapse to 0x0 — it spans the element's box, which
    // for the filling player is the container.
    stubGeometry({ videoWidth: 0, videoHeight: 0, ...fillingPlayer(800, 800) })
    render(<Harness />)

    expect(wrapper()).toHaveStyle({
      position: 'absolute',
      left: '0px',
      top: '0px',
      width: '800px',
      height: '800px',
    })
  })

  it('fills the container when the container itself has not been laid out', () => {
    // A 0-sized element yields no box at all. Fill instead of collapsing to
    // 0x0, and recompute on the next resize.
    stubGeometry({ videoWidth: 1920, videoHeight: 1080, ...fillingPlayer(0, 0) })
    render(<Harness />)

    expect(wrapper()).toHaveStyle({ position: 'absolute', inset: '0px' })
  })

  it('hugs the element box when the video is smaller than its pane (compare panes)', () => {
    // compare-overlay renders <video className="max-h-full max-w-full">, so a
    // 100x200 video in an 800x400 pane renders at natural size, centred — it is
    // NOT upscaled to the 200x400 the container fit would produce.
    stubGeometry({
      videoWidth: 100,
      videoHeight: 200,
      clientWidth: 800,
      clientHeight: 400,
      offsetWidth: 100,
      offsetHeight: 200,
      offsetLeft: 350,
      offsetTop: 100,
    })
    render(<Harness />)

    expect(wrapper()).toHaveStyle({
      position: 'absolute',
      left: '350px',
      top: '100px',
      width: '100px',
      height: '200px',
    })
  })
})
