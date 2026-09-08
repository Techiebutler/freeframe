/**
 * What the client does when the completion request throws.
 *
 * The failure the client sees is not the same thing as the upload failing. A
 * completion whose response was lost on the way back has already moved the
 * version on, and reporting that as Failed would be wrong.
 *
 * The other half of these tests is what must NOT happen: `/upload/abort` is only
 * ever sent for a user cancel. Firing it from the catch of any failure discards
 * every part the backend is holding, which is what made an interrupted upload
 * unrecoverable in the first place.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
  api: { post: vi.fn(), get: vi.fn() },
}))

import { api } from '@/lib/api'
import { useUploadStore } from '../upload-store'

const ASSET_ID = 'asset-1'
const VERSION_ID = 'version-2'
const PREVIOUS_VERSION_ID = 'version-1'

/** One 10 MB part is enough; part mechanics are covered in upload-store.test.ts. */
function makeFile(): File {
  return new File([new Uint8Array(1024)], 'clip.mp4', { type: 'video/mp4' })
}

/** Every POST the upload makes, with `/upload/complete` failing. */
function mockUploadWithFailingCompletion(): { aborts: unknown[] } {
  const aborts: unknown[] = []
  vi.mocked(api.post).mockImplementation((path: string, body?: unknown) => {
    switch (path) {
      case '/upload/initiate':
        return Promise.resolve({
          upload_id: 'u1',
          s3_key: 'raw/p/a/v/original.mp4',
          version_id: VERSION_ID,
          asset_id: ASSET_ID,
        }) as never
      case '/upload/presign-part':
        return Promise.resolve({ presigned_url: 'https://s3.example/part-1' }) as never
      case '/upload/complete':
        // The shape of a lost response: the request never came back.
        return Promise.reject(new Error('Failed to fetch')) as never
      case '/upload/abort':
        aborts.push(body)
        return Promise.resolve({}) as never
      default:
        return Promise.resolve({}) as never
    }
  })
  return { aborts }
}

/** What `GET /assets/{id}` reports: `_display_version` and its status. */
function mockAssetRead(versionId: string | null, processingStatus: string) {
  vi.mocked(api.get).mockImplementation(() =>
    Promise.resolve({
      id: ASSET_ID,
      latest_version: versionId ? { id: versionId, processing_status: processingStatus } : null,
    }) as never,
  )
}

function rowOf(id: string) {
  return useUploadStore.getState().files.find((f) => f.id === id)!
}

/** Resolves once the upload has stopped moving. */
async function settled(id: string) {
  await vi.waitFor(() => expect(rowOf(id).status).not.toBe('uploading'))
}

describe('an upload whose completion request threw', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useUploadStore.setState({ files: [] })
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => '"etag-1"' },
    }) as never
  })

  it('is not reported as failed when the version already moved on', async () => {
    const { aborts } = mockUploadWithFailingCompletion()
    mockAssetRead(VERSION_ID, 'processing')

    const id = useUploadStore.getState().startUpload(makeFile(), 'project-1', 'clip')
    await settled(id)

    expect(rowOf(id).status).toBe('processing')
    // The destructive half: nothing may ask the server to discard a version
    // that is, by its own account, already being transcoded.
    expect(aborts).toEqual([])
  })

  it('reports a version that finished transcoding as complete', async () => {
    const { aborts } = mockUploadWithFailingCompletion()
    mockAssetRead(VERSION_ID, 'ready')

    const id = useUploadStore.getState().startUpload(makeFile(), 'project-1', 'clip')
    await settled(id)

    expect(rowOf(id).status).toBe('complete')
    expect(aborts).toEqual([])
  })

  it('is interrupted, not failed, when the asset reports a different version', async () => {
    // The trap: GET /assets/{id} returns `_display_version`, which excludes
    // `uploading` and `failed`. On a version upload whose completion genuinely
    // never landed, it answers with the PREVIOUS version, sitting at `ready`.
    // Keying on status alone would call that a success.
    const { aborts } = mockUploadWithFailingCompletion()
    mockAssetRead(PREVIOUS_VERSION_ID, 'ready')

    const id = useUploadStore.getState().startUpload(makeFile(), 'project-1', 'clip')
    await settled(id)

    expect(rowOf(id).status).toBe('interrupted')
    expect(aborts).toEqual([])
  })

  it('is interrupted when the asset has no version to report', async () => {
    const { aborts } = mockUploadWithFailingCompletion()
    mockAssetRead(null, '')

    const id = useUploadStore.getState().startUpload(makeFile(), 'project-1', 'clip')
    await settled(id)

    expect(rowOf(id).status).toBe('interrupted')
    expect(aborts).toEqual([])
  })

  it('is interrupted when the server cannot be reached for an answer either', async () => {
    const { aborts } = mockUploadWithFailingCompletion()
    vi.mocked(api.get).mockRejectedValue(new Error('Failed to fetch'))

    const id = useUploadStore.getState().startUpload(makeFile(), 'project-1', 'clip')
    await settled(id)

    expect(rowOf(id).status).toBe('interrupted')
    expect(aborts).toEqual([])
  })

  it('keeps the version id an interrupted row needs to resume', async () => {
    // Without this the row is a dead end: the resume path keys off the version,
    // and the upload id and key it needs are looked up from it server-side.
    mockUploadWithFailingCompletion()
    mockAssetRead(null, '')

    const id = useUploadStore.getState().startUpload(makeFile(), 'project-1', 'clip')
    await settled(id)

    expect(rowOf(id).versionId).toBe(VERSION_ID)
    expect(rowOf(id).assetId).toBe(ASSET_ID)
  })
})

