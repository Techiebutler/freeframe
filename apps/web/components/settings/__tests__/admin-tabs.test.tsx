import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render as rtlRender, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { SWRConfig } from 'swr'

const get = vi.fn()
const del = vi.fn()
vi.mock('@/lib/api', () => ({
  api: {
    get: (...a: unknown[]) => get(...a),
    delete: (...a: unknown[]) => del(...a),
    post: vi.fn(),
  },
}))

import { AdminProjectsTab, AdminInternalTab, AdminExternalTab } from '../admin-tabs'
import { useAdminViewStore, ADMIN_VIEW_DEFAULTS } from '@/stores/admin-view-store'
import { EXTERNAL, INTERNAL, PROJECTS } from './admin-fixtures'

/**
 * The three reading tabs: what projects exist, who inside can reach them, and
 * what is reachable from outside.
 *
 * The layout switch is the projects page's own `Segment`, not a second one, so
 * these cases check the shipped default per tab and that a choice is remembered.
 */

function render(ui: React.ReactElement) {
  return rtlRender(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{ui}</SWRConfig>,
  )
}

beforeEach(() => {
  get.mockReset()
  del.mockReset()
  // The layout choice is persisted on purpose, so each test starts from the
  // tab's shipped default rather than from the previous test's click.
  useAdminViewStore.setState({ layouts: { ...ADMIN_VIEW_DEFAULTS } })
})

const layout = (name: 'Grid' | 'List') => screen.getByRole('button', { name })

// ── Projects ──────────────────────────────────────────────────────────────────

describe('the Projects tab', () => {
  it('opens as cards, like the projects page, carrying the same facts as a row', async () => {
    get.mockResolvedValue(PROJECTS)
    render(<AdminProjectsTab />)
    const card = (await screen.findByText('Archive 2024')).closest('article')!
    // Cards, not rows: no table at all in this view.
    expect(document.querySelector('table')).toBeNull()
    expect(within(screen.getByRole('group', { name: 'Layout' })).getByRole('button', {
      name: 'Grid',
    })).toHaveAttribute('aria-pressed', 'true')
    expect(within(card).getByText('2 GB')).toBeInTheDocument()
    expect(within(card).getByText('1 member')).toBeInTheDocument()
    expect(within(card).getByText('never')).toBeInTheDocument()
    expect(within(card).getByRole('link', { name: 'Edit' })).toHaveAttribute(
      'href',
      '/projects/p-2',
    )
    // The real poster where there is one, so a card looks like the project does.
    expect((screen.getByAltText(PROJECTS[0].name) as HTMLImageElement).src).toBe(
      'https://example.invalid/poster.jpg',
    )
  })

  it('switches to the list, remembers it, and reads this tab', async () => {
    get.mockResolvedValue(PROJECTS)
    render(<AdminProjectsTab />)
    await screen.findByText('Archive 2024')
    fireEvent.click(layout('List'))
    const row = (await screen.findByText('Sportbrand Campaign Autumn Winter Launch Film Director Cut'))
      .closest('tr')!
    expect(within(row).getByText('5')).toBeInTheDocument()
    expect(within(row).getByText('250 GB')).toBeInTheDocument()
    expect(within(row).getByText(/1 hour ago/)).toBeInTheDocument()
    expect(within(row).getByRole('link', { name: 'Edit' })).toHaveAttribute('href', '/projects/p-1')
    // "never" rather than an empty cell, which could mean either.
    expect(
      within((await screen.findByText('Archive 2024')).closest('tr')!).getByText('never'),
    ).toBeInTheDocument()

    // Four columns plus the edit link, and no checkboxes: this tab reads.
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    expect(document.querySelectorAll('colgroup col')).toHaveLength(5)
    expect(useAdminViewStore.getState().layouts.projects).toBe('list')
  })

  it('shows the error rather than an empty state', async () => {
    get.mockRejectedValue(new Error('Admin access required'))
    render(<AdminProjectsTab />)
    expect(await screen.findByText('Admin access required')).toBeInTheDocument()
    expect(screen.queryByText(/No projects/)).not.toBeInTheDocument()
  })
})

// ── Internal sharing ──────────────────────────────────────────────────────────

