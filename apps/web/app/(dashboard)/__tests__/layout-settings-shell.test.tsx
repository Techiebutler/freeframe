/**
 * On the settings pages the dashboard shell hands the whole window to the
 * page: no app sidebar, no header, no left margin for the sidebar. The page
 * draws its own "Back to projects" link and section tabs.
 *
 * The gate is the `/settings` path. A project's settings used to live at
 * `/projects/<id>/settings` and that route still has to look like a project
 * page, since it is a redirect there and a link to it must not hide the rail.
 *
 * The attribution badge stays on settings; the page reserves its corner.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

let pathname = '/projects/p1'

vi.mock('next/navigation', () => ({ usePathname: () => pathname }))
vi.mock('@/stores/auth-store', () => ({ useAuthStore: () => ({ fetchUser: vi.fn() }) }))
vi.mock('@/stores/upload-store', () => ({
  useUploadStore: (select?: (s: object) => unknown) => {
    const state = { fetchHistory: vi.fn(), files: [] }
    return select ? select(state) : state
  },
  visibleFiles: (s: { files: unknown[] }) => s.files,
  wouldStopOnLeave: () => false,
}))
vi.mock('@/components/layout/sidebar', () => ({ Sidebar: () => <div>rail</div> }))
vi.mock('@/components/layout/header', () => ({
  Header: () => <div data-testid="header">header</div>,
}))
vi.mock('@/components/layout/command-palette', () => ({ CommandPalette: () => null }))
vi.mock('@/components/layout/uploads-panel', () => ({ UploadsPanel: () => null }))
vi.mock('@/components/layout/upload-sse-bridge', () => ({ UploadSSEBridge: () => null }))
vi.mock('@/components/shared/powered-by-badge', () => ({
  PoweredByBadge: () => <a data-testid="floating-badge" href="/">Powered by FreeFrame</a>,
}))

import DashboardLayout from '../layout'

function renderAt(path: string) {
  pathname = path
  return render(
    <DashboardLayout>
      <div>page</div>
    </DashboardLayout>,
  )
}

const main = () => screen.getByText('page').closest('main') as HTMLElement

beforeEach(() => { pathname = '/projects/p1' })

describe('the shell on settings pages', () => {
  it.each(['/settings', '/settings/profile', '/settings/instance/users', '/settings/projects', '/settings/projects/p1'])(
    'draws no sidebar and no header at %s, keeps the badge, and takes no margin',
    (path) => {
      renderAt(path)

      expect(screen.queryByText('rail')).toBeNull()
      expect(screen.queryByTestId('header')).toBeNull()
      expect(screen.getByTestId('floating-badge')).toBeTruthy()
      const classes = main().className.split(/\s+/)
      expect(classes).toContain('ml-0')
      expect(classes).not.toContain('ml-[52px]')
      expect(classes).not.toContain('ml-[220px]')
    },
  )

  it.each(['/projects/p1', '/projects/p1/settings', '/projects', '/settings-archive'])(
    'still draws the sidebar and the header at %s',
    (path) => {
      renderAt(path)

      expect(screen.getByText('rail')).toBeTruthy()
      expect(screen.getByTestId('header')).toBeTruthy()
      expect(main().className.split(/\s+/)).toContain('ml-[52px]')
      expect(main().className.split(/\s+/)).not.toContain('ml-0')
    },
  )
})
