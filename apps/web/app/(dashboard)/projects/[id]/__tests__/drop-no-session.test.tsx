/**
 * Dropping files on a project page after the session ended in another tab.
 *
 * An upload belongs to the account whose token added it (spec goal 9). With no
 * token there is nobody to own it, so the drop is refused at once: no row is
 * created and nothing reaches the server. The page says so once for the whole
 * drop, not once per file.
 *
 * Everything but the page, the drop region and the upload store is replaced.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, createEvent } from '@testing-library/react'

const project = { id: 'p1', name: 'Launch film', is_public: false }

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
const { storeHook } = vi.hoisted(() => ({
  storeHook: (state: Record<string, unknown>) =>
    (selector?: (s: Record<string, unknown>) => unknown) =>
      (typeof selector === 'function' ? selector(state) : state),
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
// The page's grid stands in as a plain box inside the drop region.
vi.mock('@/components/projects/asset-grid', () => ({
  AssetGrid: () => <div data-testid="grid" />,
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
import { api } from '@/lib/api'
import { useUploadStore, __uploadQueueTesting as testing } from '@/stores/upload-store'
import { signOutElsewhere } from '@/test/upload-session'

/** jsdom measures everything as zero; the drop region checks the release point against its box. */
function giveEverythingABox() {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(
    { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect,
  )
}

/** Drops `files` on `el` with the pointer inside the box. jsdom has no DragEvent. */
function dropFiles(el: Element, files: File[]) {
  const event = createEvent.drop(el, { dataTransfer: { types: ['Files'], files, dropEffect: 'none' } })
  Object.defineProperty(event, 'clientX', { value: 100 })
  Object.defineProperty(event, 'clientY', { value: 100 })
  fireEvent(el, event)
}

beforeEach(() => {
  testing.reset()
  window.localStorage.clear()
  useUploadStore.setState({ files: [], panelOpen: false })
  // Another tab signed out: there is no token in this one either.
  signOutElsewhere()
  giveEverythingABox()
})

afterEach(() => {
  vi.restoreAllMocks()
  testing.reset()
})

describe('a drop with no session', () => {
  it('dropping 5 files with no token shows exactly one "Sign in to upload" toast and creates no rows', () => {
    render(
      <ToastProvider>
        <ProjectDetailPage />
      </ToastProvider>,
    )
    const files = Array.from({ length: 5 }, (_, i) => new File([new Uint8Array(1)], `take-${i}.mov`, { type: 'video/quicktime' }))

    dropFiles(screen.getByTestId('grid'), files)

    expect(screen.getAllByText('Sign in to upload')).toHaveLength(1)
    expect(useUploadStore.getState().files).toEqual([])
    expect(useUploadStore.getState().panelOpen).toBe(false)
    expect(api.post).not.toHaveBeenCalled()
  })
})
