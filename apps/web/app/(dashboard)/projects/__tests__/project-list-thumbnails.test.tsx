import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { getGradientForProject } from '@/lib/gradient-utils'
import type { Project } from '@/types'

// The list view drew one purple gradient for every project, where the grid
// shows each project's poster or its own gradient. Both now show the same.

const { viewState, projects } = vi.hoisted(() => ({
  viewState: { layout: 'list' as 'grid' | 'list' },
  projects: [] as Project[],
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('swr', () => ({ default: () => ({ data: projects, isLoading: false, mutate: vi.fn() }) }))
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() } }))
vi.mock('@/hooks/use-page-title', () => ({ usePageTitle: () => undefined }))
vi.mock('@/hooks/use-projects-view-ready', () => ({ useProjectsViewReady: () => true }))
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: (selector?: (s: unknown) => unknown) => {
    const state = { user: { id: 'u1' } }
    return typeof selector === 'function' ? selector(state) : state
  },
}))
vi.mock('@/stores/projects-view-store', () => ({
  useProjectsViewStore: () => ({
    layout: viewState.layout,
    cardSize: 'M',
    showCardInfo: true,
    sortKey: 'name',
    sortDirection: 'asc',
  }),
}))
vi.mock('@/components/projects/projects-appearance-popover', () => ({ ProjectsAppearancePopover: () => null }))
vi.mock('@/components/projects/projects-sort-popover', () => ({ ProjectsSortPopover: () => null }))

import ProjectsPage from '../page'

function project(id: string, name: string, poster_url: string | null = null): Project {
  return {
    id, name, poster_url,
    description: null,
    created_by: 'u1',
    project_type: 'personal',
    created_at: '2026-01-01T00:00:00Z',
    deleted_at: null,
  }
}

/** Each project's picture in the current view, by name. */
function pictures() {
  return Object.fromEntries(
    projects.map((p) => {
      const img = screen.queryByRole('img', { name: p.name })
      const gradient = document.querySelector(`[data-project-poster="${p.id}"]`)
      return [p.name, img ? img.getAttribute('src') : gradient?.className ?? null]
    }),
  )
}

beforeEach(() => {
  projects.length = 0
  projects.push(
    project('11111111-aaaa', 'Alpha', 'https://cdn/alpha.jpg'),
    project('22222222-bbbb', 'Bravo'),
    project('33333333-cccc', 'Charlie'),
  )
})

describe('project pictures in the list view', () => {
  it('show the poster where there is one', () => {
    viewState.layout = 'list'
    render(<ProjectsPage />)
    expect(screen.getByRole('img', { name: 'Alpha' }).getAttribute('src')).toBe('https://cdn/alpha.jpg')
  })

  it('show each project its own gradient, not one for all', () => {
    viewState.layout = 'list'
    render(<ProjectsPage />)
    for (const p of projects.slice(1)) {
      const el = document.querySelector(`[data-project-poster="${p.id}"]`)!
      expect(el.className).toContain(getGradientForProject(p.id))
    }
  })

  it('match the grid view exactly', () => {
    viewState.layout = 'grid'
    const grid = render(<ProjectsPage />)
    const inGrid = pictures()
    grid.unmount()

    viewState.layout = 'list'
    render(<ProjectsPage />)
    expect(pictures()).toEqual(inGrid)
  })
})
