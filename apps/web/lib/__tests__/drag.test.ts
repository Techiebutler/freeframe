/**
 * Telling an OS file drag from an asset being moved between folders.
 *
 * This one predicate is what keeps the new upload target from firing when
 * someone drags a card across the grid, and what keeps folder targets from
 * lighting up for a file that is not meant for them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { carriesFiles, refuseFileDrag } from '../drag'

function drag(types: string[]): React.DragEvent {
  return { dataTransfer: { types } } as unknown as React.DragEvent
}

describe('carriesFiles', () => {
  it('recognises a drag coming from the operating system', () => {
    // What a browser reports for a file dragged in from Finder or Explorer.
    expect(carriesFiles(drag(['Files']))).toBe(true)
    expect(carriesFiles(drag(['Files', 'application/x-moz-file']))).toBe(true)
  })

  it('does not recognise an asset being dragged between folders', () => {
    // What asset-grid.tsx sets on dragstart. Treating this as a file drop is
    // the failure the predicate exists for: an upload starting because someone
    // moved a card.
    expect(carriesFiles(drag(['application/json']))).toBe(false)
  })

  it('does not recognise a plain text or link drag', () => {
    expect(carriesFiles(drag(['text/plain']))).toBe(false)
    expect(carriesFiles(drag(['text/uri-list', 'text/plain']))).toBe(false)
  })

  it('is false rather than throwing when a drag carries nothing', () => {
    expect(carriesFiles(drag([]))).toBe(false)
  })

  it('works on a DOMStringList, not only on an array', () => {
    // `types` is a plain array in every browser that matters now, but the spec
    // allowed a DOMStringList and jsdom is not the only consumer -- Array.from
    // covers both, and this is what stops that being quietly refactored away.
    const listLike = {
      length: 1,
      0: 'Files',
      [Symbol.iterator]: function* () { yield 'Files' },
    }
    expect(carriesFiles({ dataTransfer: { types: listLike } } as never)).toBe(true)
  })
})

describe('a drag that started on this page', () => {
  // Chrome and Safari list `Files` for an <img> dragged out of the page itself
  // (a thumbnail, the logo), so `types` alone would start an upload of the
  // page's own image when it is let go over the asset area.
  afterEach(() => {
    window.dispatchEvent(new Event('dragend'))
  })

  function pageImage() {
    const img = document.createElement('img')
    document.body.appendChild(img)
    img.dispatchEvent(new Event('dragstart', { bubbles: true }))
    return img
  }

  it('is not a file drag, even when it lists Files', () => {
    const img = pageImage()

    expect(carriesFiles(drag(['Files', 'text/uri-list', 'text/html']))).toBe(false)
    img.remove()
  })

  it('stops counting once the drag ends', () => {
    const img = pageImage()
    img.dispatchEvent(new Event('dragend', { bubbles: true }))

    expect(carriesFiles(drag(['Files']))).toBe(true)
    img.remove()
  })

  it('stops counting at the next press when the source left the page before its dragend', () => {
    // A dragend fired at a node no longer in the document reaches nothing
    // else, and a flag left standing would refuse every later file drop.
    const img = pageImage()
    img.remove()

    window.dispatchEvent(new Event('pointerdown'))

    expect(carriesFiles(drag(['Files']))).toBe(true)
  })

  it('is still refused by the shell, so the browser does not open the image', () => {
    const img = pageImage()
    const dataTransfer = { types: ['Files'], dropEffect: 'copy' }
    const e = { dataTransfer, preventDefault: vi.fn() } as unknown as React.DragEvent

    refuseFileDrag(e)

    expect(e.preventDefault).toHaveBeenCalled()
    expect(dataTransfer.dropEffect).toBe('none')
    img.remove()
  })
})
