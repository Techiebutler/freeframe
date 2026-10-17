import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FolderTree } from '../folder-tree'
import type { FolderTreeNode } from '@/types'

// The tree's right-click menu used to be a plain div with no way to dismiss
// it: the only way out was to pick an item. It is now the shared folder menu.

const tree: FolderTreeNode[] = [
  { id: 'episodes', name: 'Episodes', parent_id: null, item_count: 2, children: [] },
]

function renderTree(props: Record<string, unknown> = {}) {
  const handlers = {
    onSelectFolder: vi.fn(),
    onCreateFolder: vi.fn(async () => {}),
    onRenameFolder: vi.fn(async () => {}),
    onDeleteFolder: vi.fn(async () => {}),
    onShareFolder: vi.fn(),
  }
  render(
    <FolderTree
      tree={tree}
      projectName="Season 2"
      currentFolderId={null}
      showTrash={false}
      onShowTrash={() => {}}
      {...handlers}
      {...props}
    />,
  )
  return handlers
}

const user = () => userEvent.setup({ pointerEventsCheck: 0 })

describe('folder tree menu', () => {
  it('closes on an outside click, and nothing happens', async () => {
    const h = renderTree()
    fireEvent.contextMenu(screen.getByText('Episodes'))
    await screen.findByRole('menu')

    fireEvent.pointerDown(screen.getByText('Recently Deleted'))

    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(h.onRenameFolder).not.toHaveBeenCalled()
    expect(h.onDeleteFolder).not.toHaveBeenCalled()
    expect(h.onCreateFolder).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('closes on Escape', async () => {
    renderTree()
    fireEvent.contextMenu(screen.getByText('Episodes'))
    await screen.findByRole('menu')
    await user().keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  })

  it('offers the folder menu used everywhere else, from right-click and from ⋯', async () => {
    renderTree()
    fireEvent.contextMenu(screen.getByText('Episodes'))
    const items = (await screen.findAllByRole('menuitem')).map((i) => i.textContent)
    expect(items).toEqual(['Create Share Link', 'New Subfolder', 'Rename', 'Delete'])
    await user().keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    await user().click(screen.getByRole('button', { name: 'Episodes menu' }))
    expect((await screen.findAllByRole('menuitem')).map((i) => i.textContent)).toEqual(items)
  })

  it('opening either menu does not select the folder', async () => {
    const h = renderTree()
    fireEvent.contextMenu(screen.getByText('Episodes'))
    await screen.findByRole('menu')
    await user().keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    await user().click(screen.getByRole('button', { name: 'Episodes menu' }))
    await screen.findByRole('menu')
    expect(h.onSelectFolder).not.toHaveBeenCalled()
  })

  it('Rename starts the inline rename, where the browser keeps its own menu', async () => {
    renderTree()
    fireEvent.contextMenu(screen.getByText('Episodes'))
    await user().click(await screen.findByRole('menuitem', { name: 'Rename' }))

    const input = await screen.findByRole('textbox')
    expect((input as HTMLInputElement).value).toBe('Episodes')
    // The menu closing must not take focus back, or blur ends the rename.
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(document.activeElement).toBe(input)
    expect(screen.getByRole('textbox')).toBe(input)
    // Not prevented: right-click in the field gets cut/copy/paste.
    expect(fireEvent.contextMenu(input)).toBe(true)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('Create Share Link and New Subfolder act on the folder', async () => {
    const h = renderTree()
    fireEvent.contextMenu(screen.getByText('Episodes'))
    await user().click(await screen.findByRole('menuitem', { name: 'Create Share Link' }))
    expect(h.onShareFolder).toHaveBeenCalledWith('episodes', 'Episodes')

    fireEvent.contextMenu(screen.getByText('Episodes'))
    await user().click(await screen.findByRole('menuitem', { name: 'New Subfolder' }))
    expect(h.onCreateFolder).toHaveBeenCalledWith('', 'episodes')
  })

  it('leaves New Subfolder out when the role cannot create folders', async () => {
    renderTree({ onCreateFolder: undefined })
    fireEvent.contextMenu(screen.getByText('Episodes'))
    const items = (await screen.findAllByRole('menuitem')).map((i) => i.textContent)
    expect(items).toEqual(['Create Share Link', 'Rename', 'Delete'])
  })

  it('cancelling Delete gives focus back to the ⋯ button', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const h = renderTree()
    const trigger = screen.getByRole('button', { name: 'Episodes menu' })
    trigger.focus()
    const u = user()
    await u.keyboard('{Enter}')
    await screen.findByRole('menu')
    await waitFor(() => expect(document.activeElement?.getAttribute('role')).toBe('menuitem'))
    await u.keyboard('{End}{Enter}')

    await waitFor(() => expect(confirm).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(h.onDeleteFolder).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(trigger)
    confirm.mockRestore()
  })

  it('leaves Share out when sharing is not allowed', async () => {
    renderTree({ onShareFolder: undefined })
    fireEvent.contextMenu(screen.getByText('Episodes'))
    const items = (await screen.findAllByRole('menuitem')).map((i) => i.textContent)
    expect(items).not.toContain('Create Share Link')
  })
})
