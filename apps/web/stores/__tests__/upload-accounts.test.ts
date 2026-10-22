/**
 * Uploads belong to the account that added them (spec goal 9).
 *
 * Tokens live in localStorage, which every tab shares, so the account a tab is
 * acting as can change under a queue full of files: another tab signs in as
 * someone else, or signs out. A file added by X must never be created, sent or
 * completed as Y, and X's rows must not be lost to Y either:
 *
 * - a row records the token's `sub` when it is added, and every request its
 *   run makes is pinned to that account;
 * - when the account changes, X's files that have not started fail at once,
 *   saved with their owner, and X's waiting resumes stay resumable;
 * - an answer that arrives after the change keeps what the server created on
 *   the row, `interrupted`, for X to resume or discard later;
 * - a presign refused because X's own access is gone ends the row for good,
 *   with the server's reason, instead of running eight retries over four
 *   minutes and then offering a Resume that can never work (#510, part 1).
 *
 * The first case runs the real `lib/api.ts` and `lib/auth.ts` against a mocked
 * `fetch`; the rest replace the API with the fake server. `ApiError` is the
 * real one throughout.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@/lib/api', async (orig) => {
  const real = await orig<typeof import('@/lib/api')>()
  // Spies over the real requests. The fake server replaces them case by case,
  // and `vi.resetAllMocks()` puts the real ones back.
  return {
    ...real,
    api: { ...real.api, post: vi.fn(real.api.post), get: vi.fn(real.api.get), patch: vi.fn(real.api.patch) },
  }
})
vi.mock('swr', () => ({ mutate: vi.fn() }))

import { api, ApiError } from '@/lib/api'
import { useUploadStore, visibleFiles, __uploadQueueTesting as testing } from '../upload-store'
import { signInAs, signOutElsewhere, writeTokenUnannounced, tokenFor, row } from '@/test/upload-session'
import {
  MB, fakeServer, fileOf, small, drop, rowOf, stored, settle, flush, resumable,
} from '@/test/upload-queue-server'

const X = 'user-x'
const Y = 'user-y'
const SWITCHED = 'Another account signed in. Add these files again after signing back in.'
const SIGNED_OUT = 'Signed out in another tab. Add these files again after signing in.'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const storedRow = (id: string) => stored().find((f) => f.id === id)

/**
 * Presigns answer with whatever `answer` returns: an error to reject with, or
 * nothing to let the fake server answer. Returns the count of presigns sent.
 */
function presignAnswers(answer: (n: number) => unknown): { count: () => number } {
  const serve = vi.mocked(api.post).getMockImplementation() as (...args: unknown[]) => Promise<unknown>
  let presigns = 0
  vi.mocked(api.post).mockImplementation(((path: string, body?: unknown, opts?: unknown) => {
    if (path === '/upload/presign-part') {
      presigns += 1
      const refused = answer(presigns)
      if (refused) return Promise.reject(refused)
    }
    return serve(path, body, opts)
  }) as never)
  return { count: () => presigns }
}

/** An interrupted upload of X's, with a version to come back to. */
const interruptedRow = () =>
  row({ id: 'r', fileName: 'clip.mp4', fileSize: MB, versionId: 'rv', assetId: 'ra', uploadId: 'ru', s3Key: 'rk' })

beforeEach(() => {
  vi.resetAllMocks()
  testing.reset()
  window.localStorage.clear()
  useUploadStore.setState({ files: [], versionsRevision: 0, panelOpen: false })
  // Out and in again, so the store has heard of X whatever the last case left.
  signOutElsewhere()
  signInAs(X)
  vi.mocked(api.get).mockResolvedValue([] as never)
  vi.mocked(api.patch).mockResolvedValue({} as never)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  testing.reset()
})

