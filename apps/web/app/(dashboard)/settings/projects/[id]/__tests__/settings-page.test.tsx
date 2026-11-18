import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SWRConfig } from 'swr'
import type { Project, ProjectBranding } from '@/types'

const { api, nav } = vi.hoisted(() => ({
  api: { get: vi.fn(), patch: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn(), upload: vi.fn() },
  nav: { id: 'p1', search: '', replace: vi.fn(), push: vi.fn() },
}))
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), api }))
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: nav.id }),
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  useSearchParams: () => new URLSearchParams(nav.search),
}))
vi.mock('@/hooks/use-page-title', () => ({ usePageTitle: () => undefined }))

import ProjectSettingsPage from '../page'
import { useAuthStore } from '@/stores/auth-store'
import { useBrandingStore } from '@/stores/branding-store'

// jsdom has no ResizeObserver, and Radix measures with it in layout effects. Set once for
// the file, not with vi.stubGlobal: afterEach's unstubAllGlobals would remove it, and a
// render that commits after a test's last await (Retry, SWR revalidation) then throws.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver

// Project settings is the owner's page: the API refuses everyone else's saves
// on it, so they get a short card instead of forms. Each tab is reachable as
// ?tab=, and a draft on General survives a visit to another tab. An instance
// admin who is not a member is told so, and Delete project is a collapsed row
// at the end of General.

const NOTICE =
  'You are not a member of this project. You are managing it as an instance admin, and this access is written to the activity log.'

const PROJECT: Project = {
  id: 'p1',
  name: 'Launch film',
  description: null,
  created_by: 'u1',
  project_type: 'personal',
  created_at: '2026-01-01T00:00:00Z',
  deleted_at: null,
  is_public: false,
  poster_url: null,
  role: 'owner',
}

const BRANDING: ProjectBranding = {
  id: 'b1', project_id: 'p1', logo_s3_key: null, logo_url: null, primary_color: null,
  secondary_color: null, custom_title: null, custom_footer: null, viewer_layout: 'grid',
  featured_field: null, use_cover_as_logo: false,
}

let project: Project | Error = PROJECT
let members: unknown = [{ id: 'm1', project_id: 'p1', user_id: 'u1', role: 'owner', invited_at: '2026-01-02T00:00:00Z' }]
const SECOND: Project = { ...PROJECT, id: 'p2', name: 'Second film' }

function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
      <ProjectSettingsPage />
    </SWRConfig>,
  )
}

beforeEach(() => {
  project = PROJECT
  nav.id = 'p1'
  nav.search = ''
  nav.replace.mockReset()
  nav.push.mockReset()
  useAuthStore.setState({
    user: { id: 'u1', name: 'Owner', email: 'o@example.com' } as never,
    isSuperAdmin: false,
  })
  api.get.mockReset().mockImplementation(async (url: string) => {
    if (url === '/projects/p1') {
      if (project instanceof Error) throw project
      return project
    }
    if (url === '/projects/p2') return SECOND
    if (url === '/projects/p1/branding') return BRANDING
    if (url === '/projects/p2/branding') return { ...BRANDING, id: 'b2', project_id: 'p2' }
    if (url === '/projects/p1/members') return members
    if (url.startsWith('/users?ids=')) return [{ id: 'u1', name: 'Owner', email: 'o@example.com' }]
    throw new Error(`unexpected GET ${url}`)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  useAuthStore.setState({ user: null, isSuperAdmin: false } as never)
  useBrandingStore.setState({ loaded: false, poweredByFreeframe: true })
})

describe('who sees the settings', () => {
  it('shows the owner two tabs', async () => {
    renderPage()
    const tabs = await screen.findAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual(['General', 'People'])
    expect(screen.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true')
  })

  it.each(['editor', 'reviewer', 'viewer'])('shows a %s a short card and no forms', async (role) => {
    project = { ...PROJECT, role }
    renderPage()
    expect(await screen.findByText('Only the project owner can change settings.')).toBeInTheDocument()
    expect(screen.queryByRole('tab')).toBeNull()
    expect(screen.queryByLabelText('Name')).toBeNull()
  })

  it('falls back to the member list when the project names no role', async () => {
    project = { ...PROJECT, role: null }
    renderPage()
    expect(await screen.findByRole('tab', { name: 'General' })).toBeInTheDocument()
  })

  it('shows a loading state, never the refusal, before the role is known', () => {
    api.get.mockImplementation(() => new Promise(() => {}))
    renderPage()
    expect(screen.getByLabelText('Loading project settings')).toBeInTheDocument()
    expect(screen.queryByText('Only the project owner can change settings.')).toBeNull()
  })

  it('says when the project cannot be loaded, and Retry tries again', async () => {
    project = new Error('Project not found')
    renderPage()
    expect(await screen.findByText('This project could not be loaded: Project not found')).toBeInTheDocument()
    project = PROJECT
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('tab', { name: 'General' })).toBeInTheDocument()
  })
})

describe('deep links', () => {
  it.each([
    ['people', 'People'],
    ['danger', 'General'],
    ['general', 'General'],
    ['branding', 'General'],
    ['nonsense', 'General'],
  ])('?tab=%s opens %s', async (tab, label) => {
    nav.search = `tab=${tab}`
    renderPage()
    expect(await screen.findByRole('tab', { name: label })).toHaveAttribute('aria-selected', 'true')
  })

  it('follows a link to another tab while the page stays mounted', async () => {
    // The toolbar's People button and the card menu's Delete link change only
    // the query, so the page is not remounted and has to switch on its own.
    nav.search = 'tab=general'
    const view = renderPage()
    expect(await screen.findByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true')

    nav.search = 'tab=people'
    view.rerender(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
        <ProjectSettingsPage />
      </SWRConfig>,
    )
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'People' })).toHaveAttribute('aria-selected', 'true'),
    )
    expect(screen.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'false')
  })

  it('choosing a tab puts it in the URL', async () => {
    renderPage()
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'People' }))
    expect(nav.replace).toHaveBeenCalledWith('/settings/projects/p1?tab=people', { scroll: false })
  })
})

