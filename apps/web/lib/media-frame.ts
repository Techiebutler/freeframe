/** Geometry of a laid-out <img>, as read off the DOM. */
export interface ImageFrameMetrics {
  /** Intrinsic size. Both 0 until the image has decoded. */
  naturalWidth: number
  naturalHeight: number
  /** The element's own laid-out box (offsetWidth/offsetHeight). */
  elementWidth: number
  elementHeight: number
  /** Where that box sits inside the nearest positioned ancestor. */
  offsetLeft: number
  offsetTop: number
}

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

/**
 * The centred, aspect-preserving sub-box `object-fit: contain` produces when
 * fitting content into a box. `left`/`top` are relative to the box's own origin.
 *
 * Shared by the two constraint components so they cannot drift apart:
 * `renderedImageBox` below fits the picture inside the <img>'s own box and then
 * offsets by where that element sits, while `VideoFrameConstraint` fits the
 * video inside its container. Only the reference box differs — the fit itself
 * is one implementation.
 *
 * Compares aspect ratios by cross-multiplying rather than dividing, so an exact
 * fit (a 16:9 frame in a 16:9 box) stays exact instead of drifting a fraction of
 * a pixel through an intermediate ratio.
 *
 * Assumes all four dimensions are non-zero; callers guard degenerate input.
 */
export function containBox(
  contentWidth: number,
  contentHeight: number,
  boxWidth: number,
  boxHeight: number,
): Box {
  const contentIsWider = contentWidth * boxHeight > contentHeight * boxWidth

  const width = contentIsWider ? boxWidth : (boxHeight * contentWidth) / contentHeight
  const height = contentIsWider ? (boxWidth * contentHeight) / contentWidth : boxHeight

  return { left: (boxWidth - width) / 2, top: (boxHeight - height) / 2, width, height }
}

/**
 * The box the picture actually occupies, in the coordinate space of the <img>'s
 * offsetParent — i.e. excluding the empty bands `object-contain` leaves behind.
 *
 * Annotations must be authored and displayed in THIS box rather than the
 * container's, or the same drawing lands somewhere else whenever the container's
 * aspect ratio changes (sidebar collapsed vs expanded, window resize, compare
 * panes, share view). See `renderedImageBox`'s callers.
 *
 * Deliberately measured from the ELEMENT's box, not the container's. The two
 * <img> patterns in this codebase behave differently:
 *
 *   `max-w-full max-h-full`  the element already hugs the picture, since max-*
 *                            only shrinks — an image smaller than its container
 *                            renders at natural size and is NOT scaled up.
 *   `w-full h-full`          the element fills the container and the picture
 *                            letterboxes inside it (what <video> does).
 *
 * Running the contain fit inside the element's own box is correct for both.
 * Deriving it from the container instead — which is what `VideoFrameConstraint`
 * does, correctly, for a filling <video> — silently upscales the box for any
 * image smaller than its container.
 */
export function renderedImageBox({
  naturalWidth,
  naturalHeight,
  elementWidth,
  elementHeight,
  offsetLeft,
  offsetTop,
}: ImageFrameMetrics): Box | null {
  // Not laid out yet — there is no box to report.
  if (!elementWidth || !elementHeight) return null

  // Not decoded yet: the element box is the best available answer, and the
  // caller recalculates on load.
  if (!naturalWidth || !naturalHeight) {
    return { left: offsetLeft, top: offsetTop, width: elementWidth, height: elementHeight }
  }

  const box = containBox(naturalWidth, naturalHeight, elementWidth, elementHeight)

  return {
    left: offsetLeft + box.left,
    top: offsetTop + box.top,
    width: box.width,
    height: box.height,
  }
}
