/**
 * An instance admin gets owner controls on a project it does not own.
 *
 * The server gives the Admin role owner rights on every live project and keeps
 * `role` saying what the caller's own membership is. Four surfaces used that
 * membership alone: the project page, card menu, settings page and asset review
 * page. All four now read `effectiveProjectRole`. The first three are checked
 * here against admins and people who must still be refused; asset review has
 * its own focused admin-review-controls.test.tsx regression.
 *
 * Everything but the screen under test is replaced, as in
 * toolbar-settings-links.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { Project } from '@/types'

const PROJECT = {
  id: 'p1',
  name: 'Launch film',
  description: null,
  created_by: 'someone-else',
  project_type: 'personal',
  created_at: '2026-01-01T00:00:00Z',
  deleted_at: null,
  is_public: false,
  poster_url: null,
} as const

const BRANDING = {
  id: 'b1', project_id: 'p1', logo_s3_key: null, logo_url: null, primary_color: null,
  secondary_color: null, custom_title: null, custom_footer: null, viewer_layout: 'grid',
  featured_field: null, use_cover_as_logo: false,
}

const { state } = vi.hoisted(() => ({
  state: {
    /** The role the API reports, which is the caller's real membership. */
    role: null as string | null,
    isSuperAdmin: false,
    user: { id: 'u1', name: 'Someone' },
    userFetched: true,
  },
}))

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'p1' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('swr', () => ({
  default: (key: string | null) => ({
    data: typeof key !== 'string' ? undefined
      : key === '/projects/p1' ? { ...PROJECT, role: state.role }
      : key === '/projects/p1/members' ? (state.role ? [{ user_id: 'u1', role: state.role }] : [])
      : key === '/projects/p1/branding' ? BRANDING
      : key.startsWith('/projects/p1/assets') ? []
      : key.startsWith('/projects/p1/folders') ? []
      : undefined,
    isLoading: false,
    mutate: vi.fn(),
  }),
  mutate: vi.fn(),
}))
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: (selector?: (s: typeof state) => unknown) =>
    typeof selector === 'function' ? selector(state) : state,
}))
const { storeHook } = vi.hoisted(() => ({
  storeHook: (s: Record<string, unknown>) =>
    (selector?: (x: Record<string, unknown>) => unknown) =>
      (typeof selector === 'function' ? selector(s) : s),
}))
vi.mock('@/stores/view-store', () => ({
  useViewStore: storeHook({ rightPanelOpen: false, sortKey: 'custom', sortDirection: 'asc', viewMode: 'grid' }),
}))
vi.mock('@/stores/breadcrumb-store', () => ({
  useBreadcrumbStore: storeHook({ setExtraCrumbs: vi.fn(), setLabel: vi.fn() }),
}))
vi.mock('@/hooks/use-comments', () => ({
  useComments: () => ({
    comments: [], resolveComment: vi.fn(), deleteComment: vi.fn(),
    addReaction: vi.fn(), removeReaction: vi.fn(), createComment: vi.fn(),
  }),
}))
vi.mock('@/hooks/use-folders', () => ({
  useFolders: () => ({
    tree: [], mutateTree: vi.fn(), createFolder: vi.fn(), renameFolder: vi.fn(), moveFolder: vi.fn(),
    deleteFolder: vi.fn(), moveAsset: vi.fn(), bulkMove: vi.fn(), restoreAsset: vi.fn(), restoreFolder: vi.fn(),
  }),
  useTrash: () => ({ trash: undefined, mutateTrash: vi.fn() }),
}))
vi.mock('@/hooks/use-share-links', () => ({
  useShareLinks: () => ({
    shareLinks: [], toggleEnabled: vi.fn(), deleteShareLink: vi.fn(),
    createFolderShare: vi.fn(), mutateShareLinks: vi.fn(),
  }),
}))
vi.mock('@/hooks/use-page-title', () => ({ usePageTitle: () => undefined }))
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  api: { get: vi.fn().mockResolvedValue([]), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn(), upload: vi.fn() },
}))
vi.mock('@/components/projects/asset-grid', () => ({
  AssetGrid: ({ actions }: { actions?: React.ReactNode }) => <div>{actions}</div>,
}))
vi.mock('@/components/review/comment-panel', () => ({ CommentPanel: () => null }))
vi.mock('@/components/projects/folder-tree', () => ({ FolderTree: () => null }))
vi.mock('@/components/projects/share-links-table', () => ({ ShareLinksTable: () => null }))
vi.mock('@/components/projects/share-link-detail', () => ({
  ShareLinkContent: () => null,
  ShareLinkSettingsPanel: () => null,
}))
vi.mock('@/components/projects/share-create-dialog', () => ({ ShareCreateDialog: () => null }))

import ProjectDetailPage from '../[id]/page'
import ProjectSettingsPage from '../[id]/settings/page'
import { useProjectMenu } from '@/components/projects/menus/project-menu'
import { ToastProvider } from '@/components/shared/toast'

// jsdom has no ResizeObserver, and Radix measures with it in layout effects.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver

/** The three cases the maintainer named, plus who must still be refused. */
const CASES: [name: string, role: string | null, isSuperAdmin: boolean, mayManage: boolean][] = [
  ['an admin that is not a member', null, true, true],
  ['an admin that is only a viewer', 'viewer', true, true],
  ['an admin that is only an editor', 'editor', true, true],
  ['a non-member without the flag', null, false, false],
  ['a viewer without the flag', 'viewer', false, false],
  ['the owner', 'owner', false, true],
]

beforeEach(() => {
  state.role = null
  state.isSuperAdmin = false
})

function apply(role: string | null, isSuperAdmin: boolean) {
  state.role = role
  state.isSuperAdmin = isSuperAdmin
}

describe('the project page toolbar', () => {
  it.each(CASES)('gives %s the owner buttons', (_name, role, isSuperAdmin, mayManage) => {
    apply(role, isSuperAdmin)
    render(
      <ToastProvider>
        <ProjectDetailPage />
      </ToastProvider>,
    )
    const members = screen.queryByRole('link', { name: 'Members' })
    const settings = screen.queryByRole('link', { name: 'Project settings' })
    expect(!!members).toBe(mayManage)
    expect(!!settings).toBe(mayManage)
  })
})

describe("the project card's menu", () => {
  function Probe({ onItems }: { onItems: (items: React.ReactNode) => void }) {
    onItems(useProjectMenu({ ...PROJECT, role: state.role } as Project, {}).items)
    return null
  }

  it.each(CASES)('offers %s the manage entries', (_name, role, isSuperAdmin, mayManage) => {
    apply(role, isSuperAdmin)
    let items: React.ReactNode = undefined
    render(<Probe onItems={(got) => { items = got }} />)
    expect(items !== null).toBe(mayManage)
  })
})

describe('the project settings page', () => {
  it.each(CASES)('unlocks the forms for %s', async (_name, role, isSuperAdmin, mayManage) => {
    apply(role, isSuperAdmin)
    render(<ProjectSettingsPage />)
    if (mayManage) {
      expect(await screen.findByRole('tab', { name: 'General' })).toBeInTheDocument()
      expect(screen.queryByText('Only the project owner can change settings.')).toBeNull()
    } else {
      expect(
        await screen.findByText('Only the project owner can change settings.'),
      ).toBeInTheDocument()
      expect(screen.queryByRole('tab')).toBeNull()
    }
  })
})
