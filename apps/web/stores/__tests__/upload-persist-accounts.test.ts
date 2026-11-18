/**
 * Saved upload rows are kept per account, hidden, and never deleted by another
 * account's writes (spec goal 10).
 *
 * `ff-uploads` is one localStorage key that every tab of the origin shares, and
 * zustand's persist rewrites the whole of it after every `set`. A tab signed in
 * as Y holds X's rows only hidden, or not at all if another tab wrote them, so
 * without care Y's next write would erase them, and X would sign back in to an
 * empty panel. Rows saved before this release carry no owner at all; they are
 * kept stored until they are claimed or dropped. Some cases here stand in for
 * the check with the server by setting the owner by hand; the check itself is
 * covered in `upload-adopt-and-history.test.ts`.
 *
 * Every case asserts what localStorage holds, which is what the next page load
 * and every other tab read, and not only the store's state.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// One set of mocks, and one `ApiError`, for every load of the store: a store
// `loadAgain` imports asks the server through the same functions.
const shared = vi.hoisted(() => ({
  api: { post: vi.fn(), get: vi.fn(), patch: vi.fn() },
  ApiError: undefined as unknown,
}))
vi.mock('@/lib/api', async (orig) => {
  const real = await orig<typeof import('@/lib/api')>()
  shared.ApiError ??= real.ApiError
  return { ...real, api: shared.api, ApiError: shared.ApiError }
})
vi.mock('swr', () => ({ mutate: vi.fn() }))

import { api, ApiError } from '@/lib/api'
import {
  useUploadStore, visibleFiles, currentTabId, LIVE_WINDOW_MS, __uploadQueueTesting as testing,
} from '../upload-store'
import type { UploadFile } from '../upload-store'
import { signInAs, signOutElsewhere, writeTokenUnannounced, row } from '@/test/upload-session'
import { fakeServer, fileOf, small, drop, rowOf, files, stored, settle, resumable } from '@/test/upload-queue-server'

const KEY = 'ff-uploads'
const X = 'user-x'
const Y = 'user-y'
const OTHER_TAB = 'some-other-tab'

/** The row as a write stores it: JSON drops the fields that are undefined. */
const asStored = (f: UploadFile): UploadFile => JSON.parse(JSON.stringify(f))
const storedRow = (id: string) => stored().find((f) => f.id === id)
const storedIds = () => stored().map((f) => f.id).sort()
const blob = () => JSON.parse(window.localStorage.getItem(KEY)!) as { state: { files: UploadFile[] }; version: number }

/** Another tab (or a tab still on the pre-release bundle) writes the key outright. */
function anotherTabWrites(rows: UploadFile[], version = 1) {
  window.localStorage.setItem(KEY, JSON.stringify({ state: { files: rows }, version }))
}

/** A row saved before rows had owners: an interrupted upload with a version to check. */
function ownerless(id: string, over: Partial<UploadFile> = {}): UploadFile {
  const r = row({
    id, status: 'interrupted', versionId: `${id}-v`, assetId: `${id}-a`, uploadId: `${id}-u`,
    ownerTab: OTHER_TAB, heartbeatAt: Date.now() - LIVE_WINDOW_MS * 3, ...over,
  })
  delete r.ownerId
  return r
}

/** A promise settled by hand. */
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

/** Any write at all from this tab: the panel opening is the most ordinary one. */
const thisTabWrites = () => useUploadStore.getState().setPanelOpen(!useUploadStore.getState().panelOpen)

/**
 * A page load of its own, reading whatever storage holds now. Its account is
 * the token's at load. It is not told of later sign-ins and does not announce
 * itself to other tabs, so it cannot write into a later case's storage.
 */
async function loadAgain(): Promise<typeof import('../upload-store')> {
  vi.resetModules()
  const listen = vi.spyOn(window, 'addEventListener').mockImplementation(() => {})
  vi.stubGlobal('BroadcastChannel', undefined)
  try {
    return await import('../upload-store')
  } finally {
    listen.mockRestore()
    vi.unstubAllGlobals()
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  testing.reset()
  useUploadStore.setState({ files: [], panelOpen: false })
  window.localStorage.clear()
  signOutElsewhere()
  signInAs(Y)
  vi.mocked(api.get).mockResolvedValue([] as never)
})

afterEach(() => {
  vi.restoreAllMocks()
  testing.reset()
})

