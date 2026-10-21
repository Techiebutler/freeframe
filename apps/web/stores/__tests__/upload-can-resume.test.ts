/**
 * `canResume(id)`: whether a Resume of this row would be taken up now.
 *
 * The panel offers Resume only when this is true. It has to agree with
 * `resumeUpload`, which refuses silently, so a button that the store would
 * ignore is a button that does nothing: a row that is not `interrupted`, one
 * already waiting for its turn, one a run is still settling, one whose Discard
 * is out. And, because the answer reads state that no row field mirrors (the
 * runs, the Discards), a change in either has to reach a subscriber that is
 * watching nothing else.
 *
 * The API is mocked but `ApiError` is the real one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  api: { post: vi.fn(), get: vi.fn(), patch: vi.fn() },
}))
vi.mock('swr', () => ({ mutate: vi.fn() }))

import { api, ApiError } from '@/lib/api'
import { useUploadStore, __uploadQueueTesting as testing } from '../upload-store'
import { signInAs, row } from '@/test/upload-session'
import { MB, fakeServer, fileOf, settle, resumable } from '@/test/upload-queue-server'

const interrupted = (over: Parameters<typeof row>[0] = {}) =>
  row({
    id: 'r', status: 'interrupted', fileSize: 50 * MB,
    assetId: 'ra', versionId: 'rv', uploadId: 'ru', s3Key: 'rk',
    ...over,
  })

const canResume = (id = 'r') => useUploadStore.getState().canResume(id)

beforeEach(() => {
  vi.clearAllMocks()
  testing.reset()
  window.localStorage.clear()
  useUploadStore.setState({ files: [], versionsRevision: 0, panelOpen: false })
  signInAs('user-1')
})

afterEach(() => {
  vi.restoreAllMocks()
  testing.reset()
})

describe('canResume', () => {
  it('is true for an interrupted row nothing is working on', () => {
    useUploadStore.setState({ files: [interrupted()] })

    expect(canResume()).toBe(true)
  })

  it('is false for a row that is not interrupted, has no upload to come back to, or does not exist', () => {
    useUploadStore.setState({
      files: [
        interrupted({ id: 'no-version', versionId: undefined }),
        ...(['queued', 'starting', 'uploading', 'processing', 'complete', 'failed', 'cancelled', 'elsewhere'] as const)
          .map((status) => interrupted({ id: status, status })),
      ],
    })

    for (const f of useUploadStore.getState().files) expect(canResume(f.id)).toBe(false)
    expect(canResume('nobody')).toBe(false)
  })

  it('is false for a resume already waiting for its turn', () => {
    useUploadStore.setState({ files: [interrupted({ queuedResume: true })] })

    expect(canResume()).toBe(false)
  })

  it('is false while a run of the row settles, and true again, to a subscriber, when it has', async () => {
    fakeServer(() => 'wait')
    const answers: Array<(v: unknown) => void> = []
    vi.mocked(api.get).mockImplementation(() => new Promise((res) => answers.push(res)) as never)
    useUploadStore.setState({ files: [interrupted()] })

    useUploadStore.getState().resumeUpload('r', fileOf('clip.mp4', 50 * MB))
    await settle()
    // Cancelled while it asks `/parts`: plain interrupted again, run still there.
    useUploadStore.getState().cancelUpload('r')
    expect(useUploadStore.getState().files[0].status).toBe('interrupted')
    expect(canResume()).toBe(false)

    // A subscriber that selects only this answer, as the panel's row does.
    const seen: boolean[] = []
    const stop = useUploadStore.subscribe((s) => {
      const now = s.canResume('r')
      if (seen[seen.length - 1] !== now) seen.push(now)
    })
    answers.shift()!(resumable({ file_size_bytes: 50 * MB }))
    await settle()
    stop()

    expect(canResume()).toBe(true)
    expect(seen).toEqual([true])
  })

  it('is false while a Discard of the row is out, and true again, to a subscriber, if it fails', async () => {
    let failParts!: (err: unknown) => void
    vi.mocked(api.get).mockImplementation(() => new Promise((_, reject) => {
      failParts = reject
    }) as never)
    useUploadStore.setState({ files: [interrupted()] })
    const seen: boolean[] = []
    const stop = useUploadStore.subscribe((s) => {
      const now = s.canResume('r')
      if (seen[seen.length - 1] !== now) seen.push(now)
    })

    const discarded = useUploadStore.getState().discardUpload('r')
    await settle()
    expect(canResume()).toBe(false)

    failParts(new ApiError(503, 'Storage is not answering'))
    expect(await discarded).toBe('Storage is not answering')
    stop()

    expect(canResume()).toBe(true)
    expect(seen).toEqual([false, true])
  })
})

describe('a Discard that failed', () => {
  it('marks the row, so the panel can offer Dismiss, until a Resume takes it up', async () => {
    vi.mocked(api.get).mockRejectedValue(new ApiError(503, 'Storage is not answering'))
    useUploadStore.setState({ files: [interrupted()] })

    await useUploadStore.getState().discardUpload('r')

    expect(useUploadStore.getState().files[0]).toMatchObject({
      status: 'interrupted', error: 'Storage is not answering', discardFailed: true,
    })

    fakeServer(() => 'wait')
    vi.mocked(api.get).mockImplementation(() => new Promise(() => {}) as never)
    useUploadStore.getState().resumeUpload('r', fileOf('clip.mp4', 50 * MB))
    await settle()

    expect(useUploadStore.getState().files[0].discardFailed).toBeUndefined()
    expect(useUploadStore.getState().files[0].error).toBeUndefined()
  })
})
