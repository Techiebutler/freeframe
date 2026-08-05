import { describe, expect, it } from 'vitest'
import { renderedImageBox } from '../media-frame'

/**
 * The three shapes below were measured in a real browser (Chrome, file:// probe)
 * against the exact CSS the app ships, because the two <img> patterns in this
 * codebase disagree about where the image actually lands:
 *
 *   image-viewer.tsx / compare panes:  max-w-full max-h-full object-contain
 *   video-player.tsx <video>:          absolute inset-0 w-full h-full object-contain
 *
 * `max-*` only ever SHRINKS a replaced element, so an image smaller than its
 * container renders at natural size — it is NOT scaled up to the contain box.
 * Computing the contain box from the CONTAINER (what VideoFrameConstraint does,
 * correctly, for <video>) gets that case wrong. Hence: contain math inside the
 * element's own box, offset by where the element sits.
 */

const el = (
  naturalWidth: number, naturalHeight: number,
  elementWidth: number, elementHeight: number,
  offsetLeft = 0, offsetTop = 0,
) => ({ naturalWidth, naturalHeight, elementWidth, elementHeight, offsetLeft, offsetTop })

describe('renderedImageBox — measured browser cases', () => {
  it('image smaller than its container renders at natural size, centered (max-* does not upscale)', () => {
    // 100x200 image, 800x400 container, max-w-full max-h-full
    // browser: element box 100x200 at (350,100)
    expect(renderedImageBox(el(100, 200, 100, 200, 350, 100)))
      .toEqual({ left: 350, top: 100, width: 100, height: 200 })
  })

  it('image larger than its container is shrunk to the contain box', () => {
    // 4000x1000 image, 800x400 container
    // browser: element box 800x200 at (0,100)
    expect(renderedImageBox(el(4000, 1000, 800, 200, 0, 100)))
      .toEqual({ left: 0, top: 100, width: 800, height: 200 })
  })

  it('element that fills its container letterboxes internally (the <video> pattern)', () => {
    // 100x200 image in an element stretched to 800x400 by w-full h-full
    // browser: element box 800x400 at (0,0); the picture occupies 200x400 at (300,0)
    expect(renderedImageBox(el(100, 200, 800, 400, 0, 0)))
      .toEqual({ left: 300, top: 0, width: 200, height: 400 })
  })
})

describe('renderedImageBox — letterbox direction', () => {
  it('pads left/right when the image is taller than the element box', () => {
    expect(renderedImageBox(el(1, 2, 400, 400)))
      .toEqual({ left: 100, top: 0, width: 200, height: 400 })
  })

  it('pads top/bottom when the image is wider than the element box', () => {
    expect(renderedImageBox(el(2, 1, 400, 400)))
      .toEqual({ left: 0, top: 100, width: 400, height: 200 })
  })

  it('adds no padding when the aspect ratios already match', () => {
    expect(renderedImageBox(el(1600, 900, 800, 450, 10, 20)))
      .toEqual({ left: 10, top: 20, width: 800, height: 450 })
  })

  it('carries the element offset through in both axes', () => {
    expect(renderedImageBox(el(1, 1, 400, 200, 30, 40)))
      .toEqual({ left: 130, top: 40, width: 200, height: 200 })
  })
})

describe('renderedImageBox — degenerate input', () => {
  it('falls back to the element box before natural dimensions are known', () => {
    // <img> not decoded yet: naturalWidth/Height are 0
    expect(renderedImageBox(el(0, 0, 800, 400, 5, 6)))
      .toEqual({ left: 5, top: 6, width: 800, height: 400 })
  })

  it('returns null when the element has not been laid out', () => {
    expect(renderedImageBox(el(100, 200, 0, 0))).toBeNull()
  })
})