describe('an initiate that meets another account', () => {
  it(`enqueue as X, initiate answers 401, Y's tokens are written during the round trip, refresh returns Y: exactly one initiate fetch, and the row is Failed before start with "Another account signed in. Add these files again after signing back in."`, async () => {
    // The real request chain.
    vi.mocked(api.get).mockReset()
    window.localStorage.setItem('ff_refresh_token', 'refresh-x')
    // `clearTokens` assigns `window.location.href`; jsdom cannot navigate.
    const location = { href: '' }
    vi.stubGlobal('location', location)
    const sent: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      sent.push(url)
      if (url.endsWith('/upload/initiate')) {
        // Another tab signs in as Y while this initiate is on the wire, and
        // X's token is refused.
        writeTokenUnannounced(Y)
        window.localStorage.setItem('ff_refresh_token', 'refresh-y')
        return json(401, { detail: 'Not authenticated' })
      }
      if (url.endsWith('/auth/refresh')) {
        return json(200, { access_token: tokenFor(Y), refresh_token: 'refresh-y-2' })
      }
      throw new Error(`unexpected fetch ${url}`)
    }))

    const [id] = drop([small('x.jpg')])
    await vi.waitFor(() => expect(rowOf(id).status).toBe('failed'))

    expect(sent.filter((u) => u.endsWith('/upload/initiate'))).toHaveLength(1)
    expect(rowOf(id)).toMatchObject({ failedBeforeStart: true, error: SWITCHED, ownerId: X })
    expect(storedRow(id)).toMatchObject({ status: 'failed', error: SWITCHED, ownerId: X })
    // Y's session is Y's: nothing here refreshed it or signed it out.
    expect(sent.filter((u) => u.endsWith('/auth/refresh'))).toHaveLength(0)
    expect(window.localStorage.getItem('ff_access_token')).toBe(tokenFor(Y))
    expect(window.localStorage.getItem('ff_refresh_token')).toBe('refresh-y')
    expect(location.href).toBe('')
  })

  it('initiate answers after token removal: the row is interrupted with its ids in localStorage, and no presign is sent', async () => {
    const server = fakeServer(() => 'wait')
    const [id] = drop([fileOf('a.mov')])
    await settle()
    expect(server.names()).toEqual(['a.mov'])

    signOutElsewhere()
    server.initiates[0].resolve()
    await settle()

    const ids = { uploadId: 'u1', s3Key: 'k1', assetId: 'a1', versionId: 'v1' }
    expect(rowOf(id)).toMatchObject({ status: 'interrupted', ownerId: X, ...ids })
    expect(storedRow(id)).toMatchObject({ status: 'interrupted', ownerId: X, ...ids })
    expect(server.others()).toEqual([])
    expect(testing.runningIds()).toEqual([])
  })

  it('a row whose owner differs from the token fails at its turn while the current account\'s rows start', async () => {
    const server = fakeServer((_, i) => (i === 0 ? 'wait' : 'answer'))
    useUploadStore.setState({ files: [interruptedRow()] })
    const [x1, x2, x3] = drop([fileOf('x1.mov'), fileOf('x2.mov'), fileOf('x3.mov')])
    await settle()
    expect(server.names()).toEqual(['x1.mov'])
    // And a resume of X's, waiting behind the file that is starting.
    useUploadStore.getState().resumeUpload('r', fileOf('clip.mp4', MB))

    // Another tab signs in as Y, and its storage event has not reached this
    // tab yet: nothing here has noticed.
    writeTokenUnannounced(Y)
    expect(rowOf(x2).status).toBe('queued')

    // X1's answer comes, and with it the queue's next start: the check before
    // it finds Y, and every waiting row of X's is dealt with at once.
    server.initiates[0].resolve()
    await settle()

    for (const id of [x2, x3]) {
      expect(rowOf(id)).toMatchObject({ status: 'failed', failedBeforeStart: true, error: SWITCHED, ownerId: X })
      expect(storedRow(id)).toMatchObject({ status: 'failed', error: SWITCHED, ownerId: X })
    }
    // The resume asked the server nothing; it is X's to resume later.
    expect(api.get).not.toHaveBeenCalled()
    expect(rowOf('r')).toMatchObject({ status: 'interrupted', versionId: 'rv', ownerId: X })
    expect(rowOf('r').queuedResume).toBeUndefined()
    // X's first file had been created when the answer came: kept, for X.
    expect(rowOf(x1)).toMatchObject({ status: 'interrupted', uploadId: 'u1', versionId: 'v1', ownerId: X })
    expect(storedRow(x1)).toMatchObject({ status: 'interrupted', uploadId: 'u1', versionId: 'v1', ownerId: X })
    expect(server.others()).toEqual([])

    // Y's files start.
    const [y1] = drop([small('y1.jpg')])
    await settle()
    expect(server.names()).toEqual(['x1.mov', 'y1.jpg'])
    expect(visibleFiles(useUploadStore.getState()).map((f) => f.id)).toEqual([y1])
  })

  it("a new account's drop fails the old account's waiting rows at once", async () => {
    const server = fakeServer(() => 'wait')
    const [, x2] = drop([fileOf('x1.mov'), fileOf('x2.mov')])
    await settle()

    // Y signs in elsewhere and drops a file here before the event arrives.
    writeTokenUnannounced(Y)
    const [y1] = drop([small('y1.jpg')])

    // No await: the drop itself applied the change.
    expect(rowOf(x2)).toMatchObject({ status: 'failed', failedBeforeStart: true, error: SWITCHED, ownerId: X })
    expect(storedRow(x2)).toMatchObject({ status: 'failed', error: SWITCHED, ownerId: X })
    expect(rowOf(y1)).toMatchObject({ status: 'queued', ownerId: Y })
    expect(visibleFiles(useUploadStore.getState()).map((f) => f.id)).toEqual([y1])
    await settle()
    expect(server.names()).toEqual(['x1.mov'])
  })

  it('a storage write that throws on the drop that first sees a new account leaves the queue moving', async () => {
    const server = fakeServer(() => 'wait')
    const [x1, x2] = drop([fileOf('x1.mov'), fileOf('x2.mov')])
    await settle()
    expect(server.names()).toEqual(['x1.mov'])

    writeTokenUnannounced(Y)
    // The write that saves the account change is refused (storage full).
    const setItem = Storage.prototype.setItem
    let refusals = 0
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === 'ff-uploads' && refusals === 0) {
        refusals += 1
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
      }
      return setItem.call(this, key, value)
    })

    let ids: string[] = []
    expect(() => { ids = drop([small('y1.jpg')]) }).not.toThrow()
    expect(refusals).toBe(1)
    const [y1] = ids

    // The change is applied all the same, and Y's file is in.
    expect(rowOf(x2)).toMatchObject({ status: 'failed', error: SWITCHED, ownerId: X })
    expect(rowOf(y1)).toMatchObject({ status: 'queued', ownerId: Y })
    // X's first file was created before the change: once its answer comes and
    // its place frees, the queue starts Y's file.
    server.initiates[0].resolve()
    await settle()
    expect(rowOf(x1)).toMatchObject({ status: 'interrupted', ownerId: X })
    expect(server.names()).toEqual(['x1.mov', 'y1.jpg'])
  })

  it('a refused storage write when a run\'s answer notices a new account does not cut the run short', async () => {
    const server = fakeServer(() => 'wait')
    const [x1] = drop([fileOf('x1.mov')])
    await settle()

    writeTokenUnannounced(Y)
    // The write that saves the account change is refused (storage full). It
    // is the first write once the store has moved to Y: zustand sets the
    // state before it saves.
    const setItem = Storage.prototype.setItem
    let refusals = 0
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === 'ff-uploads' && refusals === 0 && useUploadStore.getState().subject === Y) {
        refusals += 1
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
      }
      return setItem.call(this, key, value)
    })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})

    // X's initiate answers; the run reads the token and finds Y.
    server.initiates[0].resolve()
    await settle()

    expect(refusals).toBe(1)
    // The run went on to keep what the server created, for X, and ended.
    expect(rowOf(x1)).toMatchObject({ status: 'interrupted', uploadId: 'u1', versionId: 'v1', ownerId: X })
    expect(storedRow(x1)).toMatchObject({ status: 'interrupted', uploadId: 'u1', versionId: 'v1', ownerId: X })
    expect(testing.runningIds()).toEqual([])
    expect(errors).not.toHaveBeenCalled()
    // Its place is free: Y's file starts.
    drop([small('y1.jpg')])
    await settle()
    expect(server.names()).toEqual(['x1.mov', 'y1.jpg'])
  })

  it('a row with no owner is never started, as anyone', async () => {
    fakeServer()
    useUploadStore.setState({ files: [{ ...interruptedRow(), ownerId: undefined }] })

    useUploadStore.getState().resumeUpload('r', fileOf('clip.mp4', MB))
    await settle()

    expect(api.get).not.toHaveBeenCalled()
    expect(rowOf('r').status).toBe('interrupted')
    expect(rowOf('r').queuedResume).toBeUndefined()
  })

  it('a /parts answer that arrives after a sub change keeps its ids for the owner and sends nothing', async () => {
    const server = fakeServer()
    let answer!: (info: unknown) => void
    vi.mocked(api.get).mockImplementation((() => new Promise((r) => { answer = r })) as never)
    useUploadStore.setState({ files: [{ ...interruptedRow(), uploadId: undefined, s3Key: undefined }] })
    useUploadStore.getState().resumeUpload('r', fileOf('clip.mp4', MB))
    await settle()
    expect(rowOf('r').status).toBe('starting')

    signInAs(Y)
    answer(resumable({ version_id: 'rv', upload_id: 'ru2', s3_key: 'rk2', file_size_bytes: MB }))
    await settle()

    expect(rowOf('r')).toMatchObject({ status: 'interrupted', uploadId: 'ru2', s3Key: 'rk2', versionId: 'rv', ownerId: X })
    // Saved as X's interrupted row. Which ids storage keeps for a row another
    // tab may have written is the merge's rule (`mergeWithStored`), unchanged here.
    expect(storedRow('r')).toMatchObject({ status: 'interrupted', versionId: 'rv', ownerId: X })
    expect(server.others()).toEqual([])
    expect(testing.runningIds()).toEqual([])
  })
})

