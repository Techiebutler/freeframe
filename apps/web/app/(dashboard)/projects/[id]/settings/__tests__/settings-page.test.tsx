import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SWRConfig } from 'swr'
import type { Project, ProjectBranding } from '@/types'

const { api, nav } = vi.hoisted(() => ({
  api: { get: vi.fn(), patch: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn(), upload: vi.fn() },
  nav: { search: '', replace: vi.fn(), push: vi.fn() },
}))
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), api }))
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'p1' }),
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  useSearchParams: () => new URLSearchParams(nav.search),
}))
vi.mock('@/hooks/use-page-title', () => ({ usePageTitle: () => undefined }))

import ProjectSettingsPage from '../page'
import { useAuthStore } from '@/stores/auth-store'
import { useBrandingStore } from '@/stores/branding-store'

// Project settings is the owner's page: the API refuses everyone else's saves
// on it, so they get a short card instead of forms. Each tab is reachable as
// ?tab=, and a draft on General survives a visit to another tab.

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

function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
      <ProjectSettingsPage />
    </SWRConfig>,
  )
}

beforeEach(() => {
  project = PROJECT
  nav.search = ''
  nav.replace.mockReset()
  nav.push.mockReset()
  useAuthStore.setState({ user: { id: 'u1', name: 'Owner', email: 'o@example.com' } as never })
  api.get.mockReset().mockImplementation(async (url: string) => {
    if (url === '/projects/p1') {
      if (project instanceof Error) throw project
      return project
    }
    if (url === '/projects/p1/branding') return BRANDING
    if (url === '/projects/p1/members') return members
    if (url.startsWith('/users?ids=')) return [{ id: 'u1', name: 'Owner', email: 'o@example.com' }]
    throw new Error(`unexpected GET ${url}`)
  })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})

afterEach(() => {
  vi.unstubAllGlobals()
  useAuthStore.setState({ user: null } as never)
  useBrandingStore.setState({ loaded: false, poweredByFreeframe: true })
})

describe('who sees the settings', () => {
  it('shows the owner three tabs', async () => {
    renderPage()
    const tabs = await screen.findAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual(['General', 'People', 'Danger'])
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
    ['danger', 'Danger'],
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
    expect(nav.replace).toHaveBeenCalledWith('/projects/p1/settings?tab=people', { scroll: false })
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
  // `elementFromPoint` returned the badge's span. People and Danger end in
  // that corner, so they leave room below their content while the badge is
  // shown. General needs none: its save bar reserves the corner itself.
  const RESERVE = 'pb-[calc(3.5rem+env(safe-area-inset-bottom))]'
  // General stays mounted behind the others, so there are two panels.
  const activePanel = () =>
    screen.getAllByRole('tabpanel').find((p) => p.getAttribute('data-state') === 'active') as HTMLElement

  it.each([['people'], ['danger']])('the %s tab can scroll its last control clear of the badge', async (tab) => {
    useBrandingStore.setState({ loaded: true, poweredByFreeframe: true })
    nav.search = `tab=${tab}`
    renderPage()
    await screen.findByRole('tab', { name: tab === 'people' ? 'People' : 'Danger' })
    expect(activePanel().className.split(/\s+/)).toContain(RESERVE)
  })

  it('reserves nothing when "Powered by FreeFrame" is turned off', async () => {
    useBrandingStore.setState({ loaded: true, poweredByFreeframe: false })
    nav.search = 'tab=people'
    renderPage()
    await screen.findByRole('tab', { name: 'People' })
    expect(activePanel().className).not.toContain('safe-area-inset-bottom')
  })
})
