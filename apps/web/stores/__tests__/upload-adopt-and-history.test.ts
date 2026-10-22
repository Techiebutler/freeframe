/**
 * Rows saved before this release, and the upload history, belong to the
 * account signed in (spec goal 10).
 *
 * A row saved before rows had owners has no `ownerId`, so it shows to nobody.
 * The server says whose it is: `GET /upload/{versionId}/parts` answers 200 only
 * to the account that created the version. So each such row is checked once
 * after the page loads, and again whenever the account changes:
 *
 *  * 200: it is the signed-in account's, and it shows to them;
 *  * 403: it is someone else's: it stays stored, ownerless and hidden;
 *  * 404 or 409: the upload is gone or finished: it is dropped, from storage too;
 *  * no `versionId`: nothing on the server to check or resume: dropped;
 *  * a network error, a 5xx or a 429 settles nothing: checked again next time;
 *  * with nobody signed in, nothing is checked and storage is left alone.
 *
 * History rows take their owner from the asset's `created_by`, a history answer
 * that arrives after the account changed is not used, and a change of account
 * fetches the new account's history from the start.
 *
 * Every case that touches storage asserts what localStorage holds, which is
 * what the next page load and every other tab read.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// One set of mocks, and one `ApiError`, for every load of the store: `loadAgain`
// imports a fresh copy, and it must answer through the same functions, with
// errors it recognises as its own.
const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }))
const shared = vi.hoisted(() => ({ ApiError: undefined as unknown }))
vi.mock('@/lib/api', async (orig) => {
  const real = await orig<typeof import('@/lib/api')>()
  shared.ApiError ??= real.ApiError
  return { ...real, api: h, ApiError: shared.ApiError }
})
vi.mock('swr', () => ({ mutate: vi.fn() }))

import {
  useUploadStore, visibleFiles, LIVE_WINDOW_MS, __uploadQueueTesting as testing,
} from '../upload-store'
import type { UploadFile } from '../upload-store'
import type { AssetResponse } from '@/types'
import { signInAs, signOutElsewhere, writeTokenUnannounced, row } from '@/test/upload-session'
import { rowOf, files, stored, settle } from '@/test/upload-queue-server'

const KEY = 'ff-uploads'
const X = 'user-x'
const Y = 'user-y'
const OTHER_TAB = 'some-other-tab'
const PAGE = 20

type Answer = 200 | 403 | 404 | 409 | 429 | 500 | 'network' | 'identity_changed'

/** What `/upload/{versionId}/parts` answers, by version id. Unlisted: 200. */
let answers: Record<string, Answer | Promise<Answer>> = {}
/** What `/me/assets` answers, by the account the request is pinned to. */
let history: Record<string, (skip: number) => AssetResponse[] | Promise<AssetResponse[]>> = {}

async function answer(a: Answer): Promise<unknown> {
  const ApiError = shared.ApiError as typeof import('@/lib/api').ApiError
  if (a === 200) return { state: 'uploading', parts: [] }
  if (a === 'network') throw new TypeError('Failed to fetch')
  if (a === 'identity_changed') throw new ApiError(401, 'identity changed', { code: 'identity_changed' })
  throw new ApiError(a, `status ${a}`)
}

async function server(path: string, opts?: { pinSubject?: string }): Promise<unknown> {
  const parts = path.match(/^\/upload\/(.+)\/parts$/)
  if (parts) return answer(await (answers[parts[1]] ?? 200))
  if (path.startsWith('/me/assets')) {
    const skip = Number(new URL(path, 'http://x').searchParams.get('skip'))
    return (history[opts?.pinSubject ?? ''] ?? (() => []))(skip)
  }
  return []
}

/** An asset as `/me/assets` lists it: a version that is still uploading. */
function asset(id: string, createdBy: string): AssetResponse {
  return {
    id, project_id: 'project-1', name: id, asset_type: 'video', created_by: createdBy,
    latest_version: {
      id: `${id}-v`, asset_id: id, version_number: 1, processing_status: 'uploading',
      created_by: createdBy, created_at: new Date().toISOString(), deleted_at: null,
      last_activity_at: new Date(Date.now() - LIVE_WINDOW_MS * 10).toISOString(), files: [],
    },
  } as unknown as AssetResponse
}
const pageOf = (prefix: string, owner: string, n = PAGE) =>
  Array.from({ length: n }, (_, i) => asset(`${prefix}${i}`, owner))

/** A row saved before rows had owners: an interrupted upload with a version to check. */
function ownerless(id: string, over: Partial<UploadFile> = {}): UploadFile {
  const r = row({
    id, status: 'interrupted', versionId: `${id}-v`, assetId: `${id}-a`, uploadId: `${id}-u`,
    ownerTab: OTHER_TAB, heartbeatAt: Date.now() - LIVE_WINDOW_MS * 3, ...over,
  })
  delete r.ownerId
  return r
}