describe('when the account changes in another tab', () => {
  it('a sub change fails the old owner\'s queued rows synchronously and persists them with their owner', async () => {
    const server = fakeServer(() => 'wait')
    const [, b, c] = drop([fileOf('a.mov'), fileOf('b.mov'), fileOf('c.mov')])
    await settle()

    signInAs(Y)

    // No await: before anything else in this tab can run.
    for (const id of [b, c]) {
      expect(rowOf(id)).toMatchObject({ status: 'failed', failedBeforeStart: true, error: SWITCHED, ownerId: X })
      expect(storedRow(id)).toMatchObject({ status: 'failed', failedBeforeStart: true, error: SWITCHED, ownerId: X })
    }
    await settle()
    expect(server.names()).toEqual(['a.mov'])
  })

  it('a sub change leaves a queued resume interrupted', async () => {
    const server = fakeServer(() => 'wait')
    useUploadStore.setState({ files: [interruptedRow()] })
    // A file starting holds the whole budget, so the resume waits.
    drop([fileOf('blocker.mov')])
    await settle()
    useUploadStore.getState().resumeUpload('r', fileOf('clip.mp4', MB))
    expect(rowOf('r').queuedResume).toBe(true)

    signInAs(Y)

    expect(rowOf('r')).toMatchObject({ status: 'interrupted', versionId: 'rv', ownerId: X })
    expect(rowOf('r').queuedResume).toBeUndefined()
    server.initiates[0].resolve()
    await settle()
    // Its turn never comes: nothing asked the server about it.
    expect(api.get).not.toHaveBeenCalled()
    expect(rowOf('r').status).toBe('interrupted')
    expect(storedRow('r')).toMatchObject({ status: 'interrupted', versionId: 'rv', ownerId: X })
    // Back as X, it is X's to resume.
    signInAs(X)
    expect(useUploadStore.getState().canResume('r')).toBe(true)
  })

  it('token removal while a queued resume waits leaves a resumable interrupted row', async () => {
    const server = fakeServer(() => 'wait')
    useUploadStore.setState({ files: [interruptedRow()] })
    drop([fileOf('blocker.mov')])
    await settle()
    useUploadStore.getState().resumeUpload('r', fileOf('clip.mp4', MB))
    expect(rowOf('r').queuedResume).toBe(true)

    signOutElsewhere()

    expect(rowOf('r')).toMatchObject({ status: 'interrupted', versionId: 'rv', ownerId: X })
    expect(rowOf('r').queuedResume).toBeUndefined()
    server.initiates[0].resolve()
    await settle()
    expect(api.get).not.toHaveBeenCalled()
    expect(storedRow('r')).toMatchObject({ status: 'interrupted', versionId: 'rv', uploadId: 'ru', ownerId: X })
    expect(useUploadStore.getState().canResume('r')).toBe(true)
  })

  it('token removal fails all not-yet-started rows synchronously, before any request', async () => {
    fakeServer(() => 'answer')
    // Three come to their turn and read their first byte; the fourth waits.
    const ids = drop([small('a.jpg'), small('b.jpg'), small('c.jpg'), small('d.jpg')])
    expect(ids.map((id) => rowOf(id).status)).toEqual(['starting', 'starting', 'starting', 'queued'])

    signOutElsewhere()

    expect(rowOf(ids[3])).toMatchObject({ status: 'failed', failedBeforeStart: true, error: SIGNED_OUT, ownerId: X })
    expect(storedRow(ids[3])).toMatchObject({ status: 'failed', error: SIGNED_OUT, ownerId: X })
    await settle()
    expect(api.post).not.toHaveBeenCalled()
    for (const id of ids) {
      expect(rowOf(id)).toMatchObject({ status: 'failed', failedBeforeStart: true, error: SIGNED_OUT, ownerId: X })
    }
    expect(testing.runningIds()).toEqual([])
  })

  it('a hidden old-account runner still counts toward the cap until it stops', async () => {
    const server = fakeServer(() => 'answer', 'hang')
    const xs = drop([small('x1.jpg'), small('x2.jpg'), small('x3.jpg'), small('x4.jpg')])
    await settle()
    // Three files sending, one part each; the fourth waits for a place.
    expect(server.inFlight).toHaveLength(3)

    signInAs(Y)
    expect(rowOf(xs[3])).toMatchObject({ status: 'failed', error: SWITCHED })
    const [y] = drop([small('y.jpg')])
    await settle()

    // X's three are hidden from Y, but still sending: no place for Y's file.
    expect(server.names()).not.toContain('y.jpg')
    expect(rowOf(y).status).toBe('queued')

    server.finishOne()
    await settle()
    expect(server.names()).toContain('y.jpg')
  })
})

