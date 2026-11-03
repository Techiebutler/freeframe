import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SWRConfig, unstable_serialize } from 'swr'
import { afterEach, expect, it, vi } from 'vitest'
import HandinPage from '@/app/(dashboard)/handin/page'
import { api, ApiError } from '@/lib/api'

const { startUpload, cancelUpload, store } = vi.hoisted(() => ({ startUpload: vi.fn(() => 'u1'), cancelUpload: vi.fn(), store: { files: [{ id: 'u1', status: 'cancelled' }] as { id: string; status: string; assetId?: string }[] } }))
vi.mock('@/lib/iterations', () => ({ partsEnabled: false }))
vi.mock('@/hooks/use-page-title', () => ({ usePageTitle: vi.fn() }))
vi.mock('@/stores/auth-store', () => ({ useAuthStore: (select: (state: unknown) => unknown) => select({ user: { id: 'owner', is_staff: true } }) }))
vi.mock('@/lib/handin', async (original) => ({ ...await original<typeof import('@/lib/handin')>(), GATE_BASE: '', isHandinConfigured: () => true, lookUpCard: vi.fn().mockResolvedValue({ name: 'Launch' }) }))
vi.mock('@/lib/api', async (original) => ({ ...await original<typeof import('@/lib/api')>(), api: { get: vi.fn().mockImplementation((path: string) => Promise.resolve(path === '/projects' ? [{ id: 'p', name: 'Forward', is_workspace: true }] : [{ id: 'old-folder', description: 'https://trello.com/c/AbCd1234' }])), post: vi.fn() } }))
vi.mock('../workspace-picker', () => ({ WorkspacePicker: ({ onChange }: { onChange: (x: unknown) => void }) => <button type="button" onClick={() => onChange({ kind: 'existing', id: 'p', name: 'Forward' })}>Pick workspace</button> }))
vi.mock('@/components/upload/upload-zone', () => ({ UploadZone: ({ onFilesSelected }: { onFilesSelected: (f: File[]) => void }) => <button type="button" onClick={() => onFilesSelected(store.files.map((f, i) => new File(['v'], `cut${i}.mp4`)))}>Pick video</button> }))
vi.mock('@/stores/upload-store', () => { const state = { get files() { return store.files }, startUpload, cancelUpload }; return { useUploadStore: Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state, subscribe: () => () => {} }) } })
afterEach(() => { cleanup(); vi.clearAllMocks(); store.files = [{ id: 'u1', status: 'cancelled' }]; startUpload.mockReset(); startUpload.mockReturnValue('u1') })

it('does not submit when an upload is cancelled mid hand-in', async () => {
  vi.mocked(api.post).mockImplementation(async (path: string) => {
    if (path === '/checklists') throw new ApiError(503, 'Preparation unavailable')
    return { url: '/r/editor', share_url: '/share/review', review_share_token: 'review' } as never
  })
  render(<SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}><HandinPage /></SWRConfig>)
  fireEvent.click(screen.getByRole('button', { name: 'Pick workspace' }))
  fireEvent.click(screen.getByRole('button', { name: 'Pick video' }))
  fireEvent.change(screen.getByLabelText('Trello card link'), { target: { value: 'https://trello.com/c/AbCd1234' } })
  fireEvent.click(screen.getByRole('button', { name: 'Hand in' }))
  expect(await screen.findByText(/Hand-in cancelled\. Nothing was submitted/)).toBeVisible()
  const calls = vi.mocked(api.post).mock.calls.map(([p]) => p)
  expect(calls).toContain('/folders/old-folder/editor-request?adopt=false')
  expect(calls).not.toContain('/folders/old-folder/editor-request')
  expect(cancelUpload).toHaveBeenCalledWith('u1')
})

it('never claims nothing was submitted when a sibling already arrived, and leaves that sibling alone', async () => {
  store.files = [{ id: 'u1', status: 'cancelled' }, { id: 'u2', status: 'processing', assetId: 'a2' }, { id: 'u3', status: 'uploading' }]
  startUpload.mockReturnValueOnce('u1').mockReturnValueOnce('u2').mockReturnValueOnce('u3')
  vi.mocked(api.post).mockImplementation(async (path: string) => {
    if (path === '/checklists') throw new ApiError(503, 'Preparation unavailable')
    return { url: '/r/editor', share_url: '/share/review', review_share_token: 'review' } as never
  })
  render(<SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}><HandinPage /></SWRConfig>)
  fireEvent.click(screen.getByRole('button', { name: 'Pick workspace' }))
  fireEvent.click(screen.getByRole('button', { name: 'Pick video' }))
  fireEvent.change(screen.getByLabelText('Trello card link'), { target: { value: 'https://trello.com/c/AbCd1234' } })
  fireEvent.click(screen.getByRole('button', { name: 'Hand in' }))
  expect(await screen.findByText(/Hand-in cancelled\. 1 file had already arrived and stays on this card/)).toBeVisible()
  expect(cancelUpload).toHaveBeenCalledWith('u1')
  expect(cancelUpload).toHaveBeenCalledWith('u3')
  expect(cancelUpload).not.toHaveBeenCalledWith('u2')
  expect(vi.mocked(api.post).mock.calls.map(([p]) => p)).not.toContain('/folders/old-folder/editor-request')
})

it('tells the editor that every file goes in one submission', () => {
  render(<SWRConfig value={{ provider: () => new Map() }}><HandinPage /></SWRConfig>)
  expect(screen.getByText(/Every file you add here goes in one submission/)).toBeVisible()
})
