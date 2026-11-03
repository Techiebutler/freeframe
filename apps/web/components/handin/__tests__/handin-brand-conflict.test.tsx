import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SWRConfig, unstable_serialize } from 'swr'
import { afterEach, expect, it, vi } from 'vitest'
import HandinPage from '@/app/(dashboard)/handin/page'
import { api, ApiError } from '@/lib/api'

const { startUpload } = vi.hoisted(() => ({ startUpload: vi.fn(() => 'pending') }))
vi.mock('@/lib/iterations', () => ({ partsEnabled: false }))
vi.mock('@/hooks/use-page-title', () => ({ usePageTitle: vi.fn() }))
vi.mock('@/stores/auth-store', () => ({ useAuthStore: (select: (state: unknown) => unknown) => select({ user: { id: 'owner', is_staff: true } }) }))
vi.mock('@/lib/handin', async (original) => ({ ...await original<typeof import('@/lib/handin')>(), GATE_BASE: '', isHandinConfigured: () => true, lookUpCard: vi.fn().mockResolvedValue({ name: 'Launch' }) }))
vi.mock('@/lib/api', async (original) => ({ ...await original<typeof import('@/lib/api')>(), api: { get: vi.fn().mockImplementation((path: string) => Promise.resolve(path === '/projects' ? [{ id: 'p', name: 'Forward', is_workspace: true }] : [{ id: 'old-folder', description: 'https://trello.com/c/AbCd1234' }])), post: vi.fn() } }))
vi.mock('../workspace-picker', () => ({ WorkspacePicker: ({ onChange }: { onChange: (x: unknown) => void }) => <button type="button" onClick={() => onChange({ kind: 'existing', id: 'p', name: 'Forward' })}>Pick workspace</button> }))
vi.mock('@/components/upload/upload-zone', () => ({ UploadZone: ({ onFilesSelected }: { onFilesSelected: (f: File[]) => void }) => <button type="button" onClick={() => onFilesSelected([new File(['v'], 'cut.mp4')])}>Pick video</button> }))
vi.mock('@/stores/upload-store', () => { const state = { files: [], startUpload }; return { useUploadStore: Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state, subscribe: () => () => {} }) } })
afterEach(() => {
  cleanup(); vi.clearAllMocks()
})

function prepare(status: number, fallback: Record<string, unknown> = {}) {
  vi.mocked(api.post).mockRejectedValue(new ApiError(status, status === 409 ? 'Assignment already has a different brief; create a new request' : 'Preparation unavailable'))
  render(<SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false, fallback }}><HandinPage /></SWRConfig>)
  fireEvent.click(screen.getByRole('button', { name: 'Pick workspace' }))
  fireEvent.click(screen.getByRole('button', { name: 'Pick video' }))
  fireEvent.change(screen.getByLabelText('Trello card link'), { target: { value: 'https://trello.com/c/AbCd1234' } })
}

it('shows a confirmed conflict before uploading to an existing legacy folder', async () => {
  prepare(409)
  fireEvent.click(screen.getByRole('button', { name: 'Hand in' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Hand in' })).toBeEnabled())
  expect(screen.getByRole('alert')).toHaveTextContent('create a new request')
  expect(screen.queryByText(/can still upload/i)).toBeNull()
  expect(startUpload).not.toHaveBeenCalled()
})

it('preserves upload fallback when optional preparation is unavailable', async () => {
  prepare(503)
  vi.mocked(api.post).mockImplementation(async path => {
    if (path === '/checklists') throw new ApiError(503, 'Preparation unavailable')
    return { url: '/r/editor', share_url: '/share/review', review_share_token: 'review' } as never
  })
  fireEvent.click(screen.getByRole('button', { name: 'Hand in' }))
  await waitFor(() => expect(startUpload).toHaveBeenCalledOnce())
  const preflight = vi.mocked(api.post).mock.calls.findIndex(([path]) => path === '/folders/old-folder/editor-request?adopt=false')
  expect(preflight).toBeGreaterThanOrEqual(0)
  expect(vi.mocked(api.post).mock.invocationCallOrder[preflight]).toBeLessThan(startUpload.mock.invocationCallOrder[0])
  expect(await screen.findByText('Checklist unavailable. You can still upload.')).toBeVisible()
})

it('retains a known conflict when a later preparation attempt is unavailable', async () => {
  prepare(409)
  await screen.findByText('Assignment already has a different brief; create a new request')
  vi.mocked(api.post).mockRejectedValue(new ApiError(503, 'Preparation unavailable'))
  fireEvent.click(screen.getByRole('button', { name: 'Hand in' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Hand in' })).toBeEnabled())
  expect(screen.getByRole('alert')).toHaveTextContent('create a new request')
  expect(startUpload).not.toHaveBeenCalled()
})

it('retains a known conflict after a manual retry encounters an outage', async () => {
  prepare(409)
  await screen.findByText('Assignment already has a different brief; create a new request')
  vi.mocked(api.post).mockRejectedValue(new ApiError(503, 'Preparation unavailable'))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })) })
  fireEvent.click(screen.getByRole('button', { name: 'Hand in' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Hand in' })).toBeEnabled())
  expect(screen.getByRole('alert')).toHaveTextContent('create a new request')
  expect(screen.queryByText(/can still upload/i)).toBeNull()
  expect(startUpload).not.toHaveBeenCalled()
})

it('shows a new conflict even when an earlier prepared checklist is cached', async () => {
  prepare(409, { [unstable_serialize(['prepare-checklist', 'p', 'AbCd1234'])]: {
    id: 'binding', status: 'queued', requirements: [], limitations: [],
  } })
  expect(await screen.findByText('Assignment already has a different brief; create a new request')).toBeVisible()
  expect(screen.queryByText(/can still upload/i)).toBeNull()
})

it.each([409,503])('stops an initial preparation outage before uploading to an unverified folder (%s)', async status => {
  prepare(503)
  vi.mocked(api.post).mockImplementation(async path => {
    throw new ApiError(path === '/checklists' ? 503 : status,
      path === '/checklists' ? 'Preparation unavailable' : 'Folder assignment could not be verified')
  })
  fireEvent.click(screen.getByRole('button', { name: 'Hand in' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Hand in' })).toBeEnabled())
  expect(screen.getByRole('alert')).toHaveTextContent('Folder assignment could not be verified')
  expect(screen.queryByText(/can still upload/i)).toBeNull()
  expect(startUpload).not.toHaveBeenCalled()
})
