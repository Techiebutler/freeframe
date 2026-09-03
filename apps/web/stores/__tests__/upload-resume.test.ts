/**
 * Resuming an upload that stopped part-way.
 *
 * The point of the feature is what does NOT go over the wire: parts the storage
 * backend is already holding are not sent again. The server decides which those
 * are and which byte ranges they cover, so the tests here are mostly about the
 * client doing what it is told rather than what its own constants say.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
  api: { post: vi.fn(), get: vi.fn() },
  ApiError: class ApiError extends Error {
    status: number
    detail: string
    constructor(status: number, detail: string) {
      super(detail)
      this.name = 'ApiError'
      this.status = status
      this.detail = detail
    }
  },
}))

import { api, ApiError } from '@/lib/api'
import { useUploadStore, uploadAllParts } from '../upload-store'

const MB = 1024 * 1024
const CHUNK = 10 * MB
const VERSION_ID = 'version-1'
const ASSET_ID = 'asset-1'
/** 23 MB is two full parts and a 3 MB remainder. */
const TOTAL = 23 * MB

function makeFile(bytes = TOTAL, name = 'clip.mp4'): File {
  return new File([new Uint8Array(bytes)], name, { type: 'video/mp4' })
}

function resumeInfo(overrides: Record<string, unknown> = {}) {
  return {
    state: 'resumable',
    upload_id: 'u1',
    s3_key: 'raw/p/a/v/original.mp4',
    asset_id: ASSET_ID,
    version_id: VERSION_ID,
    chunk_size_bytes: CHUNK,
    file_size_bytes: TOTAL,
    original_filename: 'clip.mp4',
    mime_type: 'video/mp4',
    held_part_numbers: [],
    ...overrides,
  }
}

/** An interrupted row, as the panel would be showing it. */
function seedInterrupted() {
  useUploadStore.setState({
    files: [{
      id: 'row-1',
      fileName: 'clip.mp4',
      fileSize: TOTAL,
      fileType: 'video/mp4',
      projectId: 'project-1',
      assetName: 'clip',
      progress: 0,
      processingProgress: 0,
      status: 'interrupted',
      assetId: ASSET_ID,
      versionId: VERSION_ID,
      createdAt: Date.now(),
    }],
  })
}

function rowOf(id: string) {
  return useUploadStore.getState().files.find((f) => f.id === id)!
}

/** The part number a presigned URL names, so a fetch mock can tell parts apart. */
function mockPresignPerPart() {
  return vi.mocked(api.post).mockImplementation((path: string, body?: unknown) => {
    if (path === '/upload/presign-part') {
      return Promise.resolve({
        presigned_url: `https://s3.example/part-${(body as { part_number: number }).part_number}`,
      }) as never
    }
    return Promise.resolve({}) as never
  })
}

function partsSentTo(fetchMock: ReturnType<typeof vi.fn>): number[] {
  return fetchMock.mock.calls
    .map(([url]) => Number(String(url).split('-').pop()))
    .sort((a, b) => a - b)
}

function completionBody(): Record<string, unknown> {
  const call = vi.mocked(api.post).mock.calls.find(([p]) => p === '/upload/complete')!
  return call[1] as Record<string, unknown>
}

// --------------------------------------------------------------- uploadAllParts