describe('saved rows of other accounts', () => {
  it("another account's rows survive this account's writes", () => {
    const y1 = row({ id: 'y1', ownerId: Y })
    // X's rows as another tab wrote them, long after any of them was last stamped.
    const xa = row({ id: 'xa', ownerId: X, status: 'interrupted', versionId: 'xa-v', ownerTab: OTHER_TAB, heartbeatAt: Date.now() - LIVE_WINDOW_MS * 5 })
    const xb = row({ id: 'xb', ownerId: X, status: 'interrupted', versionId: 'xb-v', progress: 30, ownerTab: OTHER_TAB, heartbeatAt: Date.now() - LIVE_WINDOW_MS * 4 })
    const o1 = ownerless('o1')
    // This tab holds Y's row and a copy of xb it read earlier, stamped more
    // recently than what storage holds now. It is not this tab's to publish.
    useUploadStore.setState({ files: [y1, { ...xb, progress: 10, heartbeatAt: Date.now() - LIVE_WINDOW_MS * 2 }] })
    anotherTabWrites([y1, xa, xb, o1])

    thisTabWrites()

    expect(storedIds()).toEqual(['o1', 'xa', 'xb', 'y1'])
    expect(storedRow('xa')).toEqual(asStored(xa))
    expect(storedRow('xb')).toEqual(asStored(xb))
    expect(storedRow('o1')).toEqual(asStored(o1))
    // Hidden, never deleted: only Y's own row shows.
    expect(visibleFiles(useUploadStore.getState()).map((f) => f.id)).toEqual(['y1'])

    // Y dismisses its own row; X's rows and the ownerless one are untouched.
    useUploadStore.getState().removeFile('y1')

    expect(storedIds()).toEqual(['o1', 'xa', 'xb'])
    expect(storedRow('xa')).toEqual(asStored(xa))
    expect(storedRow('xb')).toEqual(asStored(xb))
    expect(storedRow('o1')).toEqual(asStored(o1))
  })

  it("a row this tab finished for another account still leaves storage", () => {
    // The widened keep rule is for rows this tab never had. A row this tab
    // wrote itself and has since let go of -- here X's upload whose complete
    // was answered after Y signed in -- is this tab's to remove, or X would
    // sign back in to a Resume on an upload that already finished.
    signInAs(X)
    useUploadStore.setState({
      files: [row({ id: 'x1', ownerId: X, status: 'interrupted', versionId: 'v1', ownerTab: currentTabId(), heartbeatAt: Date.now() })],
    })
    expect(storedIds()).toEqual(['x1'])
    signInAs(Y)

    useUploadStore.setState((s) => ({ files: s.files.map((f) => ({ ...f, status: 'processing' as const })) }))

    expect(storedIds()).toEqual([])
  })

  it('X → Y → X while X\'s row is mid-transfer: the row is not offered Resume', async () => {
    signInAs(X)
    const server = fakeServer(() => 'answer', 'hang')
    const [x1] = drop([fileOf('x1.mov')])
    await settle()
    expect(rowOf(x1).status).toBe('uploading')
    expect(server.inFlight.length).toBeGreaterThan(0)

    signInAs(Y)
    thisTabWrites()
    // Bytes still move for X while Y is signed in, and this tab is the one
    // sending them: what it writes is the live row, not the copy from before.
    server.finishOne()
    await settle()
    expect(rowOf(x1).progress).toBeGreaterThan(0)
    expect(storedRow(x1)).toMatchObject({ status: 'uploading', ownerId: X, ownerTab: currentTabId(), progress: rowOf(x1).progress })

    // Meanwhile another tab saved an interrupted upload of X's that this tab never had.
    const xo = row({ id: 'xo', ownerId: X, status: 'interrupted', versionId: 'xo-v', ownerTab: OTHER_TAB, heartbeatAt: Date.now() - LIVE_WINDOW_MS * 2 })
    anotherTabWrites([...stored(), xo])

    signInAs(X)

    // The row this tab is sending is still uploading here, with its run, and
    // nothing offers Resume on it.
    expect(rowOf(x1).status).toBe('uploading')
    expect(testing.runningIds()).toEqual([x1])
    expect(testing.hasAbortController(x1)).toBe(true)
    expect(storedRow(x1)).toMatchObject({ status: 'uploading', ownerId: X })
    // The row X saved elsewhere comes back with X, judged as stored rows are.
    expect(rowOf('xo')).toMatchObject({ status: 'interrupted', ownerId: X })
    expect(visibleFiles(useUploadStore.getState()).map((f) => f.id).sort()).toEqual([x1, 'xo'].sort())
    expect(storedIds()).toEqual([x1, 'xo'].sort())
  })
})

