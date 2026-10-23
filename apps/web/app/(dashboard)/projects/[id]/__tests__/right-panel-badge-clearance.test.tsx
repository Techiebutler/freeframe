/**
 * The floating "Powered by FreeFrame" badge and the project page's right panel.
 *
 * The badge is fixed 1rem from the window's bottom-right corner on every
 * dashboard route but the asset viewer, and the right panel runs to that same
 * corner. Its last row is "Open in viewer to comment": measured at 1400x900,
 * `elementFromPoint` at the centre of that link returned the badge's anchor
 * (173x30 at 1211..1384, 854..884, over the link's 1053..1388, 850..888), so a
 * click on it opened the repository in a new tab (#526).
 *
 * jsdom cannot hit-test, so what is checked here is the reservation: the panel
 * keeps the badge's corner clear while the badge is shown, and not otherwise.
 *
 * Everything but the page is replaced, as in drop-no-session.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const project = { id: 'p1', name: 'Launch film', is_public: false }
const asset = {
  id: 'a1', name: 'Opening titles.png', project_id: 'p1', asset_type: 'image', folder_id: null,
  created_by: 'u1', created_at: '2026-01-01T00:00:00Z', latest_version: null, thumbnail_url: null,
}

const { branding } = vi.hoisted(() => ({ branding: { poweredByFreeframe: true } }))

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'p1' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('swr', () => ({
  default: (key: string | null) => ({
    data: typeof key !== 'string' ? undefined
      : key === '/projects/p1' ? project
      : key === '/projects/p1/members' ? [{ user_id: 'u1', role: 'editor' }]
      : key.startsWith('/projects/p1/assets') ? [asset]
      : key.startsWith('/projects/p1/folders') ? []
      : undefined,
    isLoading: false,
    mutate: vi.fn(),
  }),
  mutate: vi.fn(),
}))
const { storeHook } = vi.hoisted(() => ({
  storeHook: (state: Record<string, unknown>) =>
    (selector?: (s: Record<string, unknown>) => unknown) =>
      (typeof selector === 'function' ? selector(state) : state),
}))
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: storeHook({ user: { id: 'u1', name: 'Editor' } }),
}))
vi.mock('@/stores/view-store', () => ({
  useViewStore: storeHook({ rightPanelOpen: true, sortKey: 'custom', sortDirection: 'asc', viewMode: 'grid' }),
}))
vi.mock('@/stores/breadcrumb-store', () => ({
  useBreadcrumbStore: storeHook({ setExtraCrumbs: vi.fn(), setLabel: vi.fn() }),
}))
vi.mock('@/components/shared/branding-provider', async (orig) => ({
  ...(await orig<typeof import('@/components/shared/branding-provider')>()),
  useBranding: () => branding,
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
// The grid stands in as one button that selects the asset, as a click on its card does.
vi.mock('@/components/projects/asset-grid', () => ({
  AssetGrid: ({ assets, onAssetSelect }: {
    assets: unknown[]
    onAssetSelect: (a: unknown, e: React.MouseEvent) => void
  }) => (
    // The event is passed on: the page stops it, or the click on the area behind deselects.
    <button onClick={(e) => onAssetSelect(assets[0], e)}>select asset</button>
  ),
}))
vi.mock('@/components/review/comment-panel', () => ({ CommentPanel: () => null }))
vi.mock('@/components/projects/folder-tree', () => ({ FolderTree: () => null }))
vi.mock('@/components/projects/share-links-table', () => ({ ShareLinksTable: () => null }))
vi.mock('@/components/projects/share-link-detail', () => ({
  ShareLinkContent: () => null,
  ShareLinkSettingsPanel: () => null,
}))
vi.mock('@/components/projects/share-create-dialog', () => ({ ShareCreateDialog: () => null }))
vi.mock('@/components/projects/project-members-dialog', () => ({ ProjectMembersDialog: () => null }))

import ProjectDetailPage from '../page'
import { ToastProvider } from '@/components/shared/toast'

/** The right panel, found from the link in its last row. */
function openRightPanel() {
  render(
    <ToastProvider>
      <ProjectDetailPage />
    </ToastProvider>,
  )
  fireEvent.click(screen.getByText('select asset'))
  const link = screen.getByText('Open in viewer to comment')
  const panel = link.closest('.w-\\[360px\\]')
  if (!panel) throw new Error('no right panel around the link')
  return panel
}

const RESERVE = 'pb-[calc(3.5rem+env(safe-area-inset-bottom))]'

beforeEach(() => {
  branding.poweredByFreeframe = true
})

describe('the project page right panel under the floating credit', () => {
  it('keeps the badge corner clear while the badge is shown', () => {
    const panel = openRightPanel()

    expect(panel.className.split(/\s+/)).toContain(RESERVE)
  })

  it('reserves nothing when "Powered by FreeFrame" is turned off', () => {
    branding.poweredByFreeframe = false

    const panel = openRightPanel()

    expect(panel.className).not.toContain('safe-area-inset-bottom')
  })
})