describe('uploadAllParts with parts already held', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPresignPerPart()
    global.fetch = vi.fn().mockResolvedValue({
      ok: true, headers: { get: () => '"etag"' },
    }) as never
  })

  it('does not send a part the backend already holds', async () => {
    await uploadAllParts(
      makeFile(), 'key', 'u1', new AbortController(), () => {}, 5,
      { chunkSize: CHUNK, alreadyHeld: [1, 2] },
    )

    expect(partsSentTo(global.fetch as never)).toEqual([3])
  })

  it('counts the held parts as progress instead of starting again at zero', async () => {
    // A resume that reports 0% and then jumps is indistinguishable from one that
    // is re-sending everything, which is exactly the doubt this removes.
    const onProgress = vi.fn()

    await uploadAllParts(
      makeFile(), 'key', 'u1', new AbortController(), onProgress, 5,
      { chunkSize: CHUNK, alreadyHeld: [1, 2] },
    )

    expect(onProgress.mock.calls[0][0]).toBe(Math.round((2 / 3) * 95))
  })

  it('sends the parts that are missing from the middle, not just the tail', async () => {
    // Parts finish out of order once several are in flight, so what is held is a
    // set. Treating it as a prefix would re-send everything after the first hole.
    await uploadAllParts(
      makeFile(), 'key', 'u1', new AbortController(), () => {}, 5,
      { chunkSize: CHUNK, alreadyHeld: [1, 3] },
    )

    expect(partsSentTo(global.fetch as never)).toEqual([2])
  })

  it('cuts the file on the chunk size it is given, not on its own constant', async () => {
    // A release that changes CHUNK_SIZE must not move the byte ranges of an
    // upload whose earlier parts are already in the bucket.
    await uploadAllParts(
      makeFile(TOTAL), 'key', 'u1', new AbortController(), () => {}, 5,
      { chunkSize: 5 * MB },
    )

    // 23 MB at 5 MB per part is five parts, not three.
    expect(partsSentTo(global.fetch as never)).toEqual([1, 2, 3, 4, 5])
  })

  it('returns only the parts it actually sent', async () => {
    const parts = await uploadAllParts(
      makeFile(), 'key', 'u1', new AbortController(), () => {}, 5,
      { chunkSize: CHUNK, alreadyHeld: [1, 2] },
    )

    // Not a sparse array with holes where the skipped parts would be: that
    // serialises as nulls and would be rejected by the completion schema.
    expect(parts).toEqual([{ PartNumber: 3, ETag: '"etag"' }])
  })
})

// ---------------------------------------------------------------- resumeUpload