describe('a presign refused', () => {
  it('a presign 403, 404 and 409 each end the row failed with the server\'s message at once, with no Resume, and no 8-attempt ladder', async () => {
    // And a 401 that survived a refresh as the same account: the same thing.
    for (const status of [403, 404, 409, 401]) {
      testing.reset()
      useUploadStore.setState({ files: [] })
      fakeServer()
      const presigns = presignAnswers(() => new ApiError(status, `Refused with ${status}`))

      const [id] = drop([small('a.jpg')])
      // Real timers: a retry would wait at least two seconds before going again.
      await settle()

      expect(rowOf(id)).toMatchObject({ status: 'failed', error: `Refused with ${status}`, versionId: 'v1' })
      expect(presigns.count()).toBe(1)
      expect(useUploadStore.getState().canResume(id)).toBe(false)
      expect(testing.runningIds()).toEqual([])
    }
  })

  it('a presign identity_changed ends the row interrupted', async () => {
    for (const code of ['identity_changed', 'session_ended']) {
      testing.reset()
      useUploadStore.setState({ files: [] })
      fakeServer()
      const presigns = presignAnswers(() => new ApiError(401, code.replace('_', ' '), { code }))

      const [id] = drop([small('a.jpg')])
      await settle()

      expect(rowOf(id)).toMatchObject({ status: 'interrupted', uploadId: 'u1', versionId: 'v1', ownerId: X })
      expect(rowOf(id).error).toBeUndefined()
      expect(presigns.count()).toBe(1)
      expect(testing.runningIds()).toEqual([])
    }
  })

  it('a presign 401 whose refresh was unavailable is retried', async () => {
    vi.useFakeTimers()
    fakeServer()
    const presigns = presignAnswers((n) =>
      n === 1 ? new ApiError(401, 'refresh unavailable', { code: 'refresh_unavailable' }) : null,
    )

    const [id] = drop([small('a.jpg')])
    await flush()
    expect(presigns.count()).toBe(1)
    expect(rowOf(id).status).toBe('uploading')

    await vi.advanceTimersByTimeAsync(3000)
    await flush()
    expect(presigns.count()).toBe(2)
    expect(rowOf(id).status).toBe('processing')
  })
})

