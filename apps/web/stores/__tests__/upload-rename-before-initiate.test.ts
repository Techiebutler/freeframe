/**
 * Renaming a row before the asset it names exists.
 *
 * The panel offers the pencil from the moment the row appears, which is before
 * `/upload/initiate` has answered and therefore before there is anything on the
 * server to PATCH. There is exactly one window to get right, and it is not the
 * one it looks like: `startUpload` runs synchronously until its first await, so
 * initiate is already dispatched by the time the row is on screen. What can be
 * edited is the round trip -- and an edit made there went into the row while
 * the request carrying the old name had already left.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
  api: { post: vi.fn(), get: vi.fn(), patch: vi.fn() },
}))
vi.mock('swr', () => ({ mutate: vi.fn() }))

import { api } from '@/lib/api'
import { useUploadStore } from '../upload-store'

/** A promise the test decides when to resolve. */
function gate<T>() {
  let open!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

const INITIATE = {
  upload_id: 'u1',
  s3_key: 'projects/p1/a1.mov',
  asset_id: 'a1',
  version_id: 'v1',
}

/** Records what initiate was told, and lets the test hold it open. */
function mockUpload(holdInitiate?: Promise<unknown>) {
  const sent: Record<string, unknown>[] = []
  vi.mocked(api.post).mockImplementation(async (path: string, body?: unknown) => {
    if (path === '/upload/initiate') {
      sent.push(body as Record<string, unknown>)
      if (holdInitiate) await holdInitiate
      return INITIATE as never
    }
    if (path === '/upload/presign-part') {
      return { presigned_url: 'https://store.test/part-1' } as never
    }
    return {} as never
  })
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, headers: { get: () => '"etag-1"' } }),
  )
  return sent
}

const file = () => new File([new Uint8Array(8)], 'A047C012_230815_R1AB.mov', {
  type: 'video/quicktime',
})

const settle = () => new Promise((r) => setTimeout(r, 0))

describe('a rename made while initiate is in flight', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useUploadStore.setState({ files: [] })
  })

  it('is applied to the asset as soon as there is one', async () => {
    // The one window where the edit can be lost: it went into the row, and the
    // request carrying the old name had already left.
    const held = gate<void>()
    const sent = mockUpload(held.promise)

    const id = useUploadStore.getState().startUpload(
      file(), 'p1', 'A047C012_230815_R1AB', 'Season 2', null,
    )
    await settle()
    expect(sent[0].asset_name).toBe('A047C012_230815_R1AB')

    await useUploadStore.getState().renameUpload(id, 'Ep04 Rohschnitt')
    held.open()
    await settle()

    expect(api.patch).toHaveBeenCalledWith('/assets/a1', { name: 'Ep04 Rohschnitt' })
  })

  it('does not correct a name that never changed', async () => {
    const held = gate<void>()
    mockUpload(held.promise)

    useUploadStore.getState().startUpload(file(), 'p1', 'Rushes', 'Season 2', null)
    await settle()
    held.open()
    await settle()

    expect(api.patch).not.toHaveBeenCalled()
  })

  it('does not fail the upload when the correction is refused', async () => {
    // The bytes are the point. A name is a correction the user can make again;
    // a transfer thrown away because of one is not.
    const held = gate<void>()
    mockUpload(held.promise)
    vi.mocked(api.patch).mockRejectedValue(new Error('boom'))

    const id = useUploadStore.getState().startUpload(file(), 'p1', 'Rushes', 'Season 2', null)
    await settle()
    await useUploadStore.getState().renameUpload(id, 'Ep04')
    held.open()
    await settle()

    const row = useUploadStore.getState().files.find((f) => f.id === id)
    expect(row?.status).not.toBe('failed')
  })

  it('puts the refused name back and says why', async () => {
    // Swallowing it left the row showing a name the asset never took, for the
    // rest of the session, while the grid, search and the share link all
    // showed the old one -- with nothing on screen to say so, because this
    // correction is sent without a click behind it.
    const held = gate<void>()
    mockUpload(held.promise)
    vi.mocked(api.patch).mockRejectedValue(new Error('Name too long'))

    const id = useUploadStore.getState().startUpload(file(), 'p1', 'Rushes', 'Season 2', null)
    await settle()
    await useUploadStore.getState().renameUpload(id, 'Ep04')
    held.open()
    await settle()

    const row = useUploadStore.getState().files.find((f) => f.id === id)
    expect(row?.assetName).toBe('Rushes')
    expect(row?.renameError).toBe('Name too long')
  })

  it('lets the same name be retried after a refusal', async () => {
    // `renameUpload` returns early when the typed name equals the row's, so a
    // row left holding the refused name answered a retry of it with silence.
    const held = gate<void>()
    mockUpload(held.promise)
    vi.mocked(api.patch).mockRejectedValue(new Error('boom'))

    const id = useUploadStore.getState().startUpload(file(), 'p1', 'Rushes', 'Season 2', null)
    await settle()
    await useUploadStore.getState().renameUpload(id, 'Ep04')
    held.open()
    await settle()

    vi.mocked(api.patch).mockResolvedValue({} as never)
    vi.mocked(api.patch).mockClear()
    await useUploadStore.getState().renameUpload(id, 'Ep04')

    expect(api.patch).toHaveBeenCalledWith('/assets/a1', { name: 'Ep04' })
    const row = useUploadStore.getState().files.find((f) => f.id === id)
    expect(row?.assetName).toBe('Ep04')
    expect(row?.renameError).toBeUndefined()
  })
})