describe('the General draft', () => {
  it('survives a visit to another tab', async () => {
    renderPage()
    const name = await screen.findByLabelText('Name')
    fireEvent.change(name, { target: { value: 'Unsaved name' } })

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'People' }))
    await screen.findByText('Members (1)')
    // Still mounted, behind the active tab (hidden by its inactive state).
    const panel = () => screen.getByLabelText('Name').closest('[role="tabpanel"]')
    expect(panel()).toHaveAttribute('data-state', 'inactive')
    expect(panel()?.className).toContain('data-[state=inactive]:hidden')

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'General' }))
    await waitFor(() => expect(panel()).toHaveAttribute('data-state', 'active'))
    expect(screen.getByLabelText('Name')).toHaveValue('Unsaved name')
  })
})

describe('the end of a tab under the floating credit', () => {
  // The shell floats "Powered by FreeFrame" 1rem above the window's bottom
  // edge, on the right. Measured in Chromium at 375x740 with four members,
  // the last row's Remove button was under it at the end of the scroll:
  // `elementFromPoint` returned the badge's span. People and the Delete project
  // row end in that corner, so they leave room below their content while the
  // badge is shown. General's save bar reserves the corner itself.
  const RESERVE = 'pb-[calc(3.5rem+env(safe-area-inset-bottom))]'
  // General stays mounted behind the others, so there are two panels.
  const activePanel = () =>
    screen.getAllByRole('tabpanel').find((p) => p.getAttribute('data-state') === 'active') as HTMLElement

  it('the People tab can scroll its last control clear of the badge', async () => {
    useBrandingStore.setState({ loaded: true, poweredByFreeframe: true })
    nav.search = 'tab=people'
    renderPage()
    await screen.findByRole('tab', { name: 'People' })
    expect(activePanel().className.split(/\s+/)).toContain(RESERVE)
  })

  it('the Delete project row carries the reserve at the end of General', async () => {
    useBrandingStore.setState({ loaded: true, poweredByFreeframe: true })
    renderPage()
    const row = (await screen.findByRole('button', { name: 'Delete project' })).parentElement as HTMLElement
    expect(row.className.split(/\s+/)).toContain(RESERVE)
  })

  it('reserves nothing when "Powered by FreeFrame" is turned off', async () => {
    useBrandingStore.setState({ loaded: true, poweredByFreeframe: false })
    nav.search = 'tab=people'
    renderPage()
    await screen.findByRole('tab', { name: 'People' })
    expect(activePanel().className).not.toContain('safe-area-inset-bottom')
  })
})

