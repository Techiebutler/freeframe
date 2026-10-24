/**
 * Uploading a folder from the project page, by dropping it or picking it.
 *
 * Before: a dropped folder reached the queue as the single placeholder `File`
 * Chrome puts in `dataTransfer.files` for it, which failed at its turn with
 * "The file changed or was moved after it was added. Add it again.", and its
 * contents were never read. The Upload button opened a dialog with no way to
 * pick a folder, under copy that said folders could be dragged in.
 *
 * Now the folder is walked, its folders are made under the folder on screen,
 * and each file is queued into its own. The Upload button is a menu of Upload
 * files and Upload folder.
 *
 * Everything but the page, the drop region, the menu, the drop orchestration
 * and the upload store is replaced.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, createEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const project = { id: 'p1', name: 'Launch film', is_public: false }

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'p1' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams('folder=f-here'),
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
  useAuthStore: storeHook({ user: { id: 'u1', name: 'Editor' }, userFetched: true }),
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
// The grid stands in as a box inside the drop region, with the page's toolbar
// actions and the empty state's Upload button.
vi.mock('@/components/projects/asset-grid', () => ({
  AssetGrid: (p: { actions?: React.ReactNode; onUpload?: () => void }) => (
    <div data-testid="grid">
      {p.actions}
      {p.onUpload && <button onClick={p.onUpload}>Upload your first asset</button>}
    </div>
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
import { api } from '@/lib/api'
import { useUploadStore, __uploadQueueTesting as testing } from '@/stores/upload-store'
import { signInAs } from '@/test/upload-session'
import { folderDrop } from '@/test/folder-drop'

function giveEverythingABox() {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(
    { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect,
  )
}

function dropOn(el: Element, dataTransfer: object) {
  const event = createEvent.drop(el, { dataTransfer })
  Object.defineProperty(event, 'clientX', { value: 100 })
  Object.defineProperty(event, 'clientY', { value: 100 })
  fireEvent(el, event)
}

type EnsureBody = { parent_id: string | null; paths: string[][] }
const ensureBodies = () =>
  vi.mocked(api.post).mock.calls
    .filter(([path]) => path === '/projects/p1/folders/ensure')
    .map(([, body]) => body as EnsureBody)
const rows = () => useUploadStore.getState().files
const page = () => (
  <ToastProvider>
    <ProjectDetailPage />
  </ToastProvider>
)

beforeEach(() => {
  vi.clearAllMocks()
  testing.reset()
  window.localStorage.clear()
  useUploadStore.setState({ files: [], dropNotes: [], panelOpen: false })
  signInAs('u1')
  giveEverythingABox()
  vi.mocked(api.post).mockImplementation(((path: string, body?: unknown) => {
    if (path === '/projects/p1/folders/ensure') {
      const b = body as EnsureBody
      return Promise.resolve({ folders: b.paths.map((p) => ({ path: p, folder_id: `id:${p.join('/')}` })) })
    }
    // Initiates never answer: the rows stay in the queue for the test to read.
    return new Promise(() => {})
  }) as never)
})

afterEach(() => {
  vi.restoreAllMocks()
  testing.reset()
})

describe('dropping a folder on the project page', () => {
  it('uploads the folder’s files into a folder of the same name, never the folder itself', async () => {
    render(page())
    const drop = folderDrop('Shoot', ['a.mov', 'b.wav'])

    dropOn(screen.getByTestId('grid'), drop.dataTransfer)
    drop.expire()

    await waitFor(() => expect(rows().map((r) => r.fileName).sort()).toEqual(['a.mov', 'b.wav']))
    expect(ensureBodies()).toEqual([{ parent_id: 'f-here', paths: [['Shoot']] }])
    for (const r of rows()) expect(testing.folderOf(r.id)).toBe('id:Shoot')
    expect(rows().map((r) => r.fileName)).not.toContain('Shoot')
  })
})

describe('the Upload button', () => {
  it('is a menu of Upload files and Upload folder, with no upload dialog', async () => {
    render(page())

    await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

    expect(screen.getByRole('menuitem', { name: /Upload files/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /Upload folder/ })).toBeInTheDocument()
    expect(screen.queryByText('Upload asset')).toBeNull()
    expect(screen.queryByText(/Drag files and folders/)).toBeNull()
  })

  it('starts a picked folder at once, into the folder on screen', async () => {
    render(page())
    const a = new File([new Uint8Array(4)], 'a.mov')
    Object.defineProperty(a, 'webkitRelativePath', { value: 'Shoot/Day 1/a.mov' })
    const input = screen.getByTestId('upload-folder-input')
    Object.defineProperty(input, 'files', { value: [a], configurable: true })

    fireEvent.change(input)

    await waitFor(() => expect(rows().map((r) => r.fileName)).toEqual(['a.mov']))
    expect(ensureBodies()).toEqual([{ parent_id: 'f-here', paths: [['Shoot', 'Day 1']] }])
    expect(testing.folderOf(rows()[0].id)).toBe('id:Shoot/Day 1')
    expect(rows()[0].fileType).toBe('video/quicktime')
  })

  it('opens the same menu from the empty state’s Upload button', async () => {
    render(page())

    await userEvent.click(screen.getByRole('button', { name: 'Upload your first asset' }))

    expect(await screen.findByRole('menuitem', { name: /Upload folder/ })).toBeInTheDocument()
  })
})
