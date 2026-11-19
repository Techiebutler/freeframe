import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { Project } from '@/types'

// An instance administrator can look past their own memberships. The switch is
// theirs alone, it does not change the default view, and it asks the API for a
// different scope rather than filtering a list it was never sent.

const { auth, swrCalls, projects } = vi.hoisted(() => ({
  auth: { user: { id: 'u1' } as { id: string }, isSuperAdmin: false },
  swrCalls: [] as string[],
  projects: [] as Project[],
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('swr', () => ({
  default: (key: string) => {
    swrCalls.push(key)
    return { data: projects, isLoading: false, mutate: vi.fn() }
  },
}))
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() } }))
vi.mock('@/hooks/use-page-title', () => ({ usePageTitle: () => undefined }))
vi.mock('@/hooks/use-projects-view-ready', () => ({ useProjectsViewReady: () => true }))
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: (selector?: (s: unknown) => unknown) =>
    typeof selector === 'function' ? selector(auth) : auth,
}))
vi.mock('@/stores/projects-view-store', () => ({
  useProjectsViewStore: () => ({
    layout: 'list',
    cardSize: 'M',
    showCardInfo: true,
    sortKey: 'name',
    sortDirection: 'asc',
  }),
}))
vi.mock('@/components/projects/projects-appearance-popover', () => ({
  ProjectsAppearancePopover: () => null,
}))
vi.mock('@/components/projects/projects-sort-popover', () => ({
  ProjectsSortPopover: () => null,
}))

import ProjectsPage from '../page'

function project(id: string, name: string, overrides: Partial<Project> = {}): Project {
  return {
    id,
    name,
    description: null,
    created_by: 'someone-else',
    project_type: 'personal',
    poster_url: null,
    is_public: false,
    created_at: '2026-01-01T00:00:00Z',
    deleted_at: null,
    asset_count: 0,
    storage_bytes: 0,
    member_count: 1,
    role: null,
    ...overrides,
  }
}

function lastKey(): string {
  return swrCalls[swrCalls.length - 1]
}

describe('Projects page: the All projects switch', () => {
  beforeEach(() => {
    swrCalls.length = 0
    projects.length = 0
    auth.isSuperAdmin = false
    auth.user = { id: 'u1' }
  })

  it('is not offered to anyone but an instance admin', () => {
    projects.push(project('p1', 'Mine', { created_by: 'u1' }))
    render(<ProjectsPage />)
    expect(screen.queryByRole('group', { name: /which projects/i })).not.toBeInTheDocument()
    expect(lastKey()).toBe('/projects')
  })

  it('starts an admin on the old view, asks the API for the other scope, and comes back', async () => {
    // A project the admin neither created, is a member of, nor is public
    // belongs to none of the three relationship sections, so in that scope the
    // page is one flat list rather than sections something can fall out of.
    auth.isSuperAdmin = true
    projects.push(project('p1', 'Someone elses'))
    render(<ProjectsPage />)
    expect(screen.getByRole('group', { name: /which projects/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Mine' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'All projects' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    expect(lastKey()).toBe('/projects')
    expect(screen.getByText('My Projects')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'All projects' }))

    await waitFor(() => expect(lastKey()).toBe('/projects?scope=all'))
    expect(await screen.findByText('All projects on this instance')).toBeInTheDocument()
    expect(screen.queryByText('My Projects')).not.toBeInTheDocument()
    expect(screen.getByText('Someone elses')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Mine' }))

    await waitFor(() => expect(lastKey()).toBe('/projects'))
    expect(screen.getByText('My Projects')).toBeInTheDocument()
  })
})