const storedRow = (id: string) => stored().find((f) => f.id === id)
const storedIds = () => stored().map((f) => f.id).sort()
const ids = () => files().map((f) => f.id).sort()
const shown = () => visibleFiles(useUploadStore.getState()).map((f) => f.id).sort()
const asStored = (f: UploadFile): UploadFile => JSON.parse(JSON.stringify(f))
const partsChecks = (versionId: string) =>
  h.get.mock.calls.filter((c) => c[0] === `/upload/${versionId}/parts`)
const historyCalls = () => h.get.mock.calls.filter((c) => String(c[0]).startsWith('/me/assets'))

/** Another tab, or a tab still on the pre-release bundle, writes the key outright. */
function anotherTabWrites(rows: UploadFile[], version = 1) {
  window.localStorage.setItem(KEY, JSON.stringify({ state: { files: rows }, version }))
}

const thisTabWrites = () => useUploadStore.getState().setPanelOpen(!useUploadStore.getState().panelOpen)

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

/**
 * A page load of its own, reading whatever storage holds now, as the account
 * whose token is in storage. It is not told of later sign-ins.
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

beforeEach(async () => {
  vi.resetAllMocks()
  testing.reset()
  answers = {}
  history = {}
  h.get.mockImplementation(server)
  useUploadStore.setState({ files: [], panelOpen: false })
  window.localStorage.clear()
  signOutElsewhere()
  signInAs(Y)
  // The sign-in fetched Y's (empty) history. Each case starts from none.
  await settle()
  h.get.mockClear()
  useUploadStore.setState({
    files: [], historyLoaded: false, historyLoading: false, historySkip: 0, historyHasMore: true,
  })
  window.localStorage.removeItem(KEY)
})

afterEach(() => {
  vi.restoreAllMocks()
  testing.reset()
})

describe('rows saved before this release', () => {
  it('adopts on 200', async () => {
    // A blob from before this release (version 0), read by the next page load.
    const o1 = ownerless('o1')
    anotherTabWrites([o1], 0)

    const loaded = await loadAgain()
    await settle()

    const state = loaded.useUploadStore.getState()
    expect(partsChecks('o1-v')).toEqual([['/upload/o1-v/parts', { pinSubject: Y }]])
    expect(state.files.find((f) => f.id === 'o1')?.ownerId).toBe(Y)
    expect(loaded.visibleFiles(state).map((f) => f.id)).toEqual(['o1'])
    expect(storedRow('o1')).toEqual({ ...asStored(o1), ownerId: Y })

    // Another tab saved an ownerless row, and X signs in here: it is checked
    // as it comes in, and X's from then on.
    const o2 = ownerless('o2')
    anotherTabWrites([...stored(), o2])
    signInAs(X)
    await settle()

    expect(partsChecks('o2-v')).toEqual([['/upload/o2-v/parts', { pinSubject: X }]])
    expect(rowOf('o2').ownerId).toBe(X)
    expect(shown()).toEqual(['o2'])
    expect(storedRow('o2')).toEqual({ ...asStored(o2), ownerId: X })
    // Y's claim stands: o1 is not X's to see, and stays Y's in storage.
    expect(storedRow('o1')?.ownerId).toBe(Y)
  })

  it('keeps hidden on 403 and on a network error', async () => {
    const rows = [ownerless('o403'), ownerless('onet'), ownerless('o500'), ownerless('o429')]
    answers = { 'o403-v': 403, 'onet-v': 'network', 'o500-v': 500, 'o429-v': 429 }
    anotherTabWrites(rows)

    signInAs(X)
    await settle()

    expect(ids()).toEqual(['o403', 'o429', 'o500', 'onet'])
    expect(files().every((f) => f.ownerId === undefined)).toBe(true)
    expect(shown()).toEqual([])
    thisTabWrites()
    expect(storedIds()).toEqual(['o403', 'o429', 'o500', 'onet'])
    for (const r of rows) expect(storedRow(r.id)).toEqual(asStored(r))

    // Checked again when another account signs in: the 403 might be theirs,
    // and the server may answer this time.
    answers = { 'o403-v': 200, 'onet-v': 200, 'o500-v': 403, 'o429-v': 403 }
    signInAs(Y)
    await settle()

    for (const v of ['o403-v', 'onet-v', 'o500-v', 'o429-v']) {
      expect(partsChecks(v).map((c) => c[1])).toEqual([{ pinSubject: X }, { pinSubject: Y }])
    }
    expect(shown()).toEqual(['o403', 'onet'])
    expect(storedRow('o403')?.ownerId).toBe(Y)
    expect(storedRow('onet')?.ownerId).toBe(Y)
    expect(storedRow('o500')).toEqual(asStored(rows[2]))
    expect(storedRow('o429')).toEqual(asStored(rows[3]))
  })

  it('drops on 404, 409 and when there is no versionId, and storage reflects it', async () => {
    const kept = ownerless('o403')
    const rows = [ownerless('o404'), ownerless('o409'), ownerless('onov', { versionId: undefined }), kept]
    answers = { 'o404-v': 404, 'o409-v': 409, 'o403-v': 403 }
    anotherTabWrites(rows)

    signInAs(X)
    await settle()

    // Nothing to ask about a row with no version.
    expect(h.get.mock.calls.filter((c) => String(c[0]).includes('undefined'))).toEqual([])
    expect(ids()).toEqual(['o403'])
    expect(storedIds()).toEqual(['o403'])
    thisTabWrites()
    expect(storedIds()).toEqual(['o403'])

    // A tab still on the pre-release bundle writes them back; neither this
    // tab's next write nor the next sign-in brings them back.
    anotherTabWrites(rows)
    thisTabWrites()
    expect(storedIds()).toEqual(['o403'])
    anotherTabWrites(rows)
    signInAs(Y)
    await settle()
    expect(ids()).toEqual(['o403'])
    expect(storedIds()).toEqual(['o403'])
    expect(partsChecks('o404-v')).toHaveLength(1)
    expect(partsChecks('o409-v')).toHaveLength(1)
  })

  it('does nothing without a token', async () => {
    const rows = [ownerless('o1'), ownerless('onov', { versionId: undefined })]
    anotherTabWrites(rows, 0)
    signOutElsewhere()
    await settle()
    const before = window.localStorage.getItem(KEY)

    // Signed out here: the rows came in with the change, and nothing is asked.
    await testing.adoptOwnerlessRows()
    expect(ids()).toEqual(['o1', 'onov'])
    expect(shown()).toEqual([])
    expect(h.get).not.toHaveBeenCalled()
    expect(window.localStorage.getItem(KEY)).toBe(before)

    // A page load with nobody signed in: the same.
    const loaded = await loadAgain()
    await settle()
    expect(loaded.useUploadStore.getState().files.map((f) => f.id).sort()).toEqual(['o1', 'onov'])
    expect(loaded.useUploadStore.getState().files.every((f) => f.ownerId === undefined)).toBe(true)
    expect(h.get).not.toHaveBeenCalled()
    expect(stored().map(asStored)).toEqual(rows.map(asStored))
  })

  it('a check answered after another account signed in leaves the row for next time', async () => {
    const o1 = ownerless('o1')
    answers = { 'o1-v': 'identity_changed' }
    anotherTabWrites([o1])

    signInAs(X)
    await settle()

    expect(rowOf('o1').ownerId).toBeUndefined()
    thisTabWrites()
    expect(storedRow('o1')).toEqual(asStored(o1))
  })

  it('a row already being checked is not checked again until its answer arrives', async () => {
    const pending = deferred<Answer>()
    answers = { 'o1-v': pending.promise }
    anotherTabWrites([ownerless('o1')])
    signInAs(X)
    await settle()

    await Promise.race([testing.adoptOwnerlessRows(), settle()])
    expect(partsChecks('o1-v')).toHaveLength(1)

    pending.resolve(200)
    await settle()
    expect(rowOf('o1').ownerId).toBe(X)
  })

  it('a saved history row is never tombstoned, so its asset can be saved again', async () => {
    // A history row saved before rows had owners, whose upload has finished.
    const old = ownerless('history-a9', { fromHistory: true, versionId: 'a9-v', assetId: 'a9' })
    answers = { 'a9-v': 409 }
    anotherTabWrites([old])
    signInAs(X)
    await settle()
    expect(ids()).toEqual([])
    expect(storedIds()).toEqual([])

    // The asset is listed again, still uploading: its row must reach storage.
    history = { [X]: () => [asset('a9', X)] }
    useUploadStore.setState({ historyLoaded: false })
    await useUploadStore.getState().fetchHistory()
    expect(rowOf('history-a9').ownerId).toBe(X)
    expect(storedRow('history-a9')?.ownerId).toBe(X)
  })
})

describe('history rows', () => {
  it('history rows carry created_by as owner', async () => {
    history = {
      [Y]: (skip) => (skip === 0 ? [...pageOf('y', Y, PAGE - 1), asset('xs', X)] : [asset('y-more', Y), asset('xs2', X)]),
    }

    await useUploadStore.getState().fetchHistory()
    await useUploadStore.getState().fetchMoreHistory()

    expect(rowOf('history-y0').ownerId).toBe(Y)
    expect(rowOf('history-y-more').ownerId).toBe(Y)
    // Whatever the server says created it, not whoever is signed in.
    expect(rowOf('history-xs').ownerId).toBe(X)
    expect(rowOf('history-xs2').ownerId).toBe(X)
    expect(shown()).not.toContain('history-xs')
    expect(historyCalls().map((c) => c[1])).toEqual([{ pinSubject: Y }, { pinSubject: Y }])
  })

  it('a history response that resolves after a sub change is dropped', async () => {
    // First page: X's answer is still on its way when Y signs in.
    signInAs(X)
    await settle()
    useUploadStore.setState({ files: [], historyLoaded: false, historySkip: 0, historyHasMore: true })
    h.get.mockClear()
    const xPage = deferred<AssetResponse[]>()
    history = { [X]: () => xPage.promise, [Y]: () => [asset('y0', Y)] }

    const first = useUploadStore.getState().fetchHistory()
    signInAs(Y)
    await settle()
    xPage.resolve(pageOf('x', X))
    await first
    await settle()

    expect(historyCalls().map((c) => c[1])).toEqual([{ pinSubject: X }, { pinSubject: Y }])
    expect(ids()).toEqual(['history-y0'])
    expect(useUploadStore.getState()).toMatchObject({
      historyLoaded: true, historyLoading: false, historySkip: PAGE, historyHasMore: false,
    })

    // Y's answer still on its way while X and then Y sign in again: the token
    // is Y's once more when it lands, but history was asked for again since.
    const yOld = deferred<AssetResponse[]>()
    history = { [Y]: () => yOld.promise }
    useUploadStore.setState({ historyLoaded: false })
    const old = useUploadStore.getState().fetchHistory()
    signInAs(X)
    history = { [X]: () => [], [Y]: () => [asset('y1', Y)] }
    signInAs(Y)
    await settle()
    yOld.resolve(pageOf('yold', Y))
    await old
    await settle()

    expect(files().some((f) => f.id.startsWith('history-yold'))).toBe(false)
    expect(useUploadStore.getState()).toMatchObject({ historySkip: PAGE, historyHasMore: false })

    // A later page: Y's answer arrives after a token X wrote in another tab,
    // before this tab heard of it.
    useUploadStore.setState({ historyHasMore: true })
    const yMore = deferred<AssetResponse[]>()
    history = { [Y]: () => yMore.promise, [X]: () => [asset('x0', X)] }
    const more = useUploadStore.getState().fetchMoreHistory()
    writeTokenUnannounced(X)
    yMore.resolve(pageOf('ymore', Y))
    await more
    await settle()

    expect(files().some((f) => f.id.startsWith('history-ymore'))).toBe(false)
    // The change is applied where it was found: X's history from the start.
    expect(useUploadStore.getState().subject).toBe(X)
    expect(historyCalls().at(-1)).toEqual([`/me/assets?filter=owned&skip=0&limit=${PAGE}`, { pinSubject: X }])
    expect(useUploadStore.getState()).toMatchObject({ historySkip: PAGE, historyHasMore: false, historyLoading: false })
  })

  it('a sub change re-fetches history from offset 0', async () => {
    signInAs(X)
    await settle()
    useUploadStore.setState({ files: [], historyLoaded: false, historySkip: 0, historyHasMore: true })
    history = { [X]: (skip) => pageOf(`x${skip}-`, X), [Y]: (skip) => pageOf(`y${skip}-`, Y, 3) }
    await useUploadStore.getState().fetchHistory()
    await useUploadStore.getState().fetchMoreHistory()
    expect(useUploadStore.getState().historySkip).toBe(2 * PAGE)
    h.get.mockClear()

    signInAs(Y)
    await settle()

    expect(historyCalls()).toEqual([[`/me/assets?filter=owned&skip=0&limit=${PAGE}`, { pinSubject: Y }]])
    expect(useUploadStore.getState()).toMatchObject({
      historyLoaded: true, historySkip: PAGE, historyHasMore: false,
    })
    expect(shown()).toEqual(['history-y0-0', 'history-y0-1', 'history-y0-2'])

    // Back to X: from the start again, and X's rows are not listed twice.
    h.get.mockClear()
    signInAs(X)
    await settle()
    expect(historyCalls()).toEqual([[`/me/assets?filter=owned&skip=0&limit=${PAGE}`, { pinSubject: X }]])
    expect(useUploadStore.getState()).toMatchObject({ historySkip: PAGE, historyHasMore: true })
    const all = files().map((f) => f.id)
    expect(new Set(all).size).toBe(all.length)
    expect(shown()).toHaveLength(2 * PAGE)
  })
})
