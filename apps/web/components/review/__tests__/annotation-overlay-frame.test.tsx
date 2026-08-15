import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import { stubGeometry, restoreGeometry } from '@/test/geometry'

/**
 * The frame fix moved image annotations from container space to picture space.
 * Annotations saved before that carry CONTAINER dimensions in
 * `_canvasWidth`/`_canvasHeight`, with the picture occupying only a band inside
 * them. The overlay reconstructs that band from the image's intrinsic size and
 * re-expresses the mark relative to the picture, so old drawings land where
 * they were actually drawn at any viewer size. These pin both spaces.
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

// A 3000x1000 image authored in a 900x500 pane: the picture box was 900x300
// at top 100, so a mark at container y=175 is 25% down the picture.
const NATURAL = { naturalWidth: 3000, naturalHeight: 1000 }
const AUTHORED = { canvasWidth: 900, canvasHeight: 500 }
const PICTURE = { width: 900, height: 300 }

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

  it('places a legacy container-space mark where it was drawn on the picture', async () => {
    // Container y=175, i.e. 25% down a picture box that ran y=100..400.
    const obj = makeObject(0, 175)
    objects = [obj as never]

    await renderOverlay(
      { objects: [{}], _canvasWidth: AUTHORED.canvasWidth, _canvasHeight: AUTHORED.canvasHeight },
      NATURAL,
    )

    // Replayed into a picture box the same size as the authored one.
    expect(obj.scaleX).toBe(1)
    expect(obj.scaleY).toBe(1)
    expect(obj.top).toBe(75) // 25% of 300
    expect(obj.left).toBe(0)
  })

  it('keeps a legacy mark at the same point on the picture in a bigger viewer', async () => {
    const obj = makeObject(0, 175)
    objects = [obj as never]

    // Same stored data, replayed in a picture box twice as large.
    stubGeometry({ offsetWidth: 1800, offsetHeight: 600 })
    await renderOverlay(
      { objects: [{}], _canvasWidth: AUTHORED.canvasWidth, _canvasHeight: AUTHORED.canvasHeight },
      NATURAL,
    )

    // Still 25% down the picture, now 25% of 600.
    expect(obj.top).toBe(150)
    expect(obj.scaleY).toBe(2)
  })

  it('leaves a picture-space annotation alone when the box matches', async () => {
    const obj = makeObject(0, 75)
    objects = [obj as never]

    await renderOverlay(
      { objects: [{}], _canvasWidth: 900, _canvasHeight: 300, _frameSpace: 'media' },
      NATURAL,
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
      NATURAL,
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
