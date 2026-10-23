/**
 * A folder write the server refuses says why (#527).
 *
 * Restoring a trashed folder whose name was taken meanwhile, or creating a
 * folder next to one of the same name, answers 409 with a message. The page
 * used to await these calls bare, so a refusal disappeared as an unhandled
 * rejection and nothing on screen changed. Now the message is a toast.
 *
 * Everything but the page, the name dialog and the toasts is replaced.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const project = { id: 'p1', name: 'Launch film', is_public: false }

const { folders, storeHook } = vi.hoisted(() => ({
  folders: {
    createFolder: vi.fn(),
    restoreFolder: vi.fn(),
    restoreAsset: vi.fn(),
  },
  storeHook: (state: Record<string, unknown>) =>
    (selector?: (s: Record<string, unknown>) => unknown) =>
      (typeof selector === 'function' ? selector(state) : state),
}))

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
      : key.startsWith('/projects/p1/assets') ? []
      : key.startsWith('/projects/p1/folders') ? []
      : undefined,
    isLoading: false,
    mutate: vi.fn(),
  }),
  mutate: vi.fn(),
}))
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: storeHook({ user: { id: 'u1', name: 'Editor' } }),
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
    tree: [], mutateTree: vi.fn(), renameFolder: vi.fn(), moveFolder: vi.fn(),
    deleteFolder: vi.fn(), moveAsset: vi.fn(), bulkMove: vi.fn(), ...folders,
  }),
  useTrash: () => ({
    trash: {
      folders: [{ id: 'f-old', name: 'Dailies', type: 'folder', parent_id: 'f-a', deleted_at: '2026-10-01T00:00:00Z' }],
      assets: [{ id: 'a-old', name: 'clip.mov', type: 'video', folder_id: null, deleted_at: '2026-10-01T00:00:00Z' }],
    },
    mutateTrash: vi.fn(),
  }),
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
vi.mock('@/components/projects/asset-grid', () => ({ AssetGrid: () => null }))
vi.mock('@/components/review/comment-panel', () => ({ CommentPanel: () => null }))
// The tree stands in as the one control these tests need from it.
vi.mock('@/components/projects/folder-tree', () => ({
  FolderTree: ({ onShowTrash }: { onShowTrash: () => void }) => (
    <button onClick={onShowTrash}>Recently Deleted</button>
  ),
}))
vi.mock('@/components/projects/share-links-table', () => ({ ShareLinksTable: () => null }))
vi.mock('@/components/projects/share-link-detail', () => ({
  ShareLinkContent: () => null,
  ShareLinkSettingsPanel: () => null,
}))
vi.mock('@/components/projects/share-create-dialog', () => ({ ShareCreateDialog: () => null }))
vi.mock('@/components/projects/project-members-dialog', () => ({ ProjectMembersDialog: () => null }))

import ProjectDetailPage from '../page'
import { ToastProvider } from '@/components/shared/toast'
import { ApiError } from '@/lib/api'

function renderPage() {
  render(
    <ToastProvider>
      <ProjectDetailPage />
    </ToastProvider>,
  )
}

/** The Restore button on the trash row named `name`. */
function restoreButtonFor(name: string) {
  const row = screen.getByText(name).closest('div.flex.items-center.justify-between')
  if (!row) throw new Error(`no trash row for ${name}`)
  return row.querySelector('button') as HTMLButtonElement
}

beforeEach(() => {
  folders.createFolder.mockReset()
  folders.restoreFolder.mockReset()
  folders.restoreAsset.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('folder writes the server refuses', () => {
  it('restoring a folder whose name was taken shows the server message', async () => {
    folders.restoreFolder.mockRejectedValue(
      new ApiError(409, "A folder named 'Dailies' already exists here"),
    )
    renderPage()
    fireEvent.click(screen.getByText('Recently Deleted'))

    fireEvent.click(restoreButtonFor('Dailies'))

    expect(await screen.findByText("A folder named 'Dailies' already exists here")).toBeTruthy()
    expect(folders.restoreFolder).toHaveBeenCalledWith('f-old')
  })

  it('restoring an asset the purge removed shows the server message', async () => {
    folders.restoreAsset.mockRejectedValue(new ApiError(404, 'Deleted asset not found'))
    renderPage()
    fireEvent.click(screen.getByText('Recently Deleted'))

    fireEvent.click(restoreButtonFor('clip.mov'))

    expect(await screen.findByText('Deleted asset not found')).toBeTruthy()
  })

  it('a refusal with no server message still says the folder was not restored', async () => {
    folders.restoreFolder.mockRejectedValue(new TypeError('Failed to fetch'))
    renderPage()
    fireEvent.click(screen.getByText('Recently Deleted'))

    fireEvent.click(restoreButtonFor('Dailies'))

    expect(await screen.findByText('Could not restore the folder')).toBeTruthy()
  })

  it('creating a folder next to one of the same name shows the server message', async () => {
    folders.createFolder.mockRejectedValue(
      new ApiError(409, "A folder named 'Dailies' already exists here"),
    )
    renderPage()
    fireEvent.click(screen.getByTitle('New folder'))

    fireEvent.change(screen.getByPlaceholderText('Folder name'), { target: { value: 'Dailies' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    expect(await screen.findByText("A folder named 'Dailies' already exists here")).toBeTruthy()
    await waitFor(() => expect(folders.createFolder).toHaveBeenCalledWith('Dailies', null))
  })
})
