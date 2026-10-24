import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import * as React from 'react'
import { createPortal } from 'react-dom'
import { render, screen, fireEvent, createEvent, act } from '@testing-library/react'

import { useFileDropRegion } from '../use-file-drop-region'
import type { Collected } from '@/lib/upload-folder-walk'
import { folderDrop, droppedPaths } from '@/test/folder-drop'

const file = new File(['x'], 'cut-v3.mov', { type: 'video/quicktime' })

/** What a browser hands a file drag. `types` is the readable part during
 *  dragover; `files` only fills in on drop. */
function fileDrag(files: File[] = [file]) {
  return { types: ['Files'], files, dropEffect: 'none' }
}

/**
 * The project page in miniature: a shell that refuses whatever nothing took, a
 * region inside it, a grid inside that, and -- the case this exists for -- a
 * dialog written inside the region but portalled to `document.body`, which is
 * how every folder card renders its rename and delete confirmations.
 */
function Region({
  enabled = true,
  currentFolderId = null,
  onUploadFiles = vi.fn(),
  onShell = vi.fn(),
  dialogOpen = false,
}: {
  enabled?: boolean
  currentFolderId?: string | null
  onUploadFiles?: (folderId: string | null, dropped: Promise<Collected>) => void
  onShell?: (e: React.DragEvent) => void
  dialogOpen?: boolean
}) {
  const {
    regionRef,
    regionProps,
    showRegionFrame,
    fileDragTarget,
    setFolderTarget,
  } = useFileDropRegion({ enabled, currentFolderId, onUploadFiles })

  return (
    <div data-testid="shell" onDragOver={onShell} onDrop={onShell}>
      <div ref={regionRef} data-testid="region" {...regionProps}>
        <div data-testid="grid">the asset grid</div>
        {dialogOpen &&
          createPortal(
            <div data-testid="overlay">Delete &quot;Cuts&quot;?</div>,
            document.body,
          )}
      </div>
      {showRegionFrame && <div data-testid="frame">Drop to upload</div>}
      <div data-testid="target">{fileDragTarget ?? '-'}</div>
      <button onClick={() => setFolderTarget('episodes')}>claim episodes</button>
      <button onClick={() => setFolderTarget(null, 'cuts')}>release as cuts</button>
      <button onClick={() => setFolderTarget(null, 'episodes')}>
        release as episodes
      </button>
    </div>
  )
}

/**
 * Drop on `el` with the pointer at (x, y).
 *
 * jsdom has no `DragEvent`, so testing-library builds a plain `Event` and the
 * coordinates a real drop carries are dropped with it. The release check reads
 * them, so they are put back by hand.
 */
function dropAt(el: Element, x: number, y: number, dataTransfer: object = fileDrag()) {
  const event = createEvent.drop(el, { dataTransfer })
  Object.defineProperty(event, 'clientX', { value: x })
  Object.defineProperty(event, 'clientY', { value: y })
  return fireEvent(el, event)
}

/** jsdom measures everything as zero, so the release check needs a real box. */
function sizeRegion(left = 0, top = 0, right = 800, bottom = 600) {
  const el = screen.getByTestId('region')
  el.getBoundingClientRect = () =>
    ({ left, top, right, bottom, width: right - left, height: bottom - top,
       x: left, y: top, toJSON: () => ({}) }) as DOMRect
  return el
}

describe('a dialog rendered inside the region', () => {
  // Radix renders a dialog into `document.body` and keeps its place in the
  // React tree, so its events bubble to the region as if they had happened on
  // the grid. The overlay is `fixed inset-0` and centred, so checking the
  // release point against the region's rectangle agrees with the lie.
  it('is not the region’s drag to take', () => {
    render(<Region dialogOpen />)
    sizeRegion()

    // false would mean the region prevented the default, i.e. claimed it.
    expect(
      fireEvent.dragOver(screen.getByTestId('overlay'), { dataTransfer: fileDrag() }),
    ).toBe(true)
    expect(screen.queryByTestId('frame')).toBeNull()
  })

  it('does not upload the file dropped on it', () => {
    // The one that matters: as an owner, open a folder card's menu, choose
    // Delete, drag a .mov over "Delete \"Cuts\"?" and let go. This used to
    // start an upload while the user was being asked whether to delete a
    // folder.
    const onUploadFiles = vi.fn()
    render(<Region dialogOpen onUploadFiles={onUploadFiles} />)
    sizeRegion()

    dropAt(screen.getByTestId('overlay'), 400, 300)

    expect(onUploadFiles).not.toHaveBeenCalled()
  })

  it('leaves it for the shell to refuse', () => {
    // Refused rather than merely ignored: an unclaimed file drop is handled by
    // the browser, which navigates the tab to `file:///...`.
    const onShell = vi.fn()
    render(<Region dialogOpen onShell={onShell} />)
    sizeRegion()

    // Released inside the region's own rectangle, which is where a centred
    // dialog sits: without the containment check the region takes this one and
    // stops it, and the shell never hears about it.
    dropAt(screen.getByTestId('overlay'), 400, 300)

    expect(onShell).toHaveBeenCalled()
  })
})

