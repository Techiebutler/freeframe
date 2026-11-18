/**
 * Moving an asset by dragging its thumbnail onto a folder.
 *
 * Chrome and Safari list `Files` in the types of an image dragged out of the
 * page, so a card dragged by its thumbnail looks like a file drag to the
 * dashboard shell's refusal (refuseFileDrag), which sets `none`. A folder that
 * took the move had to keep the event from reaching the shell, or the drop
 * never fired and the asset did not move.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('swr', () => ({ default: () => ({ data: [] }) }))

import { FolderCard } from '../folder-card'
import { FolderTree } from '../folder-tree'
import { refuseFileDrag } from '@/lib/drag'
import type { Folder, FolderTreeNode } from '@/types'

const tree: FolderTreeNode[] = [{ id: 'cuts', name: 'Cuts', parent_id: null, item_count: 0, children: [] }] as unknown as FolderTreeNode[]
const noop = async () => {}
const folder = { id: 'cuts', name: 'Cuts', project_id: 'p1', parent_id: null, item_count: 0 } as unknown as Folder

/** A card dragged by its thumbnail: the move payload, plus the `Files` the browser adds for an image. */
function thumbnailDrag() {
  const payload = JSON.stringify({ assetIds: ['a1'], folderIds: [] })
  return {
    types: ['application/json', 'Files'],
    files: [],
    dropEffect: 'move',
    effectAllowed: 'move',
    getData: (t: string) => (t === 'application/json' ? payload : ''),
  }
}

/** The dashboard shell around the target, refusing file drags nothing took. */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div onDragOver={refuseFileDrag} onDrop={refuseFileDrag}>
      {children}
    </div>
  )
}

describe('dragging an asset by its thumbnail onto a folder', () => {
  it('moves it into a folder card, and the shell does not refuse it', () => {
    const onDropItems = vi.fn()
    render(
      <Shell>
        <FolderCard folder={folder} onOpen={() => {}} onDropItems={onDropItems} onDropFiles={vi.fn()} />
      </Shell>,
    )
    window.dispatchEvent(new Event('dragstart'))
    const dt = thumbnailDrag()

    fireEvent.dragOver(screen.getByText('Cuts'), { dataTransfer: dt })
    expect(dt.dropEffect).toBe('move')
    fireEvent.drop(screen.getByText('Cuts'), { dataTransfer: dt })
    window.dispatchEvent(new Event('dragend'))

    expect(onDropItems).toHaveBeenCalledWith('cuts', ['a1'], [])
  })

  it('moves it into a sidebar folder row, and the shell does not refuse it', () => {
    const onDropItems = vi.fn()
    render(
      <Shell>
        <FolderTree
          tree={tree}
          projectName="Season 2"
          currentFolderId={null}
          showTrash={false}
          onSelectFolder={() => {}}
          onShowTrash={() => {}}
          onRenameFolder={noop}
          onDeleteFolder={noop}
          onDropItems={onDropItems}
          onDropFiles={vi.fn()}
        />
      </Shell>,
    )
    window.dispatchEvent(new Event('dragstart'))
    const dt = thumbnailDrag()

    fireEvent.dragOver(screen.getByText('Cuts'), { dataTransfer: dt })
    expect(dt.dropEffect).toBe('move')
    fireEvent.drop(screen.getByText('Cuts'), { dataTransfer: dt })
    window.dispatchEvent(new Event('dragend'))

    expect(onDropItems).toHaveBeenCalledWith('cuts', ['a1'], [])
  })
})
