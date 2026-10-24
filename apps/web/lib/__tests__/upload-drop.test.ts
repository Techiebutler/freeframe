/**
 * Starting a drop or a pick: the dropped folders are found or made under the
 * folder dropped onto (`POST /projects/{id}/folders/ensure`), then every file is
 * queued, in the order it came, into its own folder.
 *
 * The API is mocked; the upload store is the real one, with its queue held so
 * nothing starts (every initiate waits).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  api: { post: vi.fn(), get: vi.fn(), patch: vi.fn() },
}))
vi.mock('swr', () => ({ mutate: vi.fn() }))

import { mutate as swrMutate } from 'swr'
import { api, ApiError } from '@/lib/api'
import { useUploadStore, visibleDropNotes, __uploadQueueTesting as testing } from '@/stores/upload-store'
import { signInAs, signOutElsewhere } from '@/test/upload-session'
import type { Collected, DropFile } from '../upload-folder-walk'
import { startDrop, MAX_ENSURE_NODES, MAX_ENSURE_PATHS } from '../upload-drop'

type EnsureBody = { parent_id: string | null; paths: string[][] }

const ensureCalls: EnsureBody[] = []
let ensureAnswer: (body: EnsureBody, index: number) => Promise<unknown>

/** A folder id for every path, from its segments. */
const idFor = (path: string[]) => `id:${path.join('/')}`

function installServer() {
  ensureCalls.length = 0
  ensureAnswer = async (body) => ({
    folders: body.paths.map((path) => ({ path, folder_id: idFor(path) })),
  })
  vi.mocked(api.post).mockImplementation(((path: string, body?: unknown) => {
    if (/^\/projects\/[^/]+\/folders\/ensure$/.test(path)) {
      const b = body as EnsureBody
      ensureCalls.push(b)
      return ensureAnswer(b, ensureCalls.length - 1)
    }
    // Every initiate waits: the rows stay queued or starting for the test to read.
    return new Promise(() => {})
  }) as never)
}

const media = (name: string, dirs: string[] = [], size = 10): DropFile => ({
  file: new File([new Uint8Array(size)], name, { type: '' }),
  dirs,
})
const collected = (files: DropFile[], unread: Partial<Collected> = {}): Collected => ({
  files,
  unreadable: 0,
  unreadableFolders: 0,
  ...unread,
})
const dest = { projectId: 'p1', projectName: 'Launch', folderId: 'f-here' as string | null }

const rows = () =>
  useUploadStore
    .getState()
    .files.slice()
    .sort((a, b) => (a.queueSeq ?? 0) - (b.queueSeq ?? 0))
const notes = () => visibleDropNotes(useUploadStore.getState()).map((n) => n.text)

beforeEach(() => {
  vi.clearAllMocks()
  testing.reset()
  window.localStorage.clear()
  useUploadStore.setState({ files: [], dropNotes: [], panelOpen: false })
  signInAs('user-1')
  vi.mocked(api.get).mockImplementation(() => new Promise(() => {}) as never)
  installServer()
})

afterEach(() => {
  vi.restoreAllMocks()
  testing.reset()
})

/** The folder each queued file's initiate will name, by file name. */
function initiatedFolders(): Record<string, unknown> {
  return Object.fromEntries(rows().map((r) => [r.fileName, testing.folderOf(r.id)]))
}

describe('loose files', () => {
  it('queues them into the folder dropped onto, without asking for folders', async () => {
    const out = await startDrop(collected([media('a.mov'), media('b.jpg')]), dest)

    expect(out.kind).toBe('queued')
    expect(ensureCalls).toEqual([])
    expect(rows().map((r) => [r.fileName, r.assetName, r.fileType])).toEqual([
      ['a.mov', 'a.mov', 'video/quicktime'],
      ['b.jpg', 'b.jpg', 'image/jpeg'],
    ])
    expect(initiatedFolders()).toEqual({ 'a.mov': 'f-here', 'b.jpg': 'f-here' })
  })
})