describe('resumeUpload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seedInterrupted()
    mockPresignPerPart()
    global.fetch = vi.fn().mockResolvedValue({
      ok: true, headers: { get: () => '"etag"' },
    }) as never
    vi.mocked(api.get).mockResolvedValue(resumeInfo({ held_part_numbers: [1, 2] }) as never)
  })

  it('sends only the parts the server says are missing, then completes', async () => {
    useUploadStore.getState().resumeUpload('row-1', makeFile())
    await vi.waitFor(() => expect(rowOf('row-1').status).toBe('processing'))

    expect(partsSentTo(global.fetch as never)).toEqual([3])
    expect(completionBody().version_id).toBe(VERSION_ID)
  })

  it('takes the key and the upload id from the server, not from the row', async () => {
    // The row may have been rehydrated from history in a browser that never saw
    // either of them, which is the normal case after a closed tab.
    useUploadStore.getState().resumeUpload('row-1', makeFile())
    await vi.waitFor(() => expect(rowOf('row-1').status).toBe('processing'))

    expect(api.get).toHaveBeenCalledWith(`/upload/${VERSION_ID}/parts`)
    expect(completionBody().s3_key).toBe('raw/p/a/v/original.mp4')
    expect(completionBody().upload_id).toBe('u1')
  })

  it('reports no parts list when it skipped some', async () => {
    // The list is only read by a backend that cannot list its own parts, and a
    // resumed upload cannot produce a complete one: it never saw the ETags of
    // the parts it did not send. A partial list completes a truncated object
    // with no error on most backends. None makes such a backend refuse instead.
    useUploadStore.getState().resumeUpload('row-1', makeFile())
    await vi.waitFor(() => expect(rowOf('row-1').status).toBe('processing'))

    expect(completionBody().parts).toEqual([])
  })

  it('still reports a full parts list when nothing was skipped', async () => {
    vi.mocked(api.get).mockResolvedValue(resumeInfo({ held_part_numbers: [] }) as never)

    useUploadStore.getState().resumeUpload('row-1', makeFile())
    await vi.waitFor(() => expect(rowOf('row-1').status).toBe('processing'))

    expect((completionBody().parts as unknown[]).length).toBe(3)
  })

  it('refuses a file of a different size', async () => {
    // The user picks the file again by hand. A different file of the same name
    // would be spliced onto the parts already in the bucket, and nothing
    // downstream would notice.
    useUploadStore.getState().resumeUpload('row-1', makeFile(TOTAL - 1))
    await vi.waitFor(() => expect(rowOf('row-1').status).toBe('interrupted'))

    expect(global.fetch).not.toHaveBeenCalled()
    expect(rowOf('row-1').error).toContain('clip.mp4')
  })

  it('refuses a file with a different name', async () => {
    useUploadStore.getState().resumeUpload('row-1', makeFile(TOTAL, 'other.mp4'))
    await vi.waitFor(() => expect(rowOf('row-1').status).toBe('interrupted'))

    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('completes an already assembled upload without needing the file at all', async () => {
    // CompleteMultipartUpload ran and only the status write is outstanding, so
    // there is nothing to send -- and refusing over a renamed file would strand
    // an upload that is whole.
    vi.mocked(api.get).mockResolvedValue(resumeInfo({ state: 'assembled' }) as never)

    useUploadStore.getState().resumeUpload('row-1', makeFile(1, 'renamed.mp4'))
    await vi.waitFor(() => expect(rowOf('row-1').status).toBe('processing'))

    expect(global.fetch).not.toHaveBeenCalled()
    expect(completionBody().parts).toEqual([])
  })

  it('stays resumable when the transfer breaks again', async () => {
    // A 403 rather than a dropped connection, so this does not spend the part
    // retry ladder's four minutes reaching the same place.
    global.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 403, statusText: 'Forbidden', headers: { get: () => null },
    }) as never

    useUploadStore.getState().resumeUpload('row-1', makeFile())
    await vi.waitFor(() => expect(rowOf('row-1').status).toBe('interrupted'))

    // And nothing was aborted, so the next attempt starts from further along
    // than this one did.
    expect(vi.mocked(api.post).mock.calls.some(([p]) => p === '/upload/abort')).toBe(false)
  })

  it('is failed, not resumable, once the server says the upload is over', async () => {
    // A 409 is the server stating this version is no longer uploading. Offering
    // another resume would walk the user round the same loop.
    vi.mocked(api.get).mockRejectedValue(new ApiError(409, 'This upload is already failed.'))

    useUploadStore.getState().resumeUpload('row-1', makeFile())
    await vi.waitFor(() => expect(rowOf('row-1').status).toBe('failed'))
  })

  it('stays resumable when the server merely could not be reached', async () => {
    vi.mocked(api.get).mockRejectedValue(new ApiError(503, 'Could not reach storage.'))

    useUploadStore.getState().resumeUpload('row-1', makeFile())
    await vi.waitFor(() => expect(rowOf('row-1').status).toBe('interrupted'))
  })

  it('does nothing for a row that is not interrupted', async () => {
    useUploadStore.setState((s) => ({
      files: s.files.map((f) => ({ ...f, status: 'processing' as const })),
    }))

    useUploadStore.getState().resumeUpload('row-1', makeFile())
    await new Promise((r) => setTimeout(r, 20))

    expect(api.get).not.toHaveBeenCalled()
  })
})

// --------------------------------------------------------------- discardUpload

describe('discardUpload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seedInterrupted()
    vi.mocked(api.get).mockResolvedValue(resumeInfo() as never)
    vi.mocked(api.post).mockResolvedValue({} as never)
  })

  it('aborts the upload the user chose to be rid of', async () => {
    // The counterpart to no longer aborting on failure: this is now the only
    // path that discards parts, and a person asked for it.
    await useUploadStore.getState().discardUpload('row-1')

    expect(api.post).toHaveBeenCalledWith('/upload/abort', {
      s3_key: 'raw/p/a/v/original.mp4',
      upload_id: 'u1',
      version_id: VERSION_ID,
    })
    expect(useUploadStore.getState().files).toEqual([])
  })

  it('removes the row even when the server cannot be told', async () => {
    // What is left in the bucket is the reaper's job, and it has the activity
    // timestamp it needs. Leaving the row would be a button that does nothing.
    vi.mocked(api.get).mockRejectedValue(new ApiError(503, 'Could not reach storage.'))

    await useUploadStore.getState().discardUpload('row-1')

    expect(useUploadStore.getState().files).toEqual([])
  })
})