describe('saved rows of this account that this tab never held', () => {
  it('a same-account row another tab saved after this tab loaded survives this tab\'s writes once its heartbeat is stale, and comes back on the next load', async () => {
    // Tab B, signed in as Y too, was sending a second version when it was
    // closed. History answers with the display version, so this row is the
    // only record of the upload: erasing it would lose the Resume outright.
    const b1 = row({
      id: 'b1', ownerId: Y, status: 'uploading', progress: 40, assetId: 'b1-a', versionId: 'b1-v', uploadId: 'b1-u',
      ownerTab: OTHER_TAB, heartbeatAt: Date.now() - LIVE_WINDOW_MS * 2,
    })
    anotherTabWrites([b1])

    thisTabWrites()
    thisTabWrites()

    expect(storedRow('b1')).toEqual(asStored(b1))

    const loaded = await loadAgain()
    const state = loaded.useUploadStore.getState()
    expect(state.files.find((f) => f.id === 'b1')).toMatchObject({ status: 'interrupted', versionId: 'b1-v', ownerId: Y })
    expect(loaded.visibleFiles(state).map((f) => f.id)).toEqual(['b1'])

    // Held by that load, so it is that tab's to dismiss.
    loaded.useUploadStore.getState().removeFile('b1')
    expect(storedIds()).toEqual([])
  })

  it('a hidden row whose discard drop lands after a switch is not resurrected', async () => {
    // X discards an upload loaded from a tab that has since closed; the
    // server's answer arrives after Y signed in. The row is gone for X, and
    // Y's writes must not put the stored copy back.
    signInAs(X)
    const xh = row({
      id: 'xh', ownerId: X, status: 'interrupted', assetId: 'xh-a', versionId: 'xh-v', uploadId: 'xh-u', s3Key: 'xh-k',
      ownerTab: OTHER_TAB, heartbeatAt: Date.now() - LIVE_WINDOW_MS * 2,
    })
    useUploadStore.setState({ files: [xh] })
    expect(storedIds()).toEqual(['xh'])
    let answer!: (info: unknown) => void
    // Only the discard's `/parts` waits; Y's sign-in also fetches Y's history.
    vi.mocked(api.get).mockImplementation(((path: string) => (path.startsWith('/me/assets')
      ? Promise.resolve([])
      : new Promise((r) => { answer = r }))) as never)
    vi.mocked(api.post).mockResolvedValue({} as never)

    const said = useUploadStore.getState().discardUpload('xh')
    await settle()
    signInAs(Y)
    answer(resumable({ version_id: 'xh-v', upload_id: 'xh-u', s3_key: 'xh-k', asset_id: 'xh-a' }))
    await said
    await settle()

    expect(files().map((f) => f.id)).toEqual([])
    expect(storedIds()).toEqual([])
    thisTabWrites()
    expect(storedIds()).toEqual([])
  })

  it('the storage event for an account a start already noticed changes nothing', async () => {
    signInAs(X)
    fakeServer(() => 'wait')
    // Y signs in elsewhere; Y's drop here notices it before the event arrives.
    writeTokenUnannounced(Y)
    drop([small('y1.jpg')])
    // Another tab saves a row of Y's in between.
    const late = row({ id: 'late', ownerId: Y, status: 'interrupted', versionId: 'late-v', ownerTab: OTHER_TAB })
    anotherTabWrites([...stored(), late])
    const before = files()

    signInAs(Y)

    expect(files()).toEqual(before)
    expect(files().filter((f) => f.id === 'late')).toEqual([])
    expect(storedRow('late')).toEqual(asStored(late))
  })
})