describe('a file dragged over the region itself', () => {
  it('is taken, and kept from the shell', () => {
    const onShell = vi.fn()
    render(<Region onShell={onShell} />)
    sizeRegion()

    fireEvent.dragEnter(screen.getByTestId('grid'), { dataTransfer: fileDrag() })
    expect(
      fireEvent.dragOver(screen.getByTestId('grid'), { dataTransfer: fileDrag() }),
    ).toBe(false)

    expect(screen.getByTestId('frame')).toBeTruthy()
    expect(onShell).not.toHaveBeenCalled()
  })

  it('uploads into the folder the region is showing', async () => {
    const onUploadFiles = vi.fn()
    render(<Region currentFolderId="episodes" onUploadFiles={onUploadFiles} />)
    sizeRegion()

    dropAt(screen.getByTestId('grid'), 400, 300)

    expect(onUploadFiles).toHaveBeenCalledWith('episodes', expect.any(Promise))
    await expect(onUploadFiles.mock.calls[0][1]).resolves.toEqual({
      files: [{ file, dirs: [] }],
      unreadable: 0,
      unreadableFolders: 0,
    })
  })

  it('reads a dropped folder during the drop event, not after it', async () => {
    // The items of a drop answer only in the event's own turn. Reading them
    // later, as `e.dataTransfer.files` was, gets the folder's unreadable
    // placeholder: queued as a file, it failed with "The file changed or was
    // moved after it was added".
    const onUploadFiles = vi.fn()
    render(<Region onUploadFiles={onUploadFiles} />)
    sizeRegion()
    const drop = folderDrop('Shoot', ['a.mov', 'b.mov'])

    dropAt(screen.getByTestId('grid'), 400, 300, drop.dataTransfer)
    drop.expire()

    expect(drop.webkitGetAsEntry).toHaveBeenCalled()
    const collected = await onUploadFiles.mock.calls[0][1]
    expect(droppedPaths(collected)).toEqual(['Shoot/a.mov', 'Shoot/b.mov'])
  })

  it('uploads nothing when the button comes up outside it', () => {
    // A drag can end on a target that is no longer under the pointer, so
    // reaching this handler is not proof the release happened here.
    const onUploadFiles = vi.fn()
    render(<Region onUploadFiles={onUploadFiles} />)
    sizeRegion()

    dropAt(screen.getByTestId('grid'), 900, 900)

    expect(onUploadFiles).not.toHaveBeenCalled()
  })

  it('is refused where the region cannot receive an upload', () => {
    // A reviewer, or the trash and share-link lists. Prevented all the same:
    // the shell answers for it, and `none` is what says so to the pointer.
    const onShell = vi.fn()
    const onUploadFiles = vi.fn()
    render(<Region enabled={false} onShell={onShell} onUploadFiles={onUploadFiles} />)
    sizeRegion()

    dropAt(screen.getByTestId('grid'), 400, 300)

    expect(onUploadFiles).not.toHaveBeenCalled()
    expect(onShell).toHaveBeenCalled()
    expect(screen.queryByTestId('frame')).toBeNull()
  })

  it('leaves an item drag to the grid', () => {
    // Dragging an asset card across the region must not look like an upload.
    const onUploadFiles = vi.fn()
    render(<Region onUploadFiles={onUploadFiles} />)
    sizeRegion()

    fireEvent.dragOver(screen.getByTestId('grid'), {
      dataTransfer: { types: ['application/json'], files: [], dropEffect: 'none' },
    })

    expect(screen.queryByTestId('frame')).toBeNull()
    expect(onUploadFiles).not.toHaveBeenCalled()
  })
})

describe('handing the marking from one folder to the next', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('lets only the folder still holding it give it back', () => {
    // Crossing from one folder to the next raises the new folder's dragenter
    // BEFORE the old folder's dragleave, so the release arriving last belongs
    // to the folder already left behind. Acting on it took the marking off the
    // folder under the pointer and put the whole-area frame back up beside it.
    render(<Region />)

    fireEvent.click(screen.getByText('claim episodes'))
    fireEvent.click(screen.getByText('release as cuts'))
    act(() => void vi.advanceTimersByTime(200))

    expect(screen.getByTestId('target').textContent).toBe('episodes')
  })

  it('releases when the holder is the one letting go', () => {
    render(<Region />)

    fireEvent.click(screen.getByText('claim episodes'))
    fireEvent.click(screen.getByText('release as episodes'))
    act(() => void vi.advanceTimersByTime(200))

    expect(screen.getByTestId('target').textContent).toBe('-')
  })

  it('keeps the whole-area frame down while a folder holds it', () => {
    // Two frames at once do not say where the file will land.
    render(<Region />)
    sizeRegion()

    fireEvent.dragEnter(screen.getByTestId('grid'), { dataTransfer: fileDrag() })
    expect(screen.getByTestId('frame')).toBeTruthy()

    fireEvent.click(screen.getByText('claim episodes'))
    expect(screen.queryByTestId('frame')).toBeNull()
  })
})
