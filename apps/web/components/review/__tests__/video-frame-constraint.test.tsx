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
 * Unlike the <img> constraint, this one derives the fit from the CONTAINER,
 * which is correct here: the <video> is `w-full h-full object-contain`, so it
 * always fills its container and letterboxes internally.
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
  it('letterboxes top/bottom when the video is wider than its container', () => {
    // 16:9 video in a square container: full width, bars above and below.
    stubGeometry({ videoWidth: 1920, videoHeight: 1080, clientWidth: 800, clientHeight: 800 })
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
    stubGeometry({ videoWidth: 1080, videoHeight: 1920, clientWidth: 800, clientHeight: 800 })
    render(<Harness />)

    expect(wrapper()).toHaveStyle({
      left: '175px',
      top: '0px',
      width: '450px',
      height: '800px',
    })
  })

  it('adds no bars when the video and container already share an aspect ratio', () => {
    stubGeometry({ videoWidth: 1920, videoHeight: 1080, clientWidth: 1600, clientHeight: 900 })
    render(<Harness />)

    expect(wrapper()).toHaveStyle({ left: '0px', top: '0px', width: '1600px', height: '900px' })
  })

  it('fills the container until the video reports its dimensions', () => {
    // videoWidth is 0 until loadedmetadata; the overlay must not collapse to 0x0.
    stubGeometry({ videoWidth: 0, videoHeight: 0, clientWidth: 800, clientHeight: 800 })
    render(<Harness />)

    expect(wrapper()).toHaveStyle({ position: 'absolute', inset: '0px' })
  })

  it('fills the container when the container itself has not been laid out', () => {
    // Dividing by a 0-height container yields a NaN aspect, which used to fall
    // through to a 0x0 overlay. Fill instead and recompute on the next resize.
    stubGeometry({ videoWidth: 1920, videoHeight: 1080, clientWidth: 0, clientHeight: 0 })
    render(<Harness />)

    expect(wrapper()).toHaveStyle({ position: 'absolute', inset: '0px' })
  })
})
