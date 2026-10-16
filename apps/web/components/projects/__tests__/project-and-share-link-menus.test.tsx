import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProjectCard } from '../project-card'
import { ShareLinksTable } from '../share-links-table'
import type { Project, ShareLinkListItem } from '@/types'

// Projects and share links get the same menu on right-click as from ⋯.

const mockApi = vi.hoisted(() => ({ get: vi.fn(), delete: vi.fn(), patch: vi.fn(), post: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: mockApi }))

const mockCopy = vi.hoisted(() => vi.fn())
vi.mock('@/lib/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/utils')>()),
  copyToClipboard: mockCopy,
}))

const project: Project = {
  id: 'p1',
  name: 'Season 2',
  description: null,
  created_by: 'u1',
  project_type: 'personal',
  created_at: '2026-01-01T00:00:00Z',
  deleted_at: null,
}

const link: ShareLinkListItem = {
  id: 'l1',
  token: 'tok1',
  title: 'Client cut',
  description: null,
  is_enabled: true,
  permission: 'view',
  share_type: 'folder',
  target_name: 'Selects',
  view_count: 0,
  last_viewed_at: null,
  created_at: '2026-01-01T00:00:00Z',
}

const user = () => userEvent.setup({ pointerEventsCheck: 0 })

async function menuItems() {
  return (await screen.findAllByRole('menuitem')).map((i) => i.textContent)
}

beforeEach(() => {
  mockCopy.mockReset().mockResolvedValue(true)
})

describe('ProjectCard', () => {
  it('right-click shows the owner the same menu as ⋯', async () => {
    render(<ProjectCard project={project} isOwner />)
    fireEvent.contextMenu(screen.getByText('Season 2'))
    const items = await menuItems()
    expect(items).toEqual(['Project Settings', 'Delete'])
    await user().keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    await user().click(screen.getByRole('button', { name: 'Season 2 menu' }))
    expect(await menuItems()).toEqual(items)
  })

  it('gives everyone else the browser menu, as there is no ⋯ for them', () => {
    render(<ProjectCard project={{ ...project, role: 'editor' }} />)
    expect(fireEvent.contextMenu(screen.getByText('Season 2'))).toBe(true)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Season 2 menu' })).toBeNull()
  })
})

describe('ShareLinksTable', () => {
  function renderTable() {
    const onToggleEnabled = vi.fn()
    const onDelete = vi.fn()
    render(
      <ShareLinksTable
        shareLinks={[link]}
        onSelectLink={() => {}}
        onToggleEnabled={onToggleEnabled}
        onDelete={onDelete}
        onViewActivity={() => {}}
        frontendUrl="http://localhost:3000"
      />,
    )
    return { onToggleEnabled, onDelete }
  }

  it('right-click on a row shows the sidebar link menu', async () => {
    renderTable()
    fireEvent.contextMenu(screen.getByText('Client cut'))
    expect(await menuItems()).toEqual(['Open Share', 'Copy Link', 'Disable Access', 'Delete'])
  })

  it('copies with the helper that works over plain HTTP', async () => {
    renderTable()
    fireEvent.contextMenu(screen.getByText('Client cut'))
    await user().click(await screen.findByRole('menuitem', { name: 'Copy Link' }))
    expect(mockCopy).toHaveBeenCalledWith(expect.stringMatching(/\/share\/tok1$/))
  })

  it('disables and deletes the link', async () => {
    const h = renderTable()
    fireEvent.contextMenu(screen.getByText('Client cut'))
    await user().click(await screen.findByRole('menuitem', { name: 'Disable Access' }))
    expect(h.onToggleEnabled).toHaveBeenCalledWith('tok1', false)

    fireEvent.contextMenu(screen.getByText('Client cut'))
    await user().click(await screen.findByRole('menuitem', { name: 'Delete' }))
    expect(h.onDelete).toHaveBeenCalledWith('tok1')
  })
})
