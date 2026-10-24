import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SWRConfig } from 'swr'

const { api } = vi.hoisted(() => ({
  api: { get: vi.fn(), patch: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() },
}))
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), api }))

import { ProjectPeopleTab } from '../people-tab'
import { useAuthStore } from '@/stores/auth-store'

// jsdom has no ResizeObserver, and Radix measures with it in layout effects. Set once for
// the file, not with vi.stubGlobal: afterEach's unstubAllGlobals would remove it, and a
// render that commits after a test's last await (Retry, SWR revalidation) then throws.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver

// The People tab is the old members dialog moved onto the settings page, with
// every failure shown rather than swallowed, a Joined column, and no message
// box the API never read.

const USERS = [
  { id: 'u1', name: 'Olivia Owner', email: 'olivia@example.com', avatar_url: null },
  { id: 'u2', name: 'Ed Editor', email: 'ed@example.com', avatar_url: null },
  { id: 'u3', name: 'Nina New', email: 'nina@example.com', avatar_url: null },
]

let members: { id: string; project_id: string; user_id: string; role: string; invited_at: string | null }[]

function renderTab() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
      <ProjectPeopleTab projectId="p1" />
    </SWRConfig>,
  )
}

const user = () => userEvent.setup({ pointerEventsCheck: 0 })

beforeEach(() => {
  members = [
    { id: 'm1', project_id: 'p1', user_id: 'u1', role: 'owner', invited_at: '2026-01-02T10:00:00Z' },
    { id: 'm2', project_id: 'p1', user_id: 'u2', role: 'editor', invited_at: '2026-03-15T10:00:00Z' },
  ]
  useAuthStore.setState({ user: { id: 'u1', name: 'Olivia Owner' } as never })
  api.get.mockReset().mockImplementation(async (url: string) => {
    if (url === '/projects/p1/members') return members
    if (url.startsWith('/users?ids=')) return USERS
    if (url.startsWith('/users/search')) return USERS
    throw new Error(`unexpected GET ${url}`)
  })
  api.post.mockReset().mockImplementation(async (_url: string, body: { user_id: string; role: string }) => {
    members = [...members, { id: 'm3', project_id: 'p1', user_id: body.user_id, role: body.role, invited_at: '2026-10-24T00:00:00Z' }]
    return members[2]
  })
  api.patch.mockReset().mockResolvedValue({})
  api.delete.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
  useAuthStore.setState({ user: null } as never)
})

function rowOf(name: string) {
  return screen.getByText(name).closest('tr') as HTMLElement
}

