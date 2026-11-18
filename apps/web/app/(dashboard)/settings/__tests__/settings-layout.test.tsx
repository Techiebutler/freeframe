import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'

// The settings shell: a row of section tabs (Instance for an Admin only), a
// rail for the open section, and the page. On a phone the project list is the
// page until a project is picked, so the rail and the page are never both there.

const nav = vi.hoisted(() => ({ pathname: '/settings/profile', params: {} as { id?: string } }))

vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useParams: () => nav.params,
}))
vi.mock('@/components/settings/project-list', () => ({
  SettingsProjectList: ({ selectedId }: { selectedId?: string }) => (
    <div data-testid="project-list" data-selected={selectedId ?? ''} />
  ),
}))

import SettingsLayout from '../layout'
import { useAuthStore } from '@/stores/auth-store'

function renderAt(pathname: string, params: { id?: string } = {}) {
  nav.pathname = pathname
  nav.params = params
  return render(
    <SettingsLayout>
      <div>page</div>
    </SettingsLayout>,
  )
}

const sections = () => screen.getByRole('navigation', { name: 'Settings sections' })

beforeEach(() => {
  useAuthStore.setState({ isSuperAdmin: false })
})
afterEach(() => {
  useAuthStore.setState({ isSuperAdmin: false })
})

describe('the section tabs', () => {
  it('shows a normal user Account and Projects, and no Instance', () => {
    renderAt('/settings/profile')
    expect(within(sections()).getByRole('link', { name: 'Account' })).toHaveAttribute('href', '/settings/profile')
    expect(within(sections()).getByRole('link', { name: 'Projects' })).toHaveAttribute('href', '/settings/projects')
    expect(within(sections()).queryByRole('link', { name: 'Instance' })).toBeNull()
  })

  it('shows an Admin all three', () => {
    useAuthStore.setState({ isSuperAdmin: true })
    renderAt('/settings/profile')
    expect(within(sections()).getAllByRole('link').map((l) => l.textContent)).toEqual([
      'Account',
      'Instance',
      'Projects',
    ])
    expect(within(sections()).getByRole('link', { name: 'Instance' })).toHaveAttribute(
      'href',
      '/settings/instance/users',
    )
  })

  it('marks the section of the path as current, and only that one', () => {
    useAuthStore.setState({ isSuperAdmin: true })
    renderAt('/settings/instance/storage')
    expect(within(sections()).getByRole('link', { name: 'Instance' })).toHaveAttribute('aria-current', 'page')
    expect(within(sections()).getByRole('link', { name: 'Account' })).not.toHaveAttribute('aria-current')
    expect(within(sections()).getByRole('link', { name: 'Projects' })).not.toHaveAttribute('aria-current')
  })

  it('has one fixed link back to the projects list', () => {
    renderAt('/settings/projects/p1', { id: 'p1' })
    expect(screen.getByRole('link', { name: 'Back to projects' })).toHaveAttribute('href', '/projects')
  })
})

describe('the rail', () => {
  it('lists the four Instance pages for an Admin, the open one current', () => {
    useAuthStore.setState({ isSuperAdmin: true })
    const { container } = renderAt('/settings/instance/storage')
    const rail = within(container.querySelector('aside') as HTMLElement)
    expect(rail.getAllByRole('link').map((l) => l.textContent)).toEqual([
      'Users',
      'Storage',
      'Instance settings',
      'Branding',
    ])
    expect(rail.getByRole('link', { name: 'Storage' })).toHaveAttribute('aria-current', 'page')
    expect(rail.getByRole('link', { name: 'Users' })).not.toHaveAttribute('aria-current')
  })

  it('draws no Instance rail for someone who is not an Admin', () => {
    const { container } = renderAt('/settings/instance/users')
    expect(container.querySelector('aside')).toBeNull()
  })

  it('lists Profile, Appearance and Notifications under Account', () => {
    const { container } = renderAt('/settings/appearance')
    const rail = within(container.querySelector('aside') as HTMLElement)
    expect(rail.getAllByRole('link').map((l) => l.textContent)).toEqual([
      'Profile',
      'Appearance',
      'Notifications',
    ])
    expect(rail.getByRole('link', { name: 'Appearance' })).toHaveAttribute('aria-current', 'page')
  })
})

describe('the phone: list or page, never both', () => {
  const classes = (el: Element | null) => (el?.className ?? '').split(/\s+/)

  it('/settings/projects shows the list and hides the page', () => {
    const { container } = renderAt('/settings/projects')
    expect(screen.getByTestId('project-list')).toHaveAttribute('data-selected', '')
    expect(classes(container.querySelector('aside'))).not.toContain('hidden')
    expect(classes(container.querySelector('main'))).toContain('hidden')
    expect(classes(container.querySelector('main'))).toContain('md:block')
  })

  it('/settings/projects/p1 hides the list and shows the page', () => {
    const { container } = renderAt('/settings/projects/p1', { id: 'p1' })
    expect(screen.getByTestId('project-list')).toHaveAttribute('data-selected', 'p1')
    expect(classes(container.querySelector('aside'))).toContain('hidden')
    expect(classes(container.querySelector('aside'))).toContain('md:block')
    expect(classes(container.querySelector('main'))).not.toContain('hidden')
  })

  it('keeps the page visible next to the Account rail', () => {
    const { container } = renderAt('/settings/profile')
    expect(classes(container.querySelector('main'))).not.toContain('hidden')
  })
})
