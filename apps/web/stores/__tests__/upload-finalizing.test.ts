/**
 * The wait after the last byte is visible as its own state.
 *
 * Once every part is across, `/upload/complete` has the storage backend assemble
 * them, which on a large file takes minutes. The bar used to sit at 95 with
 * "Uploading 95%" the whole time, which reads as a hung upload. The row is now
 * marked `finalizing` for exactly that request, and nothing else about it changes.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
  api: { post: vi.fn(), get: vi.fn() },
}))

import { api } from '@/lib/api'
import { useUploadStore } from '../upload-store'
import { installXhrFake, ok } from '@/test/xhr-fake'

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
})
