/**
 * Renaming an asset from the row that is uploading it.
 *
 * The name is chosen in the dialog before the upload starts -- and a file
 * dropped straight onto a folder never sees that dialog -- so the row in the
 * panel is the first place the name and the moving file are on screen
 * together. What the tests below are really pinning is which rows may not be
 * renamed, because both of those look renameable from the outside and both
 * fail somewhere the user would not connect to this click.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
  api: { post: vi.fn(), get: vi.fn(), patch: vi.fn() },
}))
const mutateSpy = vi.fn()
vi.mock('swr', () => ({ mutate: (...args: unknown[]) => mutateSpy(...args) }))

import { api } from '@/lib/api'
import { useUploadStore, type UploadFile } from '../upload-store'

function row(patch: Partial<UploadFile> = {}): UploadFile {
  return {
    id: 'row-1',
    fileName: 'A047C012_230815_R1AB.mov',
    fileSize: 1024,
    fileType: 'video/quicktime',
    projectId: 'p1',
    assetName: 'A047C012_230815_R1AB',
    progress: 40,
    processingProgress: 0,
    status: 'uploading',
    assetId: 'a1',
    ...patch,
  } as UploadFile
}

function seed(...files: UploadFile[]) {
  useUploadStore.setState({ files })
}

const names = () => useUploadStore.getState().files.map((f) => f.assetName)

describe('renaming a row that is uploading', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seed()
  })

  it('stores the new name on the asset the row is filling', async () => {
    // `asset_id` is written the moment initiate answers, long before the last
    // part goes up, so the asset to rename exists at 40%.
    vi.mocked(api.patch).mockResolvedValue({})
    seed(row())

    const error = await useUploadStore.getState().renameUpload('row-1', 'Ep04 — Rohschnitt')

    expect(error).toBeNull()
    expect(api.patch).toHaveBeenCalledWith('/assets/a1', { name: 'Ep04 — Rohschnitt' })
    expect(names()).toEqual(['Ep04 — Rohschnitt'])
  })

  it('trims what was typed', async () => {
    vi.mocked(api.patch).mockResolvedValue({})
    seed(row())

    await useUploadStore.getState().renameUpload('row-1', '  Ep04  ')

    expect(api.patch).toHaveBeenCalledWith('/assets/a1', { name: 'Ep04' })
  })

  it('does nothing for a name that did not change', async () => {
    seed(row())

    await useUploadStore.getState().renameUpload('row-1', 'A047C012_230815_R1AB')

    expect(api.patch).not.toHaveBeenCalled()
  })

  it('does nothing for an empty name', async () => {
    // Clearing the field and pressing Enter must not name the asset "".
    seed(row())

    await useUploadStore.getState().renameUpload('row-1', '   ')

    expect(api.patch).not.toHaveBeenCalled()
    expect(names()).toEqual(['A047C012_230815_R1AB'])
  })

  it('refreshes the asset lists behind the panel', async () => {
    // The panel is mounted in the dashboard layout, so it has no handle on the
    // grid it floats over. Without this the card behind it keeps the old name
    // until the next navigation.
    vi.mocked(api.patch).mockResolvedValue({})
    seed(row())

    await useUploadStore.getState().renameUpload('row-1', 'Ep04')

    const matcher = mutateSpy.mock.calls[0][0] as (key: unknown) => boolean
    expect(matcher('/projects/p1/assets?folder_id=root')).toBe(true)
    expect(matcher('/assets/a1')).toBe(true)
    expect(matcher('/projects/p1/folders?parent_id=root')).toBe(false)
    expect(matcher(null)).toBe(false)
  })

  it('revalidates without blanking what is on screen first', async () => {
    // swr short-circuits to a pure revalidate only below three arguments. With
    // three it falls through to `populateCache`, which defaults to true, and
    // writes `undefined` into every matching key before refetching: the grid
    // behind the panel becomes skeletons for the length of the refetch, and
    // the review screen's comment list reads "No comments yet", because
    // `use-comments` does `data ?? []` and the page passes no `isLoading`.
    // Both forms revalidate, so the extra arguments only buy the blank.
    vi.mocked(api.patch).mockResolvedValue({})
    seed(row())

    await useUploadStore.getState().renameUpload('row-1', 'Ep04')

    expect(mutateSpy).toHaveBeenCalledTimes(1)
    expect(mutateSpy.mock.calls[0]).toHaveLength(1)
  })

  it('puts the old name back when the server refuses', async () => {
    // The row is renamed before the request goes out, because leaving the old
    // name up for a round trip reads as the edit not having taken.
    vi.mocked(api.patch).mockRejectedValue(new Error('Asset not found'))
    seed(row())

    const error = await useUploadStore.getState().renameUpload('row-1', 'Ep04')

    expect(error).toBe('Asset not found')
    expect(names()).toEqual(['A047C012_230815_R1AB'])
  })

  it('leaves the other rows alone', async () => {
    vi.mocked(api.patch).mockResolvedValue({})
    seed(row(), row({ id: 'row-2', assetId: 'a2', assetName: 'Second' }))

    await useUploadStore.getState().renameUpload('row-1', 'Ep04')

    expect(names()).toEqual(['Ep04', 'Second'])
  })
})

describe('renaming a row that has not reached the server yet', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seed()
  })

  it('renames the row without a request, because there is no asset yet', async () => {
    // `/upload/initiate` is what creates the asset and hands back its id.
    // Until it answers, the row is the only record of the name -- and it is
    // the record initiate reads, so nothing is lost by keeping it here.
    seed(row({ status: 'pending', assetId: undefined }))

    const error = await useUploadStore.getState().renameUpload('row-1', 'Ep04')

    expect(error).toBeNull()
    expect(api.patch).not.toHaveBeenCalled()
    expect(names()).toEqual(['Ep04'])
  })
})

describe('rows that may not be renamed', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seed()
  })

  it('a history row, which is not proof of the role the rename needs', async () => {
    // History comes from `/me/assets?filter=owned`, so the rows are the user's
    // own assets. Creating one is still not proof of holding the editor role
    // today: that query has no membership term, so an asset outlives the
    // demotion or removal that took the right to rename it, and the UI would be
    // offering an edit that answers 403.
    seed(row({ id: 'history-a1', fromHistory: true, status: 'complete' }))

    const error = await useUploadStore.getState().renameUpload('history-a1', 'Ep04')

    expect(error).toBeNull()
    expect(api.patch).not.toHaveBeenCalled()
  })

  it('a row that is not there at all', async () => {
    const error = await useUploadStore.getState().renameUpload('gone', 'Ep04')

    expect(error).toBeNull()
    expect(api.patch).not.toHaveBeenCalled()
  })
})
