/**
 * The wait after the last byte is visible as its own state.
 *
 * Once every part is across, `/upload/complete` has the storage backend assemble
 * them, which on a large file takes minutes. The bar used to sit at 95 with
 * "Uploading 95%" the whole time, which reads as a hung upload. The row is now
 * marked `finalizing` from the moment its last byte is sent -- the wait starts
 * there, while storage answers for the last parts, not at `/upload/complete` --
 * and nothing else about it changes.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
  api: { post: vi.fn(), get: vi.fn() },
}))

import { api } from '@/lib/api'
import { useUploadStore, __uploadQueueTesting } from '../upload-store'
import { useUploadSpeedStore } from '../upload-speed-store'
import { installXhrFake, ok, fail, type PartReply } from '@/test/xhr-fake'

// The upload queue is tab-wide module state: start every test from an empty one.
beforeEach(() => __uploadQueueTesting.reset())

function makeFile(): File {
  return new File([new Uint8Array(1024)], 'clip.mp4', { type: 'video/mp4' })
}

function rowOf(id: string) {
  return useUploadStore.getState().files.find((f) => f.id === id)!
}

/** Every POST the upload makes, with `/upload/complete` held open until released. */
function mockUpload() {
  let release!: () => void
  const completion = new Promise<void>((resolve) => {
    release = resolve
  })
  const seenWhenCompleting: Array<{ finalizing?: boolean; status: string }> = []
  vi.mocked(api.post).mockImplementation((path: string) => {
    switch (path) {
      case '/upload/initiate':
        return Promise.resolve({
          upload_id: 'u1', s3_key: 'raw/p/a/v/original.mp4',
          version_id: 'v1', asset_id: 'a1', chunk_size_bytes: 10 * 1024 * 1024,
        }) as never
      case '/upload/presign-part':
        return Promise.resolve({ presigned_url: 'https://s3.example/part-1' }) as never
      case '/upload/complete': {
        const row = useUploadStore.getState().files[0]
        seenWhenCompleting.push({ finalizing: row.finalizing, status: row.status })
        return completion.then(() => ({ status: 'processing' })) as never
      }
      default:
        return Promise.resolve({}) as never
    }
  })
  return { release, seenWhenCompleting }
}

describe('finalizing an upload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useUploadStore.setState({ files: [] })
    installXhrFake(() => ok('"etag-1"'))
  })

  it('is marked for as long as /upload/complete runs, still as uploading', async () => {
    const { release, seenWhenCompleting } = mockUpload()

    const id = useUploadStore.getState().startUpload(makeFile(), 'project-1', 'clip')
    await vi.waitFor(() => expect(seenWhenCompleting).toHaveLength(1))

    expect(seenWhenCompleting[0]).toEqual({ finalizing: true, status: 'uploading' })
    expect(rowOf(id).finalizing).toBe(true)

    release()
    await vi.waitFor(() => expect(rowOf(id).status).toBe('processing'))
  })

  it('is marked once every byte is sent, while storage has yet to answer for the last part', async () => {
    mockUpload()
    let answer!: (reply: PartReply) => void
    installXhrFake((_url, request) => {
      // Every byte handed over, and no reply yet: what the browser sees while
      // storage writes the part, or a proxy forwards it.
      request.progress(request.body!.size)
      return new Promise<PartReply>((resolve) => {
        answer = resolve
      })
    })

    const id = useUploadStore.getState().startUpload(makeFile(), 'project-1', 'clip')
    await vi.waitFor(() => expect(rowOf(id).finalizing).toBe(true))

    expect(rowOf(id).status).toBe('uploading')
    expect(api.post).not.toHaveBeenCalledWith('/upload/complete', expect.anything())
    answer(ok('"etag-1"'))
    await vi.waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/upload/complete', expect.anything()),
    )
  })

  it('is not marked while parts are still going up', async () => {
    mockUpload()
    let finalizingDuringTransfer: boolean | undefined
    installXhrFake(() => {
      finalizingDuringTransfer = useUploadStore.getState().files[0]?.finalizing
      return ok('"etag-1"')
    })

    useUploadStore.getState().startUpload(makeFile(), 'project-1', 'clip')
    await vi.waitFor(() => expect(api.post).toHaveBeenCalledWith('/upload/complete', expect.anything()))

    expect(finalizingDuringTransfer).toBeFalsy()
  })

  it('goes back to uploading, with Cancel, when a part fails after every byte was sent', async () => {
    const { seenWhenCompleting } = mockUpload()
    let attempts = 0
    let finalizingOnRetry: boolean | undefined
    installXhrFake((_url, request) => {
      attempts++
      if (attempts === 1) {
        // The whole part handed over, then storage (or a proxy) gives up on it.
        request.progress(request.body!.size)
        return fail(503)
      }
      finalizingOnRetry = useUploadStore.getState().files[0].finalizing
      return ok('"etag-1"')
    })

    const id = useUploadStore.getState().startUpload(makeFile(), 'project-1', 'clip')
    await vi.waitFor(() => expect(attempts).toBe(2), { timeout: 5000 })

    expect(finalizingOnRetry).toBe(false)
    await vi.waitFor(() => expect(seenWhenCompleting).toHaveLength(1))
    expect(rowOf(id).finalizing).toBe(true)
  }, 10_000)

  it('measures the transfer into the speed store, and withdraws it once every byte is sent', async () => {
    mockUpload()
    let finish!: () => void
    installXhrFake(async (_url, request) => {
      const size = request.body!.size
      request.progress(size / 2)
      await new Promise((r) => setTimeout(r, 1200))
      request.progress((size * 3) / 4)
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      request.progress(size)
      return ok('"etag-1"')
    })

    const id = useUploadStore.getState().startUpload(makeFile(), 'project-1', 'clip')
    await vi.waitFor(
      () => expect(useUploadSpeedStore.getState().rates[id]?.bytesPerSecond).toBeGreaterThan(0),
      { timeout: 4000 },
    )

    finish()
    await vi.waitFor(() => expect(rowOf(id).finalizing).toBe(true))
    expect(useUploadSpeedStore.getState().rates[id]).toBeUndefined()
  }, 10_000)
})