describe('rows saved before this release', () => {
  it('a v0 blob migrates with ownerless rows', async () => {
    const opts = (useUploadStore as unknown as {
      persist: { getOptions: () => { version?: number; migrate?: (s: unknown, v: number) => unknown } }
    }).persist.getOptions()
    expect(opts.version).toBe(1)
    const o1 = asStored(ownerless('o1'))
    const x1 = asStored(row({ id: 'x1', ownerId: X, status: 'failed', failedBeforeStart: true }))
    expect(opts.migrate!({ files: [o1, x1] }, 0)).toEqual({ files: [o1, x1] })

    // A real page load of a blob the pre-release bundle wrote. The server
    // says the row is another account's, so it stays ownerless.
    anotherTabWrites([o1, x1], 0)
    vi.mocked(api.get).mockRejectedValue(new ApiError(403, 'Not authorized for this upload'))
    const loaded = await loadAgain()
    await settle()

    const state = loaded.useUploadStore.getState()
    expect(state.files.find((f) => f.id === 'o1')).toMatchObject({ status: 'interrupted', versionId: 'o1-v' })
    expect(state.files.find((f) => f.id === 'o1')!.ownerId).toBeUndefined()
    expect(loaded.visibleFiles(state)).toEqual([])
    expect(blob().version).toBe(1)
    expect(storedIds()).toEqual(['o1', 'x1'])
    expect(storedRow('o1')).not.toHaveProperty('ownerId')
  })

  it('an ownerless row is still adopted after a write and a second load', async () => {
    // Saved by the pre-release bundle after this tab loaded, so this tab never had it.
    const o1 = ownerless('o1')
    anotherTabWrites([o1], 0)

    thisTabWrites()
    expect(storedRow('o1')).toEqual(asStored(o1))

    // The next load checks it with the server, which says it is Y's.
    const check = deferred<unknown>()
    vi.mocked(api.get).mockReturnValue(check.promise as never)
    const loaded = await loadAgain()
    expect(loaded.useUploadStore.getState().files.map((f) => f.id)).toEqual(['o1'])
    expect(loaded.useUploadStore.getState().files[0].ownerId).toBeUndefined()

    check.resolve({ state: 'uploading', parts: [] })
    await settle()

    expect(api.get).toHaveBeenCalledWith('/upload/o1-v/parts', { pinSubject: Y })
    expect(storedRow('o1')).toMatchObject({ ownerId: Y, versionId: 'o1-v' })
    expect(loaded.visibleFiles(loaded.useUploadStore.getState()).map((f) => f.id)).toEqual(['o1'])
  })

  it('a dropped ownerless row stays out of storage after a later write', () => {
    const o1 = ownerless('o1')
    useUploadStore.setState({ files: [o1] })
    expect(storedIds()).toEqual(['o1'])

    // Dropped, as the server check does on a 404 or 409.
    testing.dropSavedRow('o1')
    expect(files().map((f) => f.id)).toEqual([])
    expect(storedIds()).toEqual([])

    // A tab still on the pre-release bundle writes its copy back...
    anotherTabWrites([o1], 0)
    thisTabWrites()
    expect(storedIds()).toEqual([])

    // ...and again, and then an account signs in here: the row does not come
    // back into this tab, nor does this tab's write keep it.
    anotherTabWrites([o1], 0)
    signInAs(X)
    expect(files().map((f) => f.id)).toEqual([])
    expect(storedIds()).toEqual([])
  })

  it("an adopted row's owned copy wins over the stored ownerless copy", () => {
    const o1 = ownerless('o1', { heartbeatAt: undefined })
    useUploadStore.setState({ files: [o1] })
    expect(storedRow('o1')).not.toHaveProperty('ownerId')

    // Claimed for Y here.
    useUploadStore.setState((s) => ({ files: s.files.map((f) => ({ ...f, ownerId: Y })) }))

    expect(storedRow('o1')).toMatchObject({ ownerId: Y })
    thisTabWrites()
    expect(storedRow('o1')).toMatchObject({ ownerId: Y })

    // The other way round: another tab claimed o2, and this tab still holds
    // the ownerless copy it loaded, stamped later. The owned copy still wins.
    const o2 = ownerless('o2', { heartbeatAt: Date.now() - LIVE_WINDOW_MS * 4 })
    useUploadStore.setState((s) => ({ files: [...s.files, { ...o2, heartbeatAt: Date.now() - LIVE_WINDOW_MS * 2 }] }))
    anotherTabWrites([...stored().filter((f) => f.id !== 'o2'), { ...asStored(o2), ownerId: Y }])

    thisTabWrites()

    expect(storedRow('o2')).toMatchObject({ ownerId: Y })
    expect(storedRow('o1')).toMatchObject({ ownerId: Y })
  })
})

describe('the store never reloads itself from storage', () => {
  it('the store never calls persist.rehydrate', () => {
    // Reloading replaces `files` wholesale: it drops in-memory rows and runs
    // `standingOfStoredRow` over a row this tab is still sending, which turns
    // it `interrupted` and offers a Resume that would start a second sender.
    const dir = join(__dirname, '..')
    const sources = readdirSync(dir).filter((name) => /\.tsx?$/.test(name))
    expect(sources).toContain('upload-store.ts')
    for (const name of sources) {
      const text = readFileSync(join(dir, name), 'utf8')
      expect(text, name).not.toMatch(/rehydrate\s*\(/)
    }
  })
})