describe('the instance admin notice', () => {
  it.each([
    ['an admin that is not a member', true, null, true],
    ['an admin that is only an editor', true, 'editor', false],
    ['an admin that is also an owner', true, 'owner', false],
    ['a plain owner', false, 'owner', false],
  ] as const)('for %s', async (_name, isSuperAdmin, role, shown) => {
    useAuthStore.setState({ isSuperAdmin })
    project = { ...PROJECT, role }
    renderPage()
    await screen.findByLabelText('Name')
    if (shown) expect(screen.getByRole('note')).toHaveTextContent(NOTICE)
    else expect(screen.queryByText(NOTICE)).toBeNull()
  })

  it('shows on People as well', async () => {
    useAuthStore.setState({ isSuperAdmin: true })
    project = { ...PROJECT, role: null }
    nav.search = 'tab=people'
    renderPage()
    expect(await screen.findByRole('note')).toHaveTextContent(NOTICE)
  })

  it('is decided without the member list: the page never asks for it before People opens', async () => {
    useAuthStore.setState({ isSuperAdmin: true })
    project = { ...PROJECT, role: null }
    renderPage()
    await screen.findByLabelText('Name')
    expect(screen.getByRole('note')).toBeInTheDocument()
    expect(api.get).not.toHaveBeenCalledWith('/projects/p1/members')
  })
})

describe('the Delete project row', () => {
  const toggle = () => screen.getByRole('button', { name: 'Delete project' })

  it('starts collapsed and opens on a click', async () => {
    renderPage()
    await screen.findByLabelText('Name')
    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Delete this project')).toBeNull()

    fireEvent.click(toggle())
    expect(screen.getByText('Delete this project')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Delete project' })[0]).toHaveAttribute('aria-expanded', 'true')
  })

  it('?tab=danger opens it at once', async () => {
    nav.search = 'tab=danger'
    renderPage()
    await screen.findByLabelText('Name')
    expect(screen.getAllByRole('button', { name: 'Delete project' })[0]).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Delete this project')).toBeInTheDocument()
  })

  it('?tab=danger scrolls the row into view, and a plain visit does not', async () => {
    // jsdom has no scrollIntoView; the page calls it only when it exists.
    const proto = Element.prototype as { scrollIntoView?: unknown }
    const scroll = vi.fn()
    proto.scrollIntoView = scroll
    try {
      renderPage()
      await screen.findByLabelText('Name')
      expect(scroll).not.toHaveBeenCalled()
      cleanup()

      nav.search = 'tab=danger'
      renderPage()
      await screen.findByLabelText('Name')
      expect(scroll).toHaveBeenCalledWith({ block: 'center' })
    } finally {
      delete proto.scrollIntoView
    }
  })

  it('opens when the query changes to danger on the mounted page', async () => {
    const view = renderPage()
    await screen.findByLabelText('Name')
    expect(screen.queryByText('Delete this project')).toBeNull()

    nav.search = 'tab=danger'
    view.rerender(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
        <ProjectSettingsPage />
      </SWRConfig>,
    )
    expect(await screen.findByText('Delete this project')).toBeInTheDocument()
  })
})

describe('the phone layout', () => {
  it('has a project picker that links to the list, and hides the tab list from md', async () => {
    renderPage()
    await screen.findByLabelText('Name')
    const picker = screen.getByRole('link', { name: 'Choose project' })
    expect(picker).toHaveAttribute('href', '/settings/projects')
    expect(picker.className.split(/\s+/)).toContain('md:hidden')
    expect(picker).toHaveTextContent('Launch film')
    expect(screen.getByRole('tablist').className.split(/\s+/)).toContain('md:hidden')
  })
})

describe('moving to another project', () => {
  // The rail keeps this page mounted when another project is picked. A project
  // opened before is already in the SWR cache, so nothing swaps in a loading
  // state in between: the form has to be remounted by the project's id.
  it('shows the new project, not the draft of the one before', async () => {
    const cache = new Map()
    // A new element each time: React skips a render for an identical one.
    const page = () => (
      <SWRConfig value={{ provider: () => cache, dedupingInterval: 0, shouldRetryOnError: false }}>
        <ProjectSettingsPage />
      </SWRConfig>
    )

    nav.id = 'p2'
    const first = render(page())
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('Second film'))
    first.unmount()

    nav.id = 'p1'
    const view = render(page())
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Unsaved name' } })

    nav.id = 'p2'
    view.rerender(page())
    expect(screen.getByLabelText('Name')).toHaveValue('Second film')
  })
})
