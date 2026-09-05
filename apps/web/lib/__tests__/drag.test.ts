/**
 * Telling an OS file drag from an asset being moved between folders.
 *
 * This one predicate is what keeps the new upload target from firing when
 * someone drags a card across the grid, and what keeps folder targets from
 * lighting up for a file that is not meant for them.
 */
import { describe, expect, it } from 'vitest'

import { carriesFiles } from '../drag'

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
