/**
 * What a folder drop needs from the upload queue.
 *
 * Every file of a dropped folder lands in its own folder, so a drop can no
 * longer be one target for all of its files: each queued file carries its own.
 * Files read out of a folder have no browser type, so the type the drop
 * planned is the one sent. A drop that leaves files out says so in the panel
 * (drop notes). And cancelling a few hundred queued files is one write, not
 * one per file.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  api: { post: vi.fn(), get: vi.fn(), patch: vi.fn() },
}))
vi.mock('swr', () => ({ mutate: vi.fn() }))

import { api } from '@/lib/api'
import { useUploadStore, visibleDropNotes, __uploadQueueTesting as testing } from '../upload-store'
import { signInAs } from '@/test/upload-session'
import { fakeServer, fileOf, files, settle } from '@/test/upload-queue-server'

beforeEach(() => {
  vi.clearAllMocks()
  testing.reset()
  window.localStorage.clear()
  useUploadStore.setState({ files: [], dropNotes: [], panelOpen: false })
  signInAs('user-1')
  vi.mocked(api.get).mockImplementation(() => new Promise(() => {}) as never)
})

afterEach(() => {
  vi.restoreAllMocks()
  testing.reset()
})

describe('startUploads with a target per file', () => {
  it('sends each file to its own folder, and the drop’s folder to a file that names none', async () => {
    const server = fakeServer()
    useUploadStore.getState().startUploads(
      [
        { file: fileOf('a.mov'), assetName: 'a.mov', folderId: 'f-day1' },
        { file: fileOf('b.mov'), assetName: 'b.mov', folderId: null },
        { file: fileOf('c.mov'), assetName: 'c.mov' },
      ],
      'p1',
      'Project',
      'f-drop',
    )
    await settle()

    expect(server.initiates.map((i) => [i.body.original_filename, i.body.folder_id])).toEqual([
      ['a.mov', 'f-day1'],
      ['b.mov', null],
      ['c.mov', 'f-drop'],
    ])
  })

  it('sends the type the drop planned rather than the browser’s empty one', async () => {
    const server = fakeServer()
    const file = fileOf('clip.mov', 1024, '')
    useUploadStore.getState().startUploads(
      [{ file, assetName: 'clip.mov', mimeType: 'video/quicktime' }],
      'p1',
    )
    await settle()

    expect(server.initiates[0].body.mime_type).toBe('video/quicktime')
    expect(files()[0].fileType).toBe('video/quicktime')
  })
})

describe('cancelAllQueued', () => {
  it('cancels every queued row in one store write', async () => {
    fakeServer(() => 'wait')
    useUploadStore.getState().startUploads(
      Array.from({ length: 60 }, (_, i) => ({ file: fileOf(`q${i}.mov`), assetName: `q${i}` })),
      'p1',
    )
    await settle()
    const queued = files().filter((f) => f.status === 'queued')
    expect(queued.length).toBeGreaterThan(50)

    const writes = vi.fn()
    const unsubscribe = useUploadStore.subscribe(writes)
    const saves = vi.spyOn(Storage.prototype, 'setItem')
    useUploadStore.getState().cancelAllQueued()
    unsubscribe()

    expect(files().filter((f) => f.status === 'queued')).toEqual([])
    expect(writes).toHaveBeenCalledTimes(1)
    expect(saves.mock.calls.filter(([key]) => key === 'ff-uploads')).toHaveLength(1)
  })
})

describe('drop notes', () => {
  it('adds a note for the signed-in account, opens the panel, and dismisses it', () => {
    useUploadStore.getState().addDropNote("Skipped 2 files that can't be uploaded (.txt)")

    const notes = visibleDropNotes(useUploadStore.getState())
    expect(notes.map((n) => n.text)).toEqual(["Skipped 2 files that can't be uploaded (.txt)"])
    expect(useUploadStore.getState().panelOpen).toBe(true)

    useUploadStore.getState().dismissDropNote(notes[0].id)
    expect(visibleDropNotes(useUploadStore.getState())).toEqual([])
  })

  it('shows another account none of the notes', () => {
    useUploadStore.getState().addDropNote('Skipped 1 file')
    signInAs('user-2')

    expect(visibleDropNotes(useUploadStore.getState())).toEqual([])
  })

  it('keeps notes out of storage', () => {
    useUploadStore.getState().addDropNote('Skipped 1 file')

    expect(window.localStorage.getItem('ff-uploads') ?? '').not.toContain('Skipped 1 file')
  })
})
