import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import { stubGeometry, restoreGeometry } from '@/test/geometry'

/**
 * The frame fix moved image annotations from container space to picture space.
 * Annotations saved before that carry container dimensions in
 * `_canvasWidth`/`_canvasHeight`, so replaying them against the picture box
 * silently squashes and shifts them. These pin both spaces.
 */

const loaded: Array<Record<string, unknown>> = []
let objects: Array<Record<string, unknown>> = []
let dimensions: Array<{ width: number; height: number }> = []

vi.mock('fabric', () => ({
  Canvas: class {
    setDimensions(d: { width: number; height: number }) {
      dimensions.push(d)
    }
    async loadFromJSON(json: Record<string, unknown>) {
      loaded.push(json)
    }
    getObjects() {
      return objects
    }
    renderAll() {}
    dispose() {}
  },
}))

import { AnnotationOverlay } from '../annotation-overlay'
import { MediaFrameContext } from '../media-frame-context'

/** A Fabric-ish object that records what the overlay sets on it. */
function makeObject(left: number, top: number) {
  return {
    left,
    top,
    scaleX: 1,
    scaleY: 1,
    set(patch: Record<string, number>) {
      Object.assign(this, patch)
    },
    setCoords() {},
  } as unknown as Record<string, unknown>
}

// A 3000x1000 image in a 900x500 pane: the picture box is 900x300 at top 100.
const CONTAINER = { width: 900, height: 500 }
const PICTURE = { left: 0, top: 100, width: 900, height: 300 }

async function renderOverlay(
  annotation: Record<string, unknown>,
  legacy: React.ContextType<typeof MediaFrameContext>,
) {
  const view = render(
    <MediaFrameContext.Provider value={legacy}>
      <AnnotationOverlay annotation={annotation} />
    </MediaFrameContext.Provider>,
  )
  await vi.waitFor(() => expect(loaded.length).toBeGreaterThan(0))
  return view
}

describe('AnnotationOverlay coordinate spaces', () => {
  beforeEach(() => {
    loaded.length = 0
    objects = []
    dimensions = []
    // The overlay is mounted inside the picture box, so that is what it measures.
    stubGeometry({ offsetWidth: PICTURE.width, offsetHeight: PICTURE.height })
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    })
  })
  afterEach(() => {
    restoreGeometry()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('renders a legacy container-space annotation where it was originally drawn', async () => {
    // Drawn 25% down the picture: container y=175 with the picture starting at 100.
    const obj = makeObject(0, 175)
    objects = [obj as never]

    await renderOverlay(
      { objects: [{}], _canvasWidth: 900, _canvasHeight: 500 },
      { containerWidth: CONTAINER.width, containerHeight: CONTAINER.height, left: PICTURE.left, top: PICTURE.top },
    )

    // Same viewport it was authored in, so no rescale — only the shift into the
    // picture box's own origin.
    expect(obj.scaleX).toBe(1)
    expect(obj.scaleY).toBe(1)
    expect(obj.top).toBe(75)
    expect(obj.left).toBe(0)
  })

  it('leaves a picture-space annotation alone when the box matches', async () => {
    const obj = makeObject(0, 75)
    objects = [obj as never]

    await renderOverlay(
      { objects: [{}], _canvasWidth: 900, _canvasHeight: 300, _frameSpace: 'media' },
      { containerWidth: CONTAINER.width, containerHeight: CONTAINER.height, left: PICTURE.left, top: PICTURE.top },
    )

    expect(obj.top).toBe(75)
    expect(obj.scaleY).toBe(1)
  })

  it('rescales a picture-space annotation authored in a differently sized picture box', async () => {
    const obj = makeObject(0, 150)
    objects = [obj as never]

    // Authored in a 450x150 picture box, replayed in 900x300: everything doubles.
    await renderOverlay(
      { objects: [{}], _canvasWidth: 450, _canvasHeight: 150, _frameSpace: 'media' },
      { containerWidth: CONTAINER.width, containerHeight: CONTAINER.height, left: PICTURE.left, top: PICTURE.top },
    )

    expect(obj.scaleY).toBe(2)
    expect(obj.top).toBe(300)
  })

  it('treats unmarked data as picture-space when there is no legacy frame (video)', async () => {
    // VideoFrameConstraint predates the fix, so video annotations were always
    // authored in picture space and must not be shifted.
    const obj = makeObject(0, 75)
    objects = [obj as never]

    await renderOverlay({ objects: [{}], _canvasWidth: 900, _canvasHeight: 300 }, null)

    expect(obj.top).toBe(75)
    expect(obj.scaleY).toBe(1)
  })
})
