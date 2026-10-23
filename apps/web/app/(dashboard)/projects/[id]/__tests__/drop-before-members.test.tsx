/**
 * Dropping files on a project page before the page knows the user's role.
 *
 * The role comes from `GET /projects/{id}/members` and the signed-in user.
 * Until both have answered the page used to treat everyone as a viewer, so the
 * drop region was off and the shell refused the drop with a "not allowed"
 * cursor and nothing else (#520). Not knowing the role is not the same as
 * being a viewer: the drop is accepted and held, then started once the role
 * says the user may upload, or answered with one toast when it says they may
 * not. A 403 from the members request says the user is not a member, which is
 * an answer too: a public project lets them view, never upload. If the members
 * request fails any other way the drop goes to the queue, and the server's
 * answer to the upload decides it.
 *
 * Everything but the page, the drop region and the upload store is replaced.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, createEvent } from '@testing-library/react'

const project = { id: 'p1', name: 'Launch film', is_public: false }

// What the members request and the auth store have answered so far.
const { members, auth } = vi.hoisted(() => ({
  members: { data: undefined as unknown, error: undefined as unknown },
  auth: { user: null as { id: string; name: string } | null, userFetched: false },
}))

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'p1' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('swr', () => ({
  default: (key: string | null) =>
    key === '/projects/p1/members'
      ? { data: members.data, error: members.error, isLoading: members.data === undefined, mutate: vi.fn() }
      : {
          data: typeof key !== 'string' ? undefined
            : key === '/projects/p1' ? project
            : key.startsWith('/projects/p1/assets') ? []
            : key.startsWith('/projects/p1/folders') ? []
            : undefined,
          isLoading: false,
          mutate: vi.fn(),
        },
  mutate: vi.fn(),
}))
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: (selector?: (s: typeof auth) => unknown) =>
    (typeof selector === 'function' ? selector(auth) : auth),
}))
const { storeHook } = vi.hoisted(() => ({
  storeHook: (state: Record<string, unknown>) =>
    (selector?: (s: Record<string, unknown>) => unknown) =>
      (typeof selector === 'function' ? selector(state) : state),
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
  // An initiate that never answers: the row stays in the queue for the test to read.
  api: { get: vi.fn().mockResolvedValue([]), post: vi.fn(() => new Promise(() => {})), patch: vi.fn() },
}))
// The page's grid stands in as a plain box inside the drop region. It and the
// sidebar tree each show a folder that takes a file drop only when the page
// hands them a handler for one, the way the real folder cards and rows do.
const { folderDrop } = vi.hoisted(() => ({
  folderDrop: (label: string, onDrop?: (folderId: string, files: File[]) => void) =>
    onDrop ? (
      <button onClick={() => onDrop('f1', [new File([new Uint8Array(1)], `${label}.mov`)])}>{label}</button>
    ) : null,
}))
vi.mock('@/components/projects/asset-grid', () => ({
  AssetGrid: (p: { onDropFilesToFolder?: (folderId: string, files: File[]) => void }) => (
    <div data-testid="grid">{folderDrop('grid-folder', p.onDropFilesToFolder)}</div>
  ),
}))
vi.mock('@/components/review/comment-panel', () => ({ CommentPanel: () => null }))
vi.mock('@/components/projects/folder-tree', () => ({
  FolderTree: (p: { onDropFiles?: (folderId: string, files: File[]) => void }) =>
    folderDrop('sidebar-folder', p.onDropFiles),
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
import { useUploadStore, __uploadQueueTesting as testing } from '@/stores/upload-store'
import { ApiError } from '@/lib/api'
import { signInAs, signOutElsewhere } from '@/test/upload-session'

const NO_PERMISSION = "You don't have permission to upload to this project"
// A new element each time: `rerender` with the same one would skip the page.
const page = () => (
  <ToastProvider>
    <ProjectDetailPage />
  </ToastProvider>
)

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

const take = () => new File([new Uint8Array(1)], 'take-1.mov', { type: 'video/quicktime' })
const rowNames = () => useUploadStore.getState().files.map((f) => f.fileName)

beforeEach(() => {
  testing.reset()
  window.localStorage.clear()
  useUploadStore.setState({ files: [], panelOpen: false })
  signInAs('u1')
  members.data = undefined
  members.error = undefined
  auth.user = { id: 'u1', name: 'Editor' }
  auth.userFetched = true
  giveEverythingABox()
})

afterEach(() => {
  vi.restoreAllMocks()
  testing.reset()
})

describe('a drop before the role is known', () => {
  it('takes a file drag over the asset area while the members request is out', () => {
    render(page())
    const dataTransfer = { types: ['Files'], files: [], dropEffect: 'none' }
    const event = createEvent.dragOver(screen.getByTestId('grid'), { dataTransfer })

    fireEvent(screen.getByTestId('grid'), event)

    expect(event.defaultPrevented).toBe(true)
    expect(dataTransfer.dropEffect).toBe('copy')
  })

  it('holds the drop and starts it once the members say editor', () => {
    const { rerender } = render(page())
    dropFiles(screen.getByTestId('grid'), [take()])
    expect(rowNames()).toEqual([])

    members.data = [{ user_id: 'u1', role: 'editor' }]
    rerender(page())

    expect(rowNames()).toEqual(['take-1.mov'])
    expect(screen.queryByText(NO_PERMISSION)).toBeNull()
  })

  it('holds the drop while the user is still loading, then starts it', () => {
    auth.user = null
    auth.userFetched = false
    members.data = [{ user_id: 'u1', role: 'owner' }]
    const { rerender } = render(page())
    dropFiles(screen.getByTestId('grid'), [take()])
    expect(rowNames()).toEqual([])

    auth.user = { id: 'u1', name: 'Owner' }
    auth.userFetched = true
    rerender(page())

    expect(rowNames()).toEqual(['take-1.mov'])
  })

  it('answers a held drop with one toast and no rows once the members say viewer', () => {
    const { rerender } = render(page())
    dropFiles(screen.getByTestId('grid'), [take()])
    dropFiles(screen.getByTestId('grid'), [take()])

    members.data = [{ user_id: 'u1', role: 'viewer' }]
    rerender(page())

    expect(rowNames()).toEqual([])
    expect(screen.getAllByText(NO_PERMISSION)).toHaveLength(1)
  })

  it('hands a held drop to the queue when the members request fails, for the server to decide', () => {
    const { rerender } = render(page())
    dropFiles(screen.getByTestId('grid'), [take()])

    members.error = new Error('network')
    rerender(page())

    expect(rowNames()).toEqual(['take-1.mov'])
    expect(screen.queryByText(NO_PERMISSION)).toBeNull()
  })

  it('answers a held drop with one toast and no rows when the members request says not a member', () => {
    const { rerender } = render(page())
    dropFiles(screen.getByTestId('grid'), [take()])
    dropFiles(screen.getByTestId('grid'), [take()])

    // A public project: the user may view it, but is no member of it.
    members.error = new ApiError(403, 'Not a project member')
    rerender(page())

    expect(rowNames()).toEqual([])
    expect(screen.getAllByText(NO_PERMISSION)).toHaveLength(1)

    // The role is known now, so a later drag is refused like a viewer's.
    const dataTransfer = { types: ['Files'], files: [], dropEffect: 'none' }
    const event = createEvent.dragOver(screen.getByTestId('grid'), { dataTransfer })
    fireEvent(screen.getByTestId('grid'), event)
    expect(dataTransfer.dropEffect).not.toBe('copy')
    expect(screen.queryByText('grid-folder')).toBeNull()
    expect(screen.queryByText('sidebar-folder')).toBeNull()
  })

  it('answers a held drop with "Sign in to upload" when the user fetch ends with no user', () => {
    signOutElsewhere()
    auth.user = null
    auth.userFetched = false
    const { rerender } = render(page())
    dropFiles(screen.getByTestId('grid'), [take()])
    expect(screen.queryByText('Sign in to upload')).toBeNull()

    auth.userFetched = true
    rerender(page())

    expect(rowNames()).toEqual([])
    expect(screen.getAllByText('Sign in to upload')).toHaveLength(1)
  })

  it('holds drops on grid and sidebar folders too, then starts them once the members say editor', () => {
    const { rerender } = render(page())
    fireEvent.click(screen.getByText('grid-folder'))
    fireEvent.click(screen.getByText('sidebar-folder'))
    expect(rowNames()).toEqual([])

    members.data = [{ user_id: 'u1', role: 'editor' }]
    rerender(page())

    expect(rowNames().sort()).toEqual(['grid-folder.mov', 'sidebar-folder.mov'])
  })
})
