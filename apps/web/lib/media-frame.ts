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

  // Compare aspect ratios by cross-multiplying rather than dividing, so exact
  // fits (a 16:9 image in a 16:9 box) stay exact instead of drifting a
  // fraction of a pixel through an intermediate ratio.
  const imageIsWider = naturalWidth * elementHeight > naturalHeight * elementWidth

  const width = imageIsWider ? elementWidth : (elementHeight * naturalWidth) / naturalHeight
  const height = imageIsWider ? (elementWidth * naturalHeight) / naturalWidth : elementHeight

  return {
    left: offsetLeft + (elementWidth - width) / 2,
    top: offsetTop + (elementHeight - height) / 2,
    width,
    height,
  }
}