describe('the account a run sends as', () => {
  it("every request of a run is pinned to the row's owner, never to whoever is signed in", async () => {
    const server = fakeServer(() => 'wait', 'hang')
    const pinOf = (path: string | RegExp) => {
      const call = vi.mocked(api.post).mock.calls.find(([p]) =>
        typeof path === 'string' ? p === path : path.test(p as string))
      return (call?.[2] as { pinSubject?: string } | undefined)?.pinSubject
    }

    // A new asset, renamed while its initiate is out, then sent and completed.
    const [a] = drop([small('a.jpg')])
    await settle()
    void useUploadStore.getState().renameUpload(a, 'renamed')
    server.initiates[0].resolve()
    await settle()
    server.finishOne()
    await settle()
    expect(pinOf('/upload/initiate')).toBe(X)
    expect(vi.mocked(api.patch).mock.calls[0]?.[2]).toEqual({ pinSubject: X })
    expect(pinOf('/upload/presign-part')).toBe(X)
    expect(pinOf('/upload/complete')).toBe(X)

    // A new version, cancelled once it is sending.
    const v = useUploadStore.getState().startVersionUpload(fileOf('b.mov'), 'a9', 'b', 'p1')!
    await settle()
    server.initiates[1].resolve()
    await settle()
    expect(pinOf(/^\/assets\/a9\/versions$/)).toBe(X)
    useUploadStore.getState().cancelUpload(v)
    await settle()
    expect(pinOf('/upload/abort')).toBe(X)

    // A resume asks where the upload stands as its owner.
    vi.mocked(api.get).mockResolvedValue(resumable({ version_id: 'rv', state: 'assembled' }) as never)
    useUploadStore.setState((s) => ({ files: [interruptedRow(), ...s.files] }))
    useUploadStore.getState().resumeUpload('r', fileOf('clip.mp4', MB))
    await settle()
    expect(vi.mocked(api.get).mock.calls.find(([p]) => p === '/upload/rv/parts')?.[1]).toEqual({ pinSubject: X })
  })
})

