import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { SWRConfig, mutate } from 'swr'
import type { Project, ProjectBranding } from '@/types'

const { api, push } = vi.hoisted(() => ({
  api: { get: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn(), upload: vi.fn(), post: vi.fn() },
  push: vi.fn(),
}))
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), api }))
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({ push, replace: vi.fn() }),
}))
vi.mock('@/lib/avatar-image', async (orig) => ({
  ...(await orig<typeof import('@/lib/avatar-image')>()),
  prepareLogo: vi.fn(async () => new Blob(['webp'], { type: 'image/webp' })),
}))

import { SettingsProjectList } from '../project-list'
import { ProjectDangerTab } from '@/components/projects/settings/danger-tab'
import { ProjectGeneralTab } from '@/components/projects/settings/general-tab'
import { useAuthStore } from '@/stores/auth-store'

// jsdom has no ResizeObserver, and Radix measures with it in layout effects.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver

// An Admin's rail is cached under `/projects?scope=all`. A save or a delete on
// the project page has to reach that key, or the rail keeps the old name or the
// deleted project. The SWRConfig has no `provider` on purpose: the global
// `mutate` only reaches the default cache.

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
  id: 'b1',
  project_id: 'p1',
  logo_s3_key: null,
  logo_url: null,
  primary_color: null,
  secondary_color: null,
  custom_title: null,
  custom_footer: null,
  viewer_layout: 'grid',
  featured_field: null,
  use_cover_as_logo: false,
}

const LIST_KEY = '/projects?scope=all'
const listRequests = () => api.get.mock.calls.filter(([url]) => url === LIST_KEY).length

function renderWith(tab: React.ReactNode) {
  return render(
    <SWRConfig value={{ dedupingInterval: 0, shouldRetryOnError: false }}>
      <SettingsProjectList selectedId="p1" />
      {tab}
    </SWRConfig>,
  )
}

beforeEach(async () => {
  await act(async () => {
    await mutate(() => true, undefined, { revalidate: false })
  })
  api.get.mockReset().mockImplementation(async (url: string) => {
    if (url === LIST_KEY) return [PROJECT]
    if (url === '/projects/p1/branding') return BRANDING
    throw new Error(`unexpected GET ${url}`)
  })
  api.patch.mockReset().mockImplementation(async (_url: string, body: object) => ({ ...PROJECT, ...body }))
  api.put.mockReset().mockResolvedValue(BRANDING)
  api.delete.mockReset().mockResolvedValue(undefined)
  push.mockReset()
  useAuthStore.setState({
    user: { id: 'admin', name: 'Admin', email: 'a@example.com', is_superadmin: true } as never,
    isSuperAdmin: true,
  })
})

afterEach(() => {
  useAuthStore.setState({ user: null, isSuperAdmin: false } as never)
})

describe("an Admin's project list", () => {
  it('is asked for again after a delete', async () => {
    renderWith(<ProjectDangerTab projectId="p1" projectName="Launch film" />)
    await screen.findByRole('list')
    expect(listRequests()).toBe(1)

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete project' })[0])
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText(/Type Launch film to confirm/), {
      target: { value: 'Launch film' },
    })
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete project' }))
    })

    expect(api.delete).toHaveBeenCalledWith('/projects/p1')
    expect(listRequests()).toBe(2)
  })

  it('is asked for again after a save', async () => {
    renderWith(<ProjectGeneralTab project={PROJECT} />)
    await screen.findByRole('list')
    await screen.findByLabelText('Primary colour hex')
    expect(listRequests()).toBe(1)

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Launch film v2' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    })

    expect(api.patch).toHaveBeenCalledWith('/projects/p1', { name: 'Launch film v2' })
    expect(listRequests()).toBe(2)
  })
})
