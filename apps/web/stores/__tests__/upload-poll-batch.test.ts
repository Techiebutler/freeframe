/**
 * The uploads panel's poll asks about all its rows in one request (#524).
 *
 * It used to send one `GET /assets/{id}` per processing or interrupted row,
 * every five seconds while any row was processing: 12 reads a minute per row,
 * against a read limit of 600 a minute per user. About fifty videos left
 * processing spent the whole budget on the poll alone, and the user's other
 * requests failed until the minute rolled over.
 *
 * Now one tick sends one `GET /assets/batch` per hundred assets, each asked
 * about once however many rows watch it. An id left out of the answer is an
 * asset the server would have answered 403 or 404 for, which fails the row as
 * before. A request that fails says nothing about any asset in it, whatever its
 * status, so every row it asked for is asked about again.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: { post: vi.fn(), get: vi.fn(), patch: vi.fn() },
}))

import { api, ApiError } from '@/lib/api'
import { useUploadStore } from '../upload-store'
import { signInAs, row } from '@/test/upload-session'
import { batchIds } from '@/test/assets-batch'

const GONE_MESSAGE = 'This file is no longer available.'

function rowOf(id: string) {
  return useUploadStore.getState().files.find((f) => f.id === id)!
}

/**
 * Every request the poll sent. Signing in fetches the account's history from
 * `/me/assets`, which is not the poll's.
 */
function pollCalls() {
  return vi.mocked(api.get).mock.calls.filter(([path]) => path.startsWith('/assets/'))
}

function processing(n: number) {
  return Array.from({ length: n }, (_, i) =>
    row({ id: `row-${i}`, status: 'processing', assetId: `asset-${i}`, versionId: `v-${i}`, progress: 100 }),
  )
}

/** Answers each batch with every asset it asked about, at `ready` on the row's version. */
function answerAllReady() {
  vi.mocked(api.get).mockImplementation((async (path: string) =>
    (batchIds(path) ?? []).map((id) => ({
      id, latest_version: { id: id.replace('asset-', 'v-'), processing_status: 'ready' },
    }))) as never)
}

describe('the processing poll', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()
    signInAs('u1')
    useUploadStore.setState({ files: [] })
  })

  it('asks about fifty processing rows in one request, each asset once', async () => {
    // Two of the rows watch one asset: an interrupted v2 and a processing v3.
    const rows = processing(50)
    rows[49] = row({ id: 'row-49', status: 'interrupted', assetId: 'asset-0', versionId: 'v-older' })
    useUploadStore.setState({ files: rows })
    answerAllReady()

    await useUploadStore.getState().refreshProcessingItems()

    expect(pollCalls()).toHaveLength(1)
    const [path, options] = pollCalls()[0]
    const ids = batchIds(path)!
    expect(ids).toHaveLength(49)
    expect(new Set(ids).size).toBe(49)
    expect(options).toEqual({ pinSubject: 'u1' })
    expect(rowOf('row-0').status).toBe('complete')
    expect(rowOf('row-48').status).toBe('complete')
    // The answer is about v-0, so the row on the older version is left alone.
    expect(rowOf('row-49').status).toBe('interrupted')
  })

  it('splits more than a hundred assets across requests of a hundred', async () => {
    useUploadStore.setState({ files: processing(150) })
    answerAllReady()

    await useUploadStore.getState().refreshProcessingItems()

    const sizes = pollCalls().map(([path]) => batchIds(path)!.length)
    expect(sizes.sort((a, b) => b - a)).toEqual([100, 50])
    expect(useUploadStore.getState().files.every((f) => f.status === 'complete')).toBe(true)
  })

  it('fails a row whose asset the answer leaves out, and leaves the others to their answers', async () => {
    useUploadStore.setState({ files: processing(3) })
    vi.mocked(api.get).mockResolvedValue([
      { id: 'asset-0', latest_version: { id: 'v-0', processing_status: 'processing' } },
      { id: 'asset-2', latest_version: { id: 'v-2', processing_status: 'ready' } },
    ] as never)

    await useUploadStore.getState().refreshProcessingItems()

    expect(rowOf('row-0').status).toBe('processing')
    expect(rowOf('row-1')).toMatchObject({ status: 'failed', error: GONE_MESSAGE })
    expect(rowOf('row-2').status).toBe('complete')
  })

  it('leaves every row as it was when the request fails, even with a 403 or 404', async () => {
    // A 404 for `GET /assets/{id}` was about that asset. For the batch it is
    // about the request, and failing every row on it would be wrong for all.
    useUploadStore.setState({ files: processing(3) })

    for (const err of [new TypeError('Failed to fetch'), new ApiError(404, 'Not Found'), new ApiError(403, 'Access denied')]) {
      vi.mocked(api.get).mockRejectedValueOnce(err)
      await useUploadStore.getState().refreshProcessingItems()
      for (const f of useUploadStore.getState().files) {
        expect(f.status).toBe('processing')
        expect(f.error).toBeUndefined()
      }
    }
  })
})