describe('the member list', () => {
  it('lists each member with their role and the date they joined', async () => {
    renderTab()
    expect(await screen.findByText('Members (2)')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Joined' })).toBeInTheDocument()
    expect(within(rowOf('Ed Editor')).getAllByText('Mar 15, 2026').length).toBeGreaterThan(0)
    expect(within(rowOf('Ed Editor')).getByRole('button', { name: 'Role for Ed Editor' })).toHaveTextContent('Edit & Share')
  })

  it('does not let you change your own role or remove yourself', async () => {
    renderTab()
    await screen.findByText('Members (2)')
    const own = rowOf('Olivia Owner')
    expect(within(own).queryByRole('button')).toBeNull()
    expect(within(own).getByText('Full Access')).toBeInTheDocument()
    expect(within(own).getByText('(you)')).toBeInTheDocument()
  })

  it('keeps the remove button reachable without hover', async () => {
    renderTab()
    await screen.findByText('Members (2)')
    const remove = screen.getByRole('button', { name: 'Remove Ed Editor' })
    // Hidden until hover only where the device can hover.
    expect(remove.className).toContain('[@media(hover:hover)]:opacity-0')
    expect(remove.className).not.toMatch(/(^|\s)opacity-0/)
  })

  it('lets the name column give way on a narrow screen, not the actions', async () => {
    // `truncate` does nothing in an auto-layout cell: the cell grows to the
    // full unbroken email instead, and the table with it. Measured in Chromium
    // at 375px, the table came out 443px wide inside a 291px card that clips,
    // so the role picker and the Remove button were off the screen for every
    // member. A cell with no minimum width (`max-w-0`) that takes the spare
    // room (`w-full`) is what lets the name and email shorten instead.
    renderTab()
    await screen.findByText('Members (2)')
    const cell = screen.getByText('ed@example.com').closest('td') as HTMLElement
    expect(cell.className.split(/\s+/)).toEqual(expect.arrayContaining(['max-w-0', 'w-full']))
    // The other cells hold their content on one line rather than wrapping it.
    for (const other of Array.from(rowOf('Ed Editor').querySelectorAll('td')).filter((td) => td !== cell)) {
      expect(other.className).toContain('whitespace-nowrap')
    }
  })

  it('says when members cannot be loaded, and Retry tries again', async () => {
    api.get.mockImplementation(async (url: string) => {
      if (url === '/projects/p1/members') throw new Error('Not a project member')
      return USERS
    })
    renderTab()
    expect(await screen.findByText('Members could not be loaded: Not a project member')).toBeInTheDocument()
    api.get.mockImplementation(async (url: string) => (url === '/projects/p1/members' ? members : USERS))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Members (2)')).toBeInTheDocument()
  })
})

describe('adding a member', () => {
  it('searches as you type, leaves out members, and adds with the chosen role', async () => {
    renderTab()
    await screen.findByText('Members (2)')
    fireEvent.change(screen.getByLabelText('Find people by name or email'), { target: { value: 'ni' } })

    const results = await screen.findByRole('list', { name: 'Search results' })
    expect(api.get).toHaveBeenCalledWith('/users/search?q=ni')
    expect(within(results).queryByText('Ed Editor')).toBeNull()
    expect(within(results).queryByText('Olivia Owner')).toBeNull()
    fireEvent.click(within(results).getByText('Nina New'))

    await user().click(screen.getByRole('button', { name: 'Role for the new member' }))
    await user().click(await screen.findByRole('menuitem', { name: /Comment Only/ }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    })

    expect(api.post).toHaveBeenCalledWith('/projects/p1/members', { user_id: 'u3', role: 'reviewer' })
    expect(await screen.findByText('Members (3)')).toBeInTheDocument()
  })

  it('shows why an add failed', async () => {
    api.post.mockRejectedValueOnce(new Error('User already a project member'))
    renderTab()
    await screen.findByText('Members (2)')
    fireEvent.change(screen.getByLabelText('Find people by name or email'), { target: { value: 'ni' } })
    fireEvent.click(within(await screen.findByRole('list', { name: 'Search results' })).getByText('Nina New'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    })
    expect(await screen.findByText('User already a project member')).toBeInTheDocument()
  })

  it('shows why a search failed', async () => {
    renderTab()
    await screen.findByText('Members (2)')
    api.get.mockImplementation(async (url: string) => {
      if (url.startsWith('/users/search')) throw new Error('Search is down')
      return url === '/projects/p1/members' ? members : USERS
    })
    fireEvent.change(screen.getByLabelText('Find people by name or email'), { target: { value: 'ni' } })
    expect(await screen.findByText('Search is down')).toBeInTheDocument()
  })

  it('has no message box', async () => {
    renderTab()
    await screen.findByText('Members (2)')
    expect(screen.queryByPlaceholderText(/message/i)).toBeNull()
  })
})

describe('changing a role', () => {
  it('sends the new role', async () => {
    renderTab()
    await screen.findByText('Members (2)')
    await user().click(screen.getByRole('button', { name: 'Role for Ed Editor' }))
    await user().click(await screen.findByRole('menuitem', { name: /View Only/ }))
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/projects/p1/members/u2', { role: 'viewer' }),
    )
  })

  it('shows why a change failed', async () => {
    api.patch.mockRejectedValueOnce(new Error('Only the owner can change roles'))
    renderTab()
    await screen.findByText('Members (2)')
    await user().click(screen.getByRole('button', { name: 'Role for Ed Editor' }))
    await user().click(await screen.findByRole('menuitem', { name: /View Only/ }))
    expect(
      await screen.findByText("Could not change Ed Editor's role: Only the owner can change roles"),
    ).toBeInTheDocument()
  })
})

describe('removing a member', () => {
  it('asks first, then removes', async () => {
    renderTab()
    await screen.findByText('Members (2)')
    fireEvent.click(screen.getByRole('button', { name: 'Remove Ed Editor' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Remove Ed Editor?')).toBeInTheDocument()
    expect(api.delete).not.toHaveBeenCalled()

    members = members.filter((m) => m.user_id !== 'u2')
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
    })
    expect(api.delete).toHaveBeenCalledWith('/projects/p1/members/u2')
    expect(await screen.findByText('Members (1)')).toBeInTheDocument()
  })

  it('keeps the dialog open with the reason when it fails', async () => {
    api.delete.mockRejectedValueOnce(new Error('Member not found'))
    renderTab()
    await screen.findByText('Members (2)')
    fireEvent.click(screen.getByRole('button', { name: 'Remove Ed Editor' }))
    const dialog = await screen.findByRole('dialog')
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
    })
    expect(within(screen.getByRole('dialog')).getByText('Member not found')).toBeInTheDocument()
  })
})
