import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { SWRConfig } from 'swr'
import type { Project } from '@/types'

const { api, nav } = vi.hoisted(() => ({
  api: { get: vi.fn() },
  nav: { search: '' },
}))
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), api }))
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(nav.search),
}))

import { SettingsProjectList } from '../project-list'
import { useAuthStore } from '@/stores/auth-store'
import { useBrandingStore } from '@/stores/branding-store'

// The list is what a person can manage: every live project for an Admin, the
// projects they own for everyone else. The chip says how they get there.

function project(id: string, name: string, role: string | null): Project {
  return {
    id,
    name,
    description: null,
    created_by: 'u0',
    project_type: 'personal',
    created_at: '2026-01-01T00:00:00Z',
    deleted_at: null,
    poster_url: null,
    role,
  }
}

const PROJECTS: Project[] = [
  project('p1', 'Spring Campaign', null),
  project('p2', 'Brand Film 2026', 'owner'),
  project('p3', 'Autumn Lookbook', 'editor'),
]

function renderList(selectedId?: string) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
      <SettingsProjectList selectedId={selectedId} />
    </SWRConfig>,
  )
}

function signIn(isSuperAdmin: boolean) {
  useAuthStore.setState({
    user: { id: 'me', name: 'Me', email: 'me@example.com', is_superadmin: isSuperAdmin } as never,
    isSuperAdmin,
  })
}

const rowNames = () =>
  within(screen.getByRole('list')).getAllByRole('link').map((l) => l.getAttribute('title'))

beforeEach(() => {
  nav.search = ''
  api.get.mockReset().mockResolvedValue(PROJECTS)
  useAuthStore.setState({ user: null, isSuperAdmin: false } as never)
})
afterEach(() => {
  useAuthStore.setState({ user: null, isSuperAdmin: false } as never)
})

// First in the file: React warns about a switched input once per module, so a
// later test would find the warning already spent.
describe('while loading', () => {
  it('keeps the search box controlled, so loading does not warn about switching it', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      signIn(true)
      renderList()
      await screen.findByRole('list')
      const switched = errors.mock.calls.some((args) =>
        String(args[0]).includes('uncontrolled input to be controlled'),
      )
      expect(switched).toBe(false)
    } finally {
      errors.mockRestore()
    }
  })
})

describe('for an Admin', () => {
  it('asks for every project and lists them by name, each with how the Admin reaches it', async () => {
    signIn(true)
    renderList()

    await screen.findByRole('list')
    expect(api.get).toHaveBeenCalledWith('/projects?scope=all')
    expect(rowNames()).toEqual(['Autumn Lookbook', 'Brand Film 2026', 'Spring Campaign'])

    const chip = (name: string) =>
      within(screen.getByRole('link', { name: new RegExp(`^${name}`) })).getByText(/^(Owner|Admin)$/)
    expect(chip('Brand Film 2026')).toHaveTextContent('Owner')
    // Editor and non-member both reach the project through the role alone.
    expect(chip('Autumn Lookbook')).toHaveTextContent('Admin')
    expect(chip('Spring Campaign')).toHaveTextContent('Admin')
  })

  it('labels the list with its length', async () => {
    signIn(true)
    renderList()
    await screen.findByRole('list', { name: 'All projects (3)' })
  })

  it('says so when the instance has no projects', async () => {
    signIn(true)
    api.get.mockResolvedValue([])
    renderList()
    expect(await screen.findByText('No projects yet')).toBeInTheDocument()
    expect(screen.queryByRole('searchbox')).toBeNull()
  })
})

describe('for everyone else', () => {
  it('asks for their projects and lists only the ones they own', async () => {
    signIn(false)
    renderList()

    await screen.findByRole('list', { name: 'Your projects (1)' })
    expect(api.get).toHaveBeenCalledWith('/projects')
    expect(api.get).not.toHaveBeenCalledWith('/projects?scope=all')
    expect(rowNames()).toEqual(['Brand Film 2026'])
    expect(screen.getByText('Owner')).toBeInTheDocument()
    expect(screen.queryByText('Admin')).toBeNull()
  })

  it("says so when they own none, without a search box", async () => {
    signIn(false)
    api.get.mockResolvedValue([project('p3', 'Autumn Lookbook', 'editor'), project('p4', 'Open', null)])
    renderList()
    expect(await screen.findByText("You don't own any projects")).toBeInTheDocument()
    expect(screen.queryByRole('searchbox')).toBeNull()
  })
})

describe('before the user is known', () => {
  it('sends no request, shows placeholders with the search disabled, then asks once for the right list', async () => {
    renderList()
    expect(screen.getByLabelText('Loading projects')).toBeInTheDocument()
    expect(screen.getByRole('searchbox', { name: 'Search projects' })).toBeDisabled()
    expect(api.get).not.toHaveBeenCalled()

    act(() => signIn(true))
    await screen.findByRole('list')
    expect(api.get).toHaveBeenCalledTimes(1)
    expect(api.get).toHaveBeenCalledWith('/projects?scope=all')
  })
})

