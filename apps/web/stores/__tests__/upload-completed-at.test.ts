/**
 * A finished row's "N minutes ago" counts from when it finished.
 *
 * `createdAt` is when the row was added, and a retry or a resume keeps it, so
 * counting from it said "25 minutes ago" for a file that waited 25 minutes in
 * the queue and uploaded in a second, and "3 days ago" for a three-day-old row
 * resumed and finished just now (listed under Today, since this page load
 * resumed it). Every move into `complete` records `completedAt`, and history
 * rows take the version's last activity, the last time a part was sent.
 *
 * The API is mocked but `ApiError` is the real one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  api: { post: vi.fn(), get: vi.fn(), patch: vi.fn() },
}))
vi.mock('swr', () => ({ mutate: vi.fn() }))

import { api } from '@/lib/api'
import { useUploadStore, __uploadQueueTesting as testing } from '../upload-store'
import { signInAs, row } from '@/test/upload-session'
import { MB, fakeServer, fileOf, drop, rowOf, settle } from '@/test/upload-queue-server'
import type { AssetResponse } from '@/types'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

beforeEach(() => {
  vi.clearAllMocks()
  testing.reset()
  window.localStorage.clear()
  useUploadStore.setState({ files: [], versionsRevision: 0, panelOpen: false })
  vi.mocked(api.get).mockResolvedValue([] as never)
  signInAs('user-1')
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  testing.reset()
})

describe('completedAt', () => {
  it('a file that waited 25 minutes and then uploaded records when it finished, not when it was added', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const added = new Date('2026-10-23T10:00:00Z').getTime()
    vi.setSystemTime(added)
    const server = fakeServer(() => 'wait')
    // Not media: `/upload/complete` makes it complete at once.
    const [id] = drop([fileOf('notes.txt', MB, 'text/plain')])
    await settle()

    vi.setSystemTime(added + 25 * MINUTE)
    server.initiates[0].resolve()
    await vi.waitFor(() => expect(rowOf(id).status).toBe('complete'))

    expect(rowOf(id).createdAt).toBeLessThan(added + MINUTE)
    expect(rowOf(id).completedAt).toBeGreaterThanOrEqual(added + 25 * MINUTE)
    expect(rowOf(id).completedAt).toBeLessThan(added + 26 * MINUTE)
  })

  it('a transcode that finishes records it, on a row added three days ago', () => {
    const now = Date.now()
    useUploadStore.setState({
      files: [row({ id: 'r', status: 'processing', assetId: 'ra', createdAt: now - 3 * DAY })],
    })

    useUploadStore.getState().markProcessingComplete('ra')

    expect(rowOf('r').status).toBe('complete')
    expect(rowOf('r').completedAt).toBeGreaterThanOrEqual(now)
  })

  it('the poll that finds a transcode finished records it too', async () => {
    const now = Date.now()
    useUploadStore.setState({
      files: [row({ id: 'r', status: 'processing', assetId: 'ra', versionId: 'rv', createdAt: now - 3 * DAY })],
    })
    vi.mocked(api.get).mockImplementation(((path: string) => (path === '/assets/ra'
      ? Promise.resolve({ id: 'ra', latest_version: { id: 'rv', processing_status: 'ready' } })
      : Promise.resolve([]))) as never)

    await useUploadStore.getState().refreshProcessingItems()

    expect(rowOf('r').status).toBe('complete')
    expect(rowOf('r').completedAt).toBeGreaterThanOrEqual(now)
  })

  it('a history row that finished takes the time its last part was sent', async () => {
    const created = Date.now() - 3 * DAY
    const lastPart = Date.now() - 2 * DAY
    vi.mocked(api.get).mockResolvedValue([{
      id: 'a1', project_id: 'p1', name: 'clip', asset_type: 'video', created_by: 'user-1',
      latest_version: {
        id: 'v1', asset_id: 'a1', version_number: 1, processing_status: 'ready', created_by: 'user-1',
        created_at: new Date(created).toISOString(), last_activity_at: new Date(lastPart).toISOString(), files: [],
      },
    }] as unknown as AssetResponse[] as never)
    useUploadStore.setState({ historyLoaded: false, historyLoading: false, historySkip: 0, historyHasMore: true })

    await useUploadStore.getState().fetchHistory()

    expect(rowOf('history-a1')).toMatchObject({ status: 'complete', createdAt: created, completedAt: lastPart })
  })
})