describe('a hold and the actions, across a change of account', () => {
  it("a Held probe of the old account fails on a sub change, and the new account's file starts at once", async () => {
    // X's file found the connection down: it is the hold's probe, waiting
    // its backoff before trying again.
    const server = fakeServer(() => new TypeError('Failed to fetch'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const [x1] = drop([small('x1.jpg')])
    await settle()
    expect(rowOf(x1)).toMatchObject({ status: 'queued', holdReason: 'connection' })

    signInAs(Y)
    expect(rowOf(x1)).toMatchObject({ status: 'failed', error: SWITCHED, ownerId: X })
    expect(rowOf(x1).holdReason).toBeUndefined()

    // The hold went with it: Y's file does not wait out X's backoff.
    const now = fakeServer()
    const [y1] = drop([small('y1.jpg')])
    await settle()
    expect(now.names()).toEqual(['y1.jpg'])
    expect(rowOf(y1).status).not.toBe('queued')
    expect(server.names()).toEqual(['x1.jpg'])
  })

  it('a Held probe of the old account still hands the hold on when saving the change throws', async () => {
    const server = fakeServer(() => new TypeError('Failed to fetch'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const [x1] = drop([small('x1.jpg')])
    await settle()
    expect(rowOf(x1)).toMatchObject({ status: 'queued', holdReason: 'connection' })

    // Y signs in elsewhere and drops a file here before the event arrives, and
    // the write that saves the change is refused (storage full).
    writeTokenUnannounced(Y)
    const setItem = Storage.prototype.setItem
    let refusals = 0
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === 'ff-uploads' && refusals === 0) {
        refusals += 1
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
      }
      return setItem.call(this, key, value)
    })
    const now = fakeServer()
    const [y1] = drop([small('y1.jpg')])
    await settle()

    expect(refusals).toBe(1)
    expect(rowOf(x1)).toMatchObject({ status: 'failed', error: SWITCHED, ownerId: X })
    // The hold went with X's file: Y's file does not wait out X's backoff.
    expect(now.names()).toEqual(['y1.jpg'])
    expect(rowOf(y1).status).not.toBe('queued')
    expect(server.names()).toEqual(['x1.jpg'])
  })

  it('a Discard after an unannounced switch sends nothing under the new account', async () => {
    // The real request chain: nothing may reach the network as Y.
    vi.mocked(api.get).mockReset()
    vi.mocked(api.post).mockReset()
    const fetchMock = vi.fn(async () => json(200, {}))
    vi.stubGlobal('fetch', fetchMock)
    useUploadStore.setState({ files: [interruptedRow()] })

    writeTokenUnannounced(Y)
    const said = await useUploadStore.getState().discardUpload('r')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(said).toBeTruthy()
    expect(rowOf('r')).toMatchObject({ status: 'interrupted', versionId: 'rv', ownerId: X })
  })
})