describe('search', () => {
  it('filters by name, ignoring case and padding, and the count follows', async () => {
    signIn(true)
    renderList()
    await screen.findByRole('list')

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search projects' }), { target: { value: '  SPR ' } })
    expect(rowNames()).toEqual(['Spring Campaign'])
    expect(screen.getByRole('list', { name: 'All projects (1)' })).toBeInTheDocument()
  })

  it('says when nothing matches', async () => {
    signIn(true)
    renderList()
    await screen.findByRole('list')

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search projects' }), { target: { value: 'zzz' } })
    expect(screen.getByText('All projects (0)')).toBeInTheDocument()
    expect(screen.getByText('No projects match "zzz".')).toBeInTheDocument()
    expect(screen.queryByRole('list')).toBeNull()
  })
})

describe('when the request fails', () => {
  it('shows an alert, and Retry asks again', async () => {
    signIn(true)
    api.get.mockRejectedValueOnce(new Error('boom'))
    renderList()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Projects could not be loaded.')
    expect(api.get).toHaveBeenCalledTimes(1)

    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    await screen.findByRole('list')
    expect(api.get).toHaveBeenCalledTimes(2)
  })
})

describe('the selected project', () => {
  it('is current, and carries General and People with their tab in the link', async () => {
    signIn(true)
    renderList('p2')
    await screen.findByRole('list')

    const row = screen.getByRole('link', { name: /^Brand Film 2026/ })
    expect(row).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: /^Spring Campaign/ })).not.toHaveAttribute('aria-current')

    const general = await screen.findByRole('link', { name: 'General' })
    const people = screen.getByRole('link', { name: 'People' })
    expect(general).toHaveAttribute('href', '/settings/projects/p2?tab=general')
    expect(people).toHaveAttribute('href', '/settings/projects/p2?tab=people')
    expect(general).toHaveAttribute('aria-current', 'page')
    expect(people).not.toHaveAttribute('aria-current')
  })

  it('marks People when the query asks for it, and General for danger or an unknown tab', async () => {
    signIn(true)
    nav.search = 'tab=people'
    const view = renderList('p2')
    expect(await screen.findByRole('link', { name: 'People' })).toHaveAttribute('aria-current', 'page')
    view.unmount()

    nav.search = 'tab=danger'
    renderList('p2')
    expect(await screen.findByRole('link', { name: 'General' })).toHaveAttribute('aria-current', 'page')
  })

  it('shows General and People under no other row, and under none when nothing is selected', async () => {
    signIn(true)
    renderList()
    await screen.findByRole('list')
    await waitFor(() => expect(screen.queryByRole('link', { name: 'General' })).toBeNull())
    expect(screen.queryByRole('link', { name: 'People' })).toBeNull()
  })
})

describe('the open project', () => {
  // Records each scrollIntoView call with the row it moved and its options.
  function recordScrolls() {
    const calls: { el: Element; opts: unknown }[] = []
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function (this: Element, opts?: unknown) {
      calls.push({ el: this, opts })
    }
    return { calls, restore: () => { Element.prototype.scrollIntoView = original } }
  }

  it('centres its row once the list has loaded, as a deep link lands', async () => {
    const { calls, restore } = recordScrolls()
    try {
      signIn(true)
      renderList('p1')
      await screen.findByRole('list')
      await waitFor(() => expect(calls).toHaveLength(1))
      expect(within(calls[0].el as HTMLElement).getByRole('link', { name: /^Spring Campaign/ })).toBeInTheDocument()
      expect(calls[0].opts).toEqual({ block: 'center' })
    } finally {
      restore()
    }
  })

  it('moves only as far as needed for a later pick, so the list stays under the pointer', async () => {
    const { calls, restore } = recordScrolls()
    try {
      signIn(true)
      const cache = new Map()
      const list = (id: string) => (
        <SWRConfig value={{ provider: () => cache, dedupingInterval: 0, shouldRetryOnError: false }}>
          <SettingsProjectList selectedId={id} />
        </SWRConfig>
      )
      const view = render(list('p1'))
      await screen.findByRole('list')
      await waitFor(() => expect(calls).toHaveLength(1))

      view.rerender(list('p2'))
      await waitFor(() => expect(calls).toHaveLength(2))
      expect(within(calls[1].el as HTMLElement).getByRole('link', { name: /^Brand Film 2026/ })).toBeInTheDocument()
      expect(calls[1].opts).toEqual({ block: 'nearest' })
    } finally {
      restore()
    }
  })
})

describe('the end of the list under the floating credit', () => {
  // On a phone the list is the whole page and ends in the corner where the
  // shell floats "Powered by FreeFrame", so it leaves room to scroll clear.
  const RESERVE = 'pb-[calc(3.5rem+env(safe-area-inset-bottom))]'
  const wrapper = () => screen.getByRole('list').parentElement as HTMLElement

  it('reserves room on a phone while the credit is shown, and none from md', async () => {
    useBrandingStore.setState({ loaded: true, poweredByFreeframe: true })
    signIn(true)
    renderList()
    await screen.findByRole('list')
    const classes = wrapper().className.split(/\s+/)
    expect(classes).toContain(RESERVE)
    expect(classes).toContain('md:pb-2')
  })

  it('reserves nothing when "Powered by FreeFrame" is turned off', async () => {
    useBrandingStore.setState({ loaded: true, poweredByFreeframe: false })
    signIn(true)
    renderList()
    await screen.findByRole('list')
    expect(wrapper().className).not.toContain('safe-area-inset-bottom')
  })
})
