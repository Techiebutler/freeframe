/**
 * The project page toolbar's way into project settings.
 *
 * The owner's Members button used to open a dialog over the grid; it now opens
 * the settings page on its People tab, with a Settings button beside it for
 * the rest. Only the owner gets them, as only the owner can use the page.
 *
 * Everything but the page is replaced, as in drop-no-session.test.tsx; the
 * grid stands in as the toolbar actions it is handed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

const project = { id: 'p1', name: 'Launch film', is_public: false }

const { state } = vi.hoisted(() => ({ state: { role: 'owner' } }))

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'p1' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('swr', () => ({
  default: (key: string | null) => ({
    data: typeof key !== 'string' ? undefined
      : key === '/projects/p1' ? project
      : key === '/projects/p1/members' ? [{ user_id: 'u1', role: state.role }]
      : key.startsWith('/projects/p1/assets') ? []
      : key.startsWith('/projects/p1/folders') ? []
      : undefined,
    isLoading: false,
    mutate: vi.fn(),
  }),
  mutate: vi.fn(),
}))
const { storeHook } = vi.hoisted(() => ({
  storeHook: (s: Record<string, unknown>) =>
    (selector?: (x: Record<string, unknown>) => unknown) =>
      (typeof selector === 'function' ? selector(s) : s),
}))
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: storeHook({ user: { id: 'u1', name: 'Someone' } }),
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
  api: { get: vi.fn().mockResolvedValue([]), post: vi.fn(), patch: vi.fn() },
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

import ProjectDetailPage from '../page'
import { ToastProvider } from '@/components/shared/toast'

function renderPage() {
  render(
    <ToastProvider>
      <ProjectDetailPage />
    </ToastProvider>,
  )
}

beforeEach(() => {
  state.role = 'owner'
})

describe('the project toolbar', () => {
  it("links the owner's Members button to the People tab, and Settings to the page", () => {
    renderPage()
    expect(screen.getByRole('link', { name: 'Members' })).toHaveAttribute('href', '/projects/p1/settings?tab=people')
    expect(screen.getByRole('link', { name: 'Project settings' })).toHaveAttribute('href', '/projects/p1/settings')
  })

  it('shows neither to anyone else', () => {
    state.role = 'editor'
    renderPage()
    expect(screen.queryByRole('link', { name: 'Members' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Project settings' })).toBeNull()
  })
})
