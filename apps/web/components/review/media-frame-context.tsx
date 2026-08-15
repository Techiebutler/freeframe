'use client'

import * as React from 'react'

/**
 * Describes the box that annotations used to be authored against, for surfaces
 * where that box changed.
 *
 * Image annotations were historically drawn and replayed against the whole
 * letterboxed CONTAINER; they now use the picture box. Data saved before that
 * change carries container dimensions in `_canvasWidth`/`_canvasHeight`, so
 * replaying it against the picture box shifts and squashes it. `AnnotationOverlay`
 * uses this to put such data back exactly where it used to render.
 *
 * `null` means "this surface always authored in media space" — which is true of
 * `VideoFrameConstraint`, since it predates the change. Unmarked data there is
 * already correct and must not be shifted.
 */
export interface LegacyAnnotationFrame {
  /** The container box, i.e. what old `_canvasWidth`/`_canvasHeight` measured. */
  containerWidth: number
  containerHeight: number
  /** Where the media box sits inside that container. */
  left: number
  top: number
}

export const MediaFrameContext = React.createContext<LegacyAnnotationFrame | null>(null)

/**
 * Marker written into new annotation JSON so it is self-describing rather than
 * guessed at. Absence means the data predates the frame fix.
 */
export const MEDIA_FRAME_SPACE = 'media'