describe('an upload that failed before it ever completed', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useUploadStore.setState({ files: [] })
  })

  it('does not ask the server about a version that was never uploaded', async () => {
    vi.mocked(api.post).mockRejectedValue(new Error('initiate exploded'))

    const id = useUploadStore.getState().startUpload(makeFile(), 'project-1', 'clip')
    await settled(id)

    // Failed, not interrupted: initiate never returned, so there is no multipart
    // upload holding bytes and nothing to come back to.
    expect(rowOf(id).status).toBe('failed')
    // No completion was attempted, so there is nothing for the server to
    // contradict and no reason to spend a request asking.
    expect(api.get).not.toHaveBeenCalled()
  })
})


describe('races during the recovery read', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useUploadStore.setState({ files: [] })
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => '"etag-1"' },
    }) as never
  })

  it('does not overwrite a cancel the user made while it was asking', async () => {
    // The row stays `uploading` for the whole round-trip and the panel keeps
    // offering Cancel, so the user can act inside the window the re-read opened.
    const { aborts } = mockUploadWithFailingCompletion()
    let release: (v: unknown) => void = () => {}
    vi.mocked(api.get).mockImplementation(
      () => new Promise((r) => { release = r }) as never,
    )

    const id = useUploadStore.getState().startUpload(makeFile(), 'project-1', 'clip')
    await vi.waitFor(() => expect(api.get).toHaveBeenCalled())

    useUploadStore.getState().cancelUpload(id)
    expect(rowOf(id).status).toBe('cancelled')

    release({ id: ASSET_ID, latest_version: { id: VERSION_ID, processing_status: 'processing' } })
    // Settle fully rather than waiting for the status to move: the whole point is
    // that it must NOT move, so a helper that returns as soon as it leaves
    // `uploading` would pass here without the recovery write ever being attempted.
    await new Promise((r) => setTimeout(r, 20))

    // The user's decision outranks the answer that arrived after it.
    expect(rowOf(id).status).toBe('cancelled')
    // And it still reaches the abort. The error being handled here is the
    // completion's, not an AbortError, so a cancel that lands inside the recovery
    // window is only visible in the row -- which is why the abort is gated on the
    // row rather than on the error that got us here.
    expect(aborts).toHaveLength(1)
  })

  it('finishes by itself when the object turned out to be assembled', async () => {
    // The object was assembled and the status write never landed, so the version
    // is still `uploading` and the asset read says "not landed". This used to be
    // corrected as a side effect of the abort, which found the object on its way
    // past. The question is now asked directly, of an endpoint whose whole job is
    // answering it -- and nothing has to be destroyed to get the answer.
    const { aborts } = mockUploadWithFailingCompletion()
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (path.endsWith('/parts')) {
        return Promise.resolve({
          state: 'assembled',
          upload_id: 'u1',
          s3_key: 'raw/p/a/v/original.mp4',
          asset_id: ASSET_ID,
          version_id: VERSION_ID,
          chunk_size_bytes: 10 * 1024 * 1024,
          file_size_bytes: 1024,
          original_filename: 'clip.mp4',
          mime_type: 'video/mp4',
          held_part_numbers: [],
        }) as never
      }
      return Promise.resolve({
        id: ASSET_ID,
        latest_version: { id: PREVIOUS_VERSION_ID, processing_status: 'ready' },
      }) as never
    })
    // The retried completion is the one that succeeds; the first still throws.
    let completions = 0
    const originalPost = vi.mocked(api.post).getMockImplementation()!
    vi.mocked(api.post).mockImplementation((path: string, body?: unknown) => {
      if (path === '/upload/complete' && ++completions > 1) return Promise.resolve({}) as never
      return originalPost(path, body)
    })

    const id = useUploadStore.getState().startUpload(makeFile(), 'project-1', 'clip')
    await vi.waitFor(() => expect(rowOf(id).status).toBe('processing'))

    expect(aborts).toEqual([])
  })

  it('stays interrupted when the object is not assembled after all', async () => {
    // The other branch of the same question: nothing to finish, so the row keeps
    // its offer to resume rather than being written off.
    const { aborts } = mockUploadWithFailingCompletion()
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (path.endsWith('/parts')) {
        return Promise.reject(new Error('Failed to fetch')) as never
      }
      return Promise.resolve({
        id: ASSET_ID,
        latest_version: { id: PREVIOUS_VERSION_ID, processing_status: 'ready' },
      }) as never
    })

    const id = useUploadStore.getState().startUpload(makeFile(), 'project-1', 'clip')
    await settled(id)

    expect(rowOf(id).status).toBe('interrupted')
    expect(aborts).toEqual([])
  })
})