describe('the Internal shared tab', () => {
  beforeEach(() => get.mockResolvedValue(INTERNAL))

  it('groups people under their project with their role, one Edit per project, in either layout', async () => {
    render(<AdminInternalTab />)
    const block = (await screen.findByText('Sportbrand Campaign')).closest('article')!
    expect(within(within(block).getByText('Olive Owner').closest('li')!).getByText('owner'))
      .toBeInTheDocument()
    expect(within(within(block).getByText('Sam Editor').closest('li')!).getByText('editor'))
      .toBeInTheDocument()
    expect(within(block).getByText('2 people')).toBeInTheDocument()

    // One link per project, not one per person, pointing at the settings page
    // that actually writes the role.
    const links = within(block).getAllByRole('link', { name: 'Edit' })
    expect(links).toHaveLength(1)
    expect(links[0]).toHaveAttribute('href', '/projects/p-1')
    fireEvent.click(layout('Grid'))
    const grid = (await screen.findByText('Sportbrand Campaign')).closest('article')!
    expect(within(grid).getByText('Olive Owner')).toBeInTheDocument()
    expect(within(grid).getByText('owner')).toBeInTheDocument()
    expect(useAdminViewStore.getState().layouts.internal).toBe('grid')
  })

  it('keeps a project whose people were all deleted, and says what is wrong', async () => {
    // It used to vanish from this tab while staying in Projects and Storage,
    // which is the worst of both: visible enough to worry about, invisible
    // where it could be repaired.
    render(<AdminInternalTab />)
    const block = (await screen.findByText('Orphaned Project')).closest('article')!
    expect(within(block).getByText(/Nobody can reach this project any more/)).toBeInTheDocument()
    expect(within(block).getByRole('link', { name: 'Edit' })).toBeInTheDocument()
  })
})

// ── External sharing ──────────────────────────────────────────────────────────

describe('the External shared tab', () => {
  beforeEach(() => get.mockResolvedValue(EXTERNAL))

  it('names what is shared, the rights, the expiry and who made it', async () => {
    render(<AdminExternalTab />)
    const row = (await screen.findByText(/Hero 4K Master/)).closest('tr')!
    expect(within(row).getByText('asset')).toBeInTheDocument()
    expect(within(row).getByText(/view \+ download/)).toBeInTheDocument()
    expect(within(row).getByText('never')).toBeInTheDocument()
    expect(within(row).getByText('Sam Example')).toBeInTheDocument()

    // A password is a right, so it is named as one; and an expiry counts
    // forwards. formatRelativeTime only reads backwards, so a link expiring in
    // twelve days rendered as "just now", the opposite of what the column says.
    const other = screen.getByText(/Sportbrand Campaign/).closest('tr')!
    expect(within(other).getByText(/comment \+ password/)).toBeInTheDocument()
    expect(within(other).getByText('in 7 days')).toBeInTheDocument()
    expect(within(other).queryByText(/just now|ago/)).not.toBeInTheDocument()
    get.mockResolvedValue([
      { ...EXTERNAL[1], token: 'tok-old', expires_at: new Date(Date.now() - 86_400_000).toISOString() },
    ])
    render(<AdminExternalTab />)
    expect(await screen.findByText('expired')).toBeInTheDocument()
  })

  it("switches links off through the app's own revoke, after a confirmation", async () => {
    del.mockResolvedValue(undefined)
    render(<AdminExternalTab />)

    // The column was silent until something was selected, so a first visit saw
    // a column of boxes with nothing anywhere saying what they were for.
    expect(await screen.findByText(/Tick a link to switch it off/)).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Select' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Switch off/ })).not.toBeInTheDocument()
    fireEvent.click(
      await screen.findByRole('checkbox', { name: 'Select the link to Hero 4K Master' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Switch off 1' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/Nobody is notified/)).toBeInTheDocument()
    // Reversible, so no phrase to type: a gate on a reversible action only
    // teaches people to type through gates.
    expect(within(dialog).queryByLabelText(/type/i)).not.toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Switch off' }))
    await waitFor(() => expect(del).toHaveBeenCalledWith('/share/tok-download'))
    expect(del).toHaveBeenCalledTimes(1)
    get.mockResolvedValue([])
    render(<AdminExternalTab />)
    expect(await screen.findByText(/No links lead outside/)).toBeInTheDocument()
  })
})
