import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { SWRConfig } from 'swr'
import type { Project } from '@/types'

const { api } = vi.hoisted(() => ({ api: { get: vi.fn() } }))
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), api }))
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
}))

import SettingsProjectsPage from '../page'
import { useAuthStore } from '@/stores/auth-store'

// `/settings/projects` shows the rail's list beside this page. When the rail
// says there is nothing to open, a second "Select a project" would contradict it.

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

function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
      <SettingsProjectsPage />
    </SWRConfig>,
  )
}

beforeEach(() => {
  api.get.mockReset()
  useAuthStore.setState({
    user: { id: 'me', name: 'Me', email: 'me@example.com', is_superadmin: false } as never,
    isSuperAdmin: false,
  })
})
afterEach(() => {
  useAuthStore.setState({ user: null, isSuperAdmin: false } as never)
})

describe('the projects index prompts only when there is a project to select', () => {
  it('prompts when the caller owns one', async () => {
    api.get.mockResolvedValue([project('p1', 'Launch film', 'owner')])
    renderPage()
    expect(await screen.findByText('Select a project')).toBeInTheDocument()
  })

  it('stays empty when the caller owns none', async () => {
    api.get.mockResolvedValue([project('p1', 'Launch film', 'editor')])
    const { container } = renderPage()
    await act(async () => {})
    expect(api.get).toHaveBeenCalledWith('/projects')
    expect(screen.queryByText('Select a project')).toBeNull()
    expect(container).toBeEmptyDOMElement()
  })
})
