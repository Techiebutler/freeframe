/**
 * Dropping files, or a folder, on a folder card in the grid.
 *
 * A drop's items answer only during the drop event's own turn, so the card has
 * to read them in its drop handler. Reading `dataTransfer.files` instead got a
 * dropped folder's placeholder, which was queued as a file and failed with
 * "The file changed or was moved after it was added".
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('swr', () => ({ default: () => ({ data: [] }) }))

import { FolderCard } from '../folder-card'
import type { Folder } from '@/types'
import type { Collected } from '@/lib/upload-folder-walk'
import { folderDrop, droppedPaths } from '@/test/folder-drop'

const folder = { id: 'cuts', name: 'Cuts', project_id: 'p1', parent_id: null, item_count: 0 } as unknown as Folder

describe('a file drop on a folder card', () => {
  it('reads a dropped folder during the drop event and hands it on for this folder', async () => {
    const onDropFiles = vi.fn()
    render(<FolderCard folder={folder} onOpen={() => {}} onDropFiles={onDropFiles} />)
    const drop = folderDrop('Shoot', ['a.mov', 'b.wav'])

    fireEvent.drop(screen.getByText('Cuts'), { dataTransfer: drop.dataTransfer })
    drop.expire()

    expect(drop.webkitGetAsEntry).toHaveBeenCalled()
    expect(onDropFiles).toHaveBeenCalledWith('cuts', expect.any(Promise))
    const collected: Collected = await onDropFiles.mock.calls[0][1]
    expect(droppedPaths(collected)).toEqual(['Shoot/a.mov', 'Shoot/b.wav'])
    // Never the folder's own placeholder.
    expect(collected.files.map((f) => f.file)).not.toContain(drop.placeholder)
  })

  it('hands on loose files as they are', async () => {
    const onDropFiles = vi.fn()
    render(<FolderCard folder={folder} onOpen={() => {}} onDropFiles={onDropFiles} />)
    const file = new File(['x'], 'a.mov', { type: 'video/quicktime' })

    fireEvent.drop(screen.getByText('Cuts'), { dataTransfer: { types: ['Files'], files: [file], dropEffect: 'none' } })

    const collected: Collected = await onDropFiles.mock.calls[0][1]
    expect(collected.files).toEqual([{ file, dirs: [] }])
  })
})