describe('a dropped folder', () => {
  it('asks for its folders under the folder dropped onto and queues each file into its own', async () => {
    const out = await startDrop(
      collected([
        media('top.mov', ['Shoot']),
        media('b.mov', ['Shoot', 'Day 1']),
        media('loose.mov'),
        media('c.mov', ['Shoot', 'Day 1']),
      ]),
      dest,
    )

    expect(out.kind).toBe('queued')
    expect(ensureCalls).toEqual([{ parent_id: 'f-here', paths: [['Shoot'], ['Shoot', 'Day 1']] }])
    // Drop order, not folder order.
    expect(rows().map((r) => r.fileName)).toEqual(['top.mov', 'b.mov', 'loose.mov', 'c.mov'])
    expect(initiatedFolders()).toEqual({
      'top.mov': 'id:Shoot',
      'b.mov': 'id:Shoot/Day 1',
      'loose.mov': 'f-here',
      'c.mov': 'id:Shoot/Day 1',
    })
  })

  it('sends a file whose folder was cut to nothing into the folder dropped onto', async () => {
    ensureAnswer = async (body) => ({ folders: body.paths.map((path) => ({ path, folder_id: null })) })

    await startDrop(collected([media('a.mov', ['Deep'])]), dest)

    expect(initiatedFolders()).toEqual({ 'a.mov': 'f-here' })
  })

  it('at the project root asks with no parent', async () => {
    await startDrop(collected([media('a.mov', ['Shoot'])]), { ...dest, folderId: null })

    expect(ensureCalls[0].parent_id).toBeNull()
  })

  it('cuts every path to 10 folders before asking', async () => {
    const deep = Array.from({ length: 12 }, (_, i) => `L${i + 1}`)

    await startDrop(collected([media('a.mov', deep)]), dest)

    expect(ensureCalls[0].paths).toEqual([deep.slice(0, 10)])
    expect(initiatedFolders()).toEqual({ 'a.mov': idFor(deep.slice(0, 10)) })
  })

  it('asks in requests of at most 500 paths, one after another', async () => {
    let inFlight = 0
    let most = 0
    ensureAnswer = async (body) => {
      inFlight++
      most = Math.max(most, inFlight)
      await new Promise((r) => setTimeout(r, 0))
      inFlight--
      return { folders: body.paths.map((path) => ({ path, folder_id: idFor(path) })) }
    }
    const files = Array.from({ length: 501 }, (_, i) => media(`${i}.mov`, [`F${i}`]))

    await startDrop(collected(files), dest)

    expect(ensureCalls.map((c) => c.paths.length)).toEqual([MAX_ENSURE_PATHS, 1])
    expect(most).toBe(1)
    expect(rows()).toHaveLength(501)
  })

  it('keeps each request within 2,000 distinct folders, parents first', async () => {
    // 300 paths of ten folders that share nothing: 3,000 folders in all.
    const files = Array.from({ length: 300 }, (_, i) =>
      media(`${i}.mov`, Array.from({ length: 10 }, (_, d) => `P${i}-${d}`)),
    )

    await startDrop(collected(files), dest)

    expect(ensureCalls.length).toBeGreaterThan(1)
    for (const call of ensureCalls) {
      const nodes = new Set(call.paths.flatMap((p) => p.map((_, i) => JSON.stringify(p.slice(0, i + 1)))))
      expect(nodes.size).toBeLessThanOrEqual(MAX_ENSURE_NODES)
    }
    const lengths = ensureCalls.flatMap((c) => c.paths.map((p) => p.length))
    expect(lengths).toEqual([...lengths].sort((a, b) => a - b))
  })

  it('refreshes the folder lists once the folders exist, before queueing', async () => {
    await startDrop(collected([media('a.mov', ['Shoot'])]), dest)

    expect(swrMutate).toHaveBeenCalled()
    const matcher = vi.mocked(swrMutate).mock.calls[0][0] as (key: unknown) => boolean
    expect(matcher('/projects/p1/folder-tree')).toBe(true)
    expect(matcher('/projects/p1/folders?parent_id=f-here')).toBe(true)
    expect(matcher('/projects/p2/folder-tree')).toBe(false)
  })
})

describe('what a drop leaves out', () => {
  it('queues nothing and says why when the folders cannot be made', async () => {
    ensureAnswer = async () => {
      throw new ApiError(400, 'Folder not found in this project')
    }

    const out = await startDrop(collected([media('a.mov', ['Shoot']), media('b.mov')]), dest)

    expect(out.kind).toBe('failed')
    expect(rows()).toEqual([])
    expect(notes()).toEqual(['Could not create folders: Folder not found in this project. Nothing was uploaded.'])
    expect(useUploadStore.getState().panelOpen).toBe(true)
  })

  it('queues nothing when a later request fails, though earlier ones made folders', async () => {
    ensureAnswer = async (body, i) => {
      if (i === 1) throw new TypeError('Failed to fetch')
      return { folders: body.paths.map((path) => ({ path, folder_id: idFor(path) })) }
    }
    const files = Array.from({ length: 501 }, (_, i) => media(`${i}.mov`, [`F${i}`]))

    const out = await startDrop(collected(files), dest)

    expect(out.kind).toBe('failed')
    expect(rows()).toEqual([])
    expect(notes()).toEqual(['Could not create folders: Failed to fetch. Nothing was uploaded.'])
  })

  it('says how many files were skipped and which kinds, and uploads the rest', async () => {
    await startDrop(
      collected([media('notes.txt', ['Shoot']), media('a.zip', ['Shoot']), media('b.txt'), media('a.mov', ['Shoot'])]),
      dest,
    )

    expect(rows().map((r) => r.fileName)).toEqual(['a.mov'])
    expect(notes()).toEqual(["Skipped 3 files that can't be uploaded (.txt, .zip)"])
  })

  it('leaves a note when everything was skipped, and asks for no folders', async () => {
    const out = await startDrop(collected([media('notes.txt', ['Docs'])]), dest)

    expect(out.kind).toBe('nothing')
    expect(ensureCalls).toEqual([])
    expect(rows()).toEqual([])
    expect(notes()).toEqual(["Skipped 1 file that can't be uploaded (.txt)"])
    expect(useUploadStore.getState().panelOpen).toBe(true)
  })

  it('leaves a note when there was nothing at all to upload', async () => {
    const out = await startDrop(collected([]), dest)

    expect(out.kind).toBe('nothing')
    expect(notes()).toEqual(['There were no files to upload.'])
  })

  it('says how many files or folders could not be read', async () => {
    await startDrop(collected([media('a.mov')], { unreadable: 2, unreadableFolders: 1 }), dest)

    expect(rows()).toHaveLength(1)
    expect(notes()).toEqual(['3 files or folders could not be read'])
  })

  it('with nobody signed in asks for nothing, queues nothing and leaves no note', async () => {
    signOutElsewhere()

    const out = await startDrop(collected([media('a.mov', ['Shoot'])]), dest)

    expect(out.kind).toBe('signed-out')
    expect(api.post).not.toHaveBeenCalled()
    expect(rows()).toEqual([])
    expect(notes()).toEqual([])
    expect(useUploadStore.getState().panelOpen).toBe(false)
  })
})
