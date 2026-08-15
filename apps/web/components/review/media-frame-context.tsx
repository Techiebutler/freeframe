'use client'

import * as React from 'react'

/**
 * Marks a surface whose annotations used to be authored against the whole
 * letterboxed container rather than the media inside it.
 *
 * Image annotations were historically drawn and replayed against the container,
 * so a mark saved in a 520x870 pane carries coordinates in that pane's space,
 * with the picture occupying only a band inside it. Replaying those numbers
 * directly against the picture box would misplace them.
 *
 * Knowing the media's intrinsic size is enough to undo it: the picture box
 * inside the authoring container is just the contain fit of that size into the
 * stored `_canvasWidth`/`_canvasHeight`, which lets the mark be expressed
 * relative to the picture and replayed correctly at any size.
 *
 * `null` means "this surface always authored in media space" — true of
 * `VideoFrameConstraint`, which predates the change, so its unmarked data is
 * already correct and must be left alone.
 */
export interface LegacyAnnotationFrame {
  /** Intrinsic media size, once known. Both 0 before the media has loaded. */
  naturalWidth: number
  naturalHeight: number
}

export const MediaFrameContext = React.createContext<LegacyAnnotationFrame | null>(null)

/**
 * Marker written into new annotation JSON so it is self-describing rather than
 * guessed at. Absence means the data predates the frame fix.
 */
export const MEDIA_FRAME_SPACE = 'media'
