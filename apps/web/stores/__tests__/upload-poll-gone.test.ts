/**
 * The poll behind the uploads panel, asked about an asset that is gone.
 *
 * `refreshProcessingItems` asks the server about the asset of every processing
 * or interrupted row, and used to read an asset it got no answer for as "ask
 * again". An asset in the trash, or in a deleted project (since v1.19.0), is
 * never going to answer: `GET /assets/{id}` refuses them with 404 and 403, and
 * `GET /assets/batch`, which the poll asks now (#524), leaves them out. The row
 * stayed in the Active group for good and was polled for as long as the tab
 * stayed open (#509).
 *
 * Left out of a successful answer is the server saying the file is not there
 * for this user. That is final for the row, and a failed row is neither polled
 * nor counted as active. A dropped connection or a 5xx says nothing about the
 * asset, so those still ask again.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: { post: vi.fn(), get: vi.fn(), patch: vi.fn() },
}))

import { api, ApiError } from '@/lib/api'
import { useUploadStore } from '../upload-store'
import type { UploadFile } from '../upload-store'
import { pollIntervalFor } from '@/components/layout/upload-sse-bridge'
import { signInAs } from '@/test/upload-session'
import { answerBatch, batchIds } from '@/test/assets-batch'

const GONE_MESSAGE = 'This file is no longer available.'

function seedRow(overrides: Partial<UploadFile> = {}): UploadFile {
  return {
    id: 'row-1',
    fileName: 'clip.mp4',
    fileSize: 1024,
    fileType: 'video/mp4',
    projectId: 'project-1',
    assetName: 'clip',
    progress: 100,
    processingProgress: 0,
    status: 'processing',
    assetId: 'asset-1',
    versionId: 'version-1',
    createdAt: Date.now(),
    ownerId: 'u1',
    ...overrides,
  }
}

function rowOf(id: string) {
  return useUploadStore.getState().files.find((f) => f.id === id)!
}

/** Polls that asked about one asset, counting every one that went out. */
function pollsFor(assetId: string) {
  return vi.mocked(api.get).mock.calls.filter(([path]) => batchIds(path)?.includes(assetId))
}

/**
 * One pass of what the bridge's timer does: ask for the interval the current
 * rows call for, and poll only when it says to.
 */
async function tick() {
  if (pollIntervalFor(useUploadStore.getState().files) === 0) return
  await useUploadStore.getState().refreshProcessingItems()
}

describe('the poll when the asset is gone', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()
    signInAs('u1')
    useUploadStore.setState({ files: [] })
  })

  it('an answer that leaves the asset out fails a processing row with the gone message and it is not polled again', async () => {
    useUploadStore.setState({ files: [seedRow({ status: 'processing' })] })
    vi.mocked(api.get).mockImplementation(answerBatch([]) as never)

    await tick()

    expect(rowOf('row-1').status).toBe('failed')
    expect(rowOf('row-1').error).toBe(GONE_MESSAGE)

    await tick()

    expect(pollsFor('asset-1')).toHaveLength(1)
    expect(pollIntervalFor(useUploadStore.getState().files)).toBe(0)
  })

  it('does the same for an interrupted row', async () => {
    useUploadStore.setState({ files: [seedRow({ status: 'interrupted', uploadId: 'upload-1' })] })
    vi.mocked(api.get).mockImplementation(answerBatch([]) as never)

    await tick()

    expect(rowOf('row-1').status).toBe('failed')
    expect(rowOf('row-1').error).toBe(GONE_MESSAGE)

    await tick()

    expect(pollsFor('asset-1')).toHaveLength(1)
  })

  it('a network error or a 503 leaves the row processing and polls again', async () => {
    useUploadStore.setState({ files: [seedRow({ status: 'processing' })] })
    vi.mocked(api.get)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new ApiError(503, 'Storage is unavailable', { code: 'storage_unavailable', retryAfter: 5 }))
      .mockRejectedValueOnce(new ApiError(500, 'Internal Server Error'))

    await tick()
    expect(rowOf('row-1').status).toBe('processing')
    expect(rowOf('row-1').error).toBeUndefined()

    await tick()
    expect(rowOf('row-1').status).toBe('processing')

    await tick()
    expect(rowOf('row-1').status).toBe('processing')
    expect(rowOf('row-1').error).toBeUndefined()

    expect(pollsFor('asset-1')).toHaveLength(3)
  })

  it('two rows on one gone asset both fail', async () => {
    // An interrupted v2 and a processing v3 of the same asset.
    useUploadStore.setState({
      files: [
        seedRow({ id: 'row-1', versionId: 'v2', status: 'interrupted' }),
        seedRow({ id: 'row-2', versionId: 'v3', status: 'processing' }),
      ],
    })
    vi.mocked(api.get).mockImplementation(answerBatch([]) as never)

    await tick()

    expect(rowOf('row-1')).toMatchObject({ status: 'failed', error: GONE_MESSAGE })
    expect(rowOf('row-2')).toMatchObject({ status: 'failed', error: GONE_MESSAGE })
    expect(pollIntervalFor(useUploadStore.getState().files)).toBe(0)
  })

  it('leaves a row on an asset that still answers alone when its neighbour is gone', async () => {
    useUploadStore.setState({
      files: [
        seedRow({ id: 'row-1', assetId: 'asset-gone', versionId: 'v1' }),
        seedRow({ id: 'row-2', assetId: 'asset-live', versionId: 'v2' }),
      ],
    })
    vi.mocked(api.get).mockImplementation(answerBatch([
      { id: 'asset-live', latest_version: { id: 'v2', processing_status: 'processing' } },
    ]) as never)

    await tick()

    expect(rowOf('row-1')).toMatchObject({ status: 'failed', error: GONE_MESSAGE })
    expect(rowOf('row-2').status).toBe('processing')
    expect(rowOf('row-2').error).toBeUndefined()
  })
})
