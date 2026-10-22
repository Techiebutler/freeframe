/**
 * Discarding an upload whose version the server no longer reports.
 *
 * Discard asks `/upload/{version}/parts` which multipart upload to abort. When
 * that answers 404 or 409 the version is gone or no longer uploading, and the
 * row used to be dropped there without telling storage -- leaving the multipart
 * upload and every part already sent to the reaper (#510). The row itself
 * carries what the abort needs, so it is sent from there.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: { post: vi.fn(), get: vi.fn(), patch: vi.fn() },
}))

import { api, ApiError } from '@/lib/api'
import { useUploadStore, __uploadQueueTesting } from '../upload-store'
import type { UploadFile } from '../upload-store'
import { installXhrFake } from '@/test/xhr-fake'
import { signInAs } from '@/test/upload-session'

// The upload queue is tab-wide module state: start every test from an empty one.
beforeEach(() => __uploadQueueTesting.reset())

const VERSION_ID = 'version-1'
const ASSET_ID = 'asset-1'
const UPLOAD_ID = 'upload-1'
const S3_KEY = 'raw/p/a/v/original.mp4'
const STORAGE_KEY = 'ff-uploads'

function seedRow(overrides: Partial<UploadFile> = {}) {
  useUploadStore.setState({
    files: [{
      id: 'row-1',
      fileName: 'clip.mp4',
      fileSize: 1024,
      fileType: 'video/mp4',
      projectId: 'project-1',
      assetName: 'clip',
      progress: 0,
      processingProgress: 0,
      status: 'interrupted',
      assetId: ASSET_ID,
      versionId: VERSION_ID,
      uploadId: UPLOAD_ID,
      s3Key: S3_KEY,
      createdAt: Date.now(),
      ownerId: 'u1',
      ...overrides,
    }],
  })
}

function rowOf(id: string) {
  return useUploadStore.getState().files.find((f) => f.id === id)!
}

function aborts() {
  return vi.mocked(api.post).mock.calls.filter(([path]) => path === '/upload/abort')
}

function storedFiles(): UploadFile[] {
  return JSON.parse(window.localStorage.getItem(STORAGE_KEY)!).state.files
}

describe('discardUpload when /parts says the version is gone', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()
    signInAs('u1')
    seedRow()
    vi.mocked(api.get).mockRejectedValue(new ApiError(404, 'Version not found'))
    vi.mocked(api.post).mockResolvedValue({} as never)
  })

  it('a 404 from /parts still sends the discard abort when the row has its key and upload id', async () => {
    const before = useUploadStore.getState().versionsRevision

    const refused = await useUploadStore.getState().discardUpload('row-1')

    expect(refused).toBeNull()
    expect(api.post).toHaveBeenCalledTimes(1)
    expect(api.post).toHaveBeenCalledWith('/upload/abort', {
      s3_key: S3_KEY,
      upload_id: UPLOAD_ID,
      version_id: VERSION_ID,
      discard: true,
    }, { pinSubject: 'u1' })
    expect(useUploadStore.getState().files).toEqual([])
    expect(useUploadStore.getState().versionsRevision).toBe(before + 1)
  })

  it('a 409 from /parts sends it too, since the server leaves a version that is no longer uploading alone', async () => {
    vi.mocked(api.get).mockRejectedValue(new ApiError(409, 'This upload is already ready.'))

    const refused = await useUploadStore.getState().discardUpload('row-1')

    expect(refused).toBeNull()
    expect(aborts()).toHaveLength(1)
    expect(aborts()[0][1]).toMatchObject({ version_id: VERSION_ID, discard: true })
    expect(useUploadStore.getState().files).toEqual([])
  })

  it('a 404 from that abort is ignored and the row is dropped', async () => {
    // The reaper or another tab got there first: nothing is left to abort.
    vi.mocked(api.post).mockRejectedValue(new ApiError(404, 'Upload not found'))
    const before = useUploadStore.getState().versionsRevision

    const refused = await useUploadStore.getState().discardUpload('row-1')

    expect(refused).toBeNull()
    expect(aborts()).toHaveLength(1)
    expect(useUploadStore.getState().files).toEqual([])
    expect(useUploadStore.getState().versionsRevision).toBe(before + 1)
  })

  it('a 503 from that abort keeps the row and reports the failure', async () => {
    // Storage is unreachable, so the multipart upload is still open and the row
    // is the only thing that knows about it.
    vi.mocked(api.post).mockRejectedValue(new ApiError(503, 'Could not reach storage.'))
    const before = useUploadStore.getState().versionsRevision

    const refused = await useUploadStore.getState().discardUpload('row-1')

    expect(refused).toBe('Could not reach storage.')
    expect(rowOf('row-1').status).toBe('interrupted')
    expect(rowOf('row-1').error).toBe('Could not reach storage.')
    expect(useUploadStore.getState().versionsRevision).toBe(before + 1)
  })

  it('a row without s3Key keeps today\'s drop with no abort', async () => {
    // Rows written before the key was recorded, and rows rebuilt from history,
    // do not have it. There is nothing to abort with, so nothing is sent.
    seedRow({ s3Key: undefined })
    const before = useUploadStore.getState().versionsRevision

    const refused = await useUploadStore.getState().discardUpload('row-1')

    expect(refused).toBeNull()
    expect(api.post).not.toHaveBeenCalled()
    expect(useUploadStore.getState().files).toEqual([])
    expect(useUploadStore.getState().versionsRevision).toBe(before + 1)
  })

  it('a row without an upload id keeps today\'s drop with no abort', async () => {
    seedRow({ uploadId: undefined })

    const refused = await useUploadStore.getState().discardUpload('row-1')

    expect(refused).toBeNull()
    expect(api.post).not.toHaveBeenCalled()
    expect(useUploadStore.getState().files).toEqual([])
  })

  it('a /parts failure that is not final sends nothing and keeps the row', async () => {
    // A 503 says nothing about the upload, so the row stays resumable and
    // discardable later; aborting from here would be guessing.
    vi.mocked(api.get).mockRejectedValue(new ApiError(503, 'Could not reach storage.'))

    const refused = await useUploadStore.getState().discardUpload('row-1')

    expect(refused).toBe('Could not reach storage.')
    expect(api.post).not.toHaveBeenCalled()
    expect(rowOf('row-1').error).toBe('Could not reach storage.')
  })
})

describe('the key a row carries', () => {
  const INITIATE = {
    upload_id: UPLOAD_ID,
    s3_key: S3_KEY,
    asset_id: ASSET_ID,
    version_id: VERSION_ID,
    chunk_size_bytes: 10 * 1024 * 1024,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()
    signInAs('u1')
    useUploadStore.setState({ files: [] })
    vi.mocked(api.post).mockImplementation(async (path: string) => {
      if (path === '/upload/initiate' || path.endsWith('/versions')) return INITIATE as never
      if (path === '/upload/presign-part') return { presigned_url: 'https://store.test/part-1' } as never
      return {} as never
    })
    // The part never lands, so the row stays mid-transfer.
    installXhrFake(() => new Promise(() => {}))
  })

  afterEach(() => {
    for (const f of useUploadStore.getState().files) useUploadStore.getState().cancelUpload(f.id)
    useUploadStore.setState({ files: [] })
  })

  const file = () => new File([new Uint8Array(8)], 'clip.mp4', { type: 'video/mp4' })

  it('s3Key is recorded at initiate and survives a reload', async () => {
    const id = useUploadStore.getState().startUpload(file(), 'project-1', 'clip')!

    await vi.waitFor(() => expect(rowOf(id).s3Key).toBe(S3_KEY))
    expect(rowOf(id).uploadId).toBe(UPLOAD_ID)

    // In shared storage, which is what the next page load reads.
    expect(storedFiles().find((f) => f.id === id)?.s3Key).toBe(S3_KEY)

    await useUploadStore.persist.rehydrate()

    expect(rowOf(id).s3Key).toBe(S3_KEY)
    expect(rowOf(id).status).toBe('interrupted')
  })

  it('s3Key is recorded when a new version is initiated', async () => {
    const id = useUploadStore.getState().startVersionUpload(
      file(), ASSET_ID, 'clip', 'project-1',
    )!

    await vi.waitFor(() => expect(rowOf(id).s3Key).toBe(S3_KEY))
    expect(storedFiles().find((f) => f.id === id)?.s3Key).toBe(S3_KEY)
  })

  it('s3Key is recorded from /parts when an upload is resumed', async () => {
    seedRow({ s3Key: undefined, uploadId: undefined, fileSize: 8 })
    vi.mocked(api.get).mockResolvedValue({
      state: 'resumable',
      upload_id: UPLOAD_ID,
      s3_key: S3_KEY,
      asset_id: ASSET_ID,
      version_id: VERSION_ID,
      chunk_size_bytes: 10 * 1024 * 1024,
      file_size_bytes: 8,
      original_filename: 'clip.mp4',
      mime_type: 'video/mp4',
      held_part_numbers: [],
    } as never)

    useUploadStore.getState().resumeUpload('row-1', file())

    await vi.waitFor(() => expect(rowOf('row-1').s3Key).toBe(S3_KEY))
    expect(rowOf('row-1').uploadId).toBe(UPLOAD_ID)
    expect(storedFiles().find((f) => f.id === 'row-1')?.s3Key).toBe(S3_KEY)
  })
})
