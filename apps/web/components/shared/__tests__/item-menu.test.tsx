import { describe, it, expect, vi } from 'vitest'
import * as React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ContextMenuArea, DotsMenu, MenuAction, MenuSeparator } from '../item-menu'
import { Pencil, Trash2 } from 'lucide-react'

// One set of items, shown from a ⋯ button and on right-click. The folder tree's
// old hand-made menu could only be left by picking something; these must close
// on an outside click or Escape and do nothing.

function Items({ onRename, onDelete }: { onRename: () => void; onDelete: () => void }) {
  return (
    <>
      <MenuAction icon={Pencil} onSelect={onRename}>Rename</MenuAction>
      <MenuSeparator />
      <MenuAction icon={Trash2} onSelect={onDelete} danger>Delete</MenuAction>
    </>
  )
}

function renderBoth() {
  const onRename = vi.fn()
  const onDelete = vi.fn()
  const items = <Items onRename={onRename} onDelete={onDelete} />
  render(
    <div>
      <ContextMenuArea items={items}>
        <div>Selects</div>
      </ContextMenuArea>
      <DotsMenu items={items}>
        <button>More</button>
      </DotsMenu>
      <p>Elsewhere</p>
    </div>,
  )
  return { onRename, onDelete }
}

const user = () => userEvent.setup({ pointerEventsCheck: 0 })

describe('ContextMenuArea', () => {
  it('opens the items on right-click', async () => {
    renderBoth()
    fireEvent.contextMenu(screen.getByText('Selects'))
    expect(await screen.findByRole('menuitem', { name: 'Rename' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeTruthy()
  })

  it('closes on an outside click without doing anything', async () => {
    const { onRename, onDelete } = renderBoth()
    fireEvent.contextMenu(screen.getByText('Selects'))
    await screen.findByRole('menu')

    fireEvent.pointerDown(screen.getByText('Elsewhere'))

    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(onRename).not.toHaveBeenCalled()
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('closes on Escape without doing anything', async () => {
    const { onRename, onDelete } = renderBoth()
    fireEvent.contextMenu(screen.getByText('Selects'))
    await screen.findByRole('menu')

    await user().keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(onRename).not.toHaveBeenCalled()
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('runs the item picked', async () => {
    const { onRename } = renderBoth()
    fireEvent.contextMenu(screen.getByText('Selects'))
    await user().click(await screen.findByRole('menuitem', { name: 'Rename' }))
    expect(onRename).toHaveBeenCalledOnce()
  })

  it('leaves the browser its own menu when there are no items or it is disabled', () => {
    render(
      <>
        <ContextMenuArea items={null}><div>No menu</div></ContextMenuArea>
        <ContextMenuArea items={<span />} disabled><div>Renaming</div></ContextMenuArea>
      </>,
    )
    // Not prevented: the native menu would open.
    expect(fireEvent.contextMenu(screen.getByText('No menu'))).toBe(true)
    expect(fireEvent.contextMenu(screen.getByText('Renaming'))).toBe(true)
    expect(screen.queryByRole('menu')).toBeNull()
  })
})

describe('DotsMenu', () => {
  it('shows the same items as right-click', async () => {
    renderBoth()
    await user().click(screen.getByRole('button', { name: 'More' }))
    const fromDots = (await screen.findAllByRole('menuitem')).map((i) => i.textContent)
    await user().keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    fireEvent.contextMenu(screen.getByText('Selects'))
    const fromRightClick = (await screen.findAllByRole('menuitem')).map((i) => i.textContent)

    expect(fromRightClick).toEqual(fromDots)
    expect(fromDots).toEqual(['Rename', 'Delete'])
  })
})

describe('a pick that opens a dialog', () => {
  // Rename from a menu once left every control dead until a reload: the dialog
  // opened while the menu still held <body> at pointer-events: none, saved that
  // as the value to restore, and put it back on close. A pick now runs only
  // once the menu has let go of the page.
  function recordState() {
    return {
      pointerEvents: document.body.style.pointerEvents,
      menuOpen: !!document.querySelector('[role="menu"]'),
    }
  }

  it.each(['right-click', 'dots'] as const)('runs after the menu has released the page (%s)', async (via) => {
    const seen: ReturnType<typeof recordState>[] = []
    const items = <MenuAction icon={Pencil} onSelect={() => seen.push(recordState())}>Rename</MenuAction>
    render(
      <>
        <ContextMenuArea items={items}><div>Selects</div></ContextMenuArea>
        <DotsMenu items={items}><button>More</button></DotsMenu>
      </>,
    )
    if (via === 'right-click') fireEvent.contextMenu(screen.getByText('Selects'))
    else await user().click(screen.getByRole('button', { name: 'More' }))
    expect(document.body.style.pointerEvents).toBe('none')

    await user().click(await screen.findByRole('menuitem', { name: 'Rename' }))

    await waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]).toEqual({ pointerEvents: '', menuOpen: false })
  })

  it('an immediate pick runs inside the click, for what needs it (a new tab, the clipboard)', async () => {
    const seen: ReturnType<typeof recordState>[] = []
    render(
      <ContextMenuArea
        items={<MenuAction icon={Pencil} immediate onSelect={() => seen.push(recordState())}>Copy</MenuAction>}
      >
        <div>Selects</div>
      </ContextMenuArea>,
    )
    fireEvent.contextMenu(screen.getByText('Selects'))
    await user().click(await screen.findByRole('menuitem', { name: 'Copy' }))
    expect(seen).toHaveLength(1)
    expect(seen[0].menuOpen).toBe(true)
  })
})
