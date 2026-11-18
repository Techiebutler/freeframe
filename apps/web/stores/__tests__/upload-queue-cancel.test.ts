/**
 * Cancel, Cancel all queued and Retry, as the queue gives them meaning.
 *
 * Each row's Cancel follows its place in the lifecycle (spec, "Row lifecycle"):
 * a file that has not started has nothing on the server, so Cancel only takes
 * it away; a file whose initiate is out is thrown away once the answer says
 * what was created; the hold's probe hands the hold on, or ends it; a file
 * already sending is cancelled as it always was. "Cancel all queued" applies
 * those rules to waiting rows and never touches a row whose turn has begun.
 * Retry puts a refused file back at the front of the queue while this tab
 * still holds its `File`.
 *
 * The API is mocked but `ApiError` is the real one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  api: { post: vi.fn(), get: vi.fn(), patch: vi.fn() },
}))
vi.mock('swr', () => ({ mutate: vi.fn() }))

import { api, ApiError } from '@/lib/api'
import { useUploadStore, __uploadQueueTesting as testing } from '../upload-store'
import { signInAs, row } from '@/test/upload-session'
import { installXhrFake, type FakeXhr } from '@/test/xhr-fake'
import {
  MB, fakeServer, fileOf, small, drop, rowOf, files, stored, settle, flush, rehydrate, resumable,
} from '@/test/upload-queue-server'

const listed = (id: string) => files().some((f) => f.id === id)
const aborts = (calls: string[]) => calls.filter((c) => c.startsWith('abort '))

beforeEach(() => {
  vi.clearAllMocks()
  testing.reset()
  window.localStorage.clear()
  useUploadStore.setState({ files: [], versionsRevision: 0, panelOpen: false })
  signInAs('user-1')
  // A first sign-in fetches the account's upload history; no case here is about that.
  vi.mocked(api.get).mockClear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  testing.reset()
})

// ---------------------------------------------------------------- one row

describe('cancel', () => {
  it('cancel a queued row sends nothing and removes it', async () => {
    const server = fakeServer(() => 'wait')

    const [, b] = drop([fileOf('a.mov'), fileOf('b.mov')])
    await settle()
    expect(rowOf(b).status).toBe('queued')

    useUploadStore.getState().cancelUpload(b)
    expect(listed(b)).toBe(false)

    // Its turn would have come here.
    server.initiates[0].reject(new ApiError(400, 'No'))
    await settle()
    expect(server.names()).toEqual(['a.mov'])
    expect(server.others()).toEqual([])
    expect(api.get).not.toHaveBeenCalled()
  })

  it('cancel while initiating aborts the upload once the answer arrives', async () => {
    const server = fakeServer(() => 'wait', 'hang')

    const [a] = drop([small('a.jpg')])
    await settle()
    expect(rowOf(a).status).toBe('starting')

    useUploadStore.getState().cancelUpload(a)
    // Nothing to abort yet: what the initiate created is not known until it answers.
    expect(rowOf(a).status).toBe('cancelled')
    expect(server.others()).toEqual([])

    server.initiates[0].resolve()
    await settle()

    expect(server.others()).toEqual(['abort u1'])
    expect(api.post).toHaveBeenCalledWith('/upload/abort', {
      s3_key: 'k1', upload_id: 'u1', version_id: 'v1', discard: true,
    }, { pinSubject: 'user-1' })
    expect(listed(a)).toBe(false)
    expect(testing.runningIds()).toEqual([])
  })

  it('cancel while initiating, then a refusal: nothing to abort, and the row is removed', async () => {
    const server = fakeServer(() => 'wait')

    const [a] = drop([small('a.jpg')])
    await settle()
    useUploadStore.getState().cancelUpload(a)

    server.initiates[0].reject(new ApiError(400, 'Too big'))
    await settle()

    expect(server.others()).toEqual([])
    expect(listed(a)).toBe(false)
  })

  it('cancel during a hold retry whose initiate then answers 200 sends /upload/abort', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const server = fakeServer((_, i) => (i === 0 ? new TypeError('Failed to fetch') : 'wait'), 'hang')

    const [a] = drop([fileOf('a.mov'), fileOf('b.mov')])
    await flush()
    expect(rowOf(a)).toMatchObject({ status: 'queued', holdReason: 'connection' })

    await vi.advanceTimersByTimeAsync(2_000)
    expect(server.names()).toEqual(['a.mov', 'a.mov'])
    expect(rowOf(a).status).toBe('starting')

    useUploadStore.getState().cancelUpload(a)
    expect(rowOf(a).status).toBe('cancelled')

    server.initiates[1].resolve()
    await flush()

    expect(aborts(server.calls)).toEqual(['abort u2'])
    expect(listed(a)).toBe(false)
    // The answer got through, so the hold is over and the file behind starts.
    expect(server.names()).toEqual(['a.mov', 'a.mov', 'b.mov'])
  })

  it('cancel the probe hands the hold to the next row', async () => {
    vi.useFakeTimers()
    const server = fakeServer((_, i) =>
      i === 0 ? new ApiError(503, 'Storage is not answering', { code: 'storage_unavailable', retryAfter: 5 }) : 'wait',
    )

    const [a, b, c] = drop([fileOf('a.mov'), fileOf('b.mov'), fileOf('c.mov')])
    await flush()
    expect(rowOf(a)).toMatchObject({ status: 'queued', holdReason: 'storage' })

    await vi.advanceTimersByTimeAsync(1_000)
    useUploadStore.getState().cancelUpload(a)

    expect(listed(a)).toBe(false)
    expect(rowOf(b)).toMatchObject({ status: 'queued', holdReason: 'storage' })
    expect(rowOf(c).holdReason).toBeUndefined()

    // B waits what A was waiting, and nothing starts meanwhile.
    await vi.advanceTimersByTimeAsync(4_999)
    expect(server.names()).toEqual(['a.mov'])
    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(server.names()).toEqual(['a.mov', 'b.mov'])
    expect(rowOf(b).status).toBe('starting')
    // B is the probe now, so C still waits for its answer.
    expect(rowOf(c).status).toBe('queued')
  })

  it('cancelling the only held row ends the hold and a later drop starts', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const server = fakeServer((_, i) => (i === 0 ? new TypeError('Failed to fetch') : 'wait'))

    const [a] = drop([fileOf('a.mov')])
    await flush()
    expect(rowOf(a).holdReason).toBe('connection')

    useUploadStore.getState().cancelUpload(a)
    expect(files()).toEqual([])

    drop([fileOf('b.mov')])
    await flush()
    expect(server.names()).toEqual(['a.mov', 'b.mov'])

    // And the cancelled probe's retry is gone with it.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(server.names()).toEqual(['a.mov', 'b.mov'])
  })

  it('cancel an uploading row whose parts all wait on acquire: cancelled, heartbeat stopped, wake lock released, exactly one /upload/abort', async () => {
    vi.useFakeTimers()
    const server = fakeServer(() => 'wait', 'hang')

    // Both start; the large one's answer comes first and takes every slot.
    const [a, b] = drop([small('a.jpg'), fileOf('b.mov', 80 * MB)])
    await flush()
    server.initiates[1].resolve()
    await flush()
    expect(server.inFlight).toHaveLength(5)
    server.initiates[0].resolve()
    await flush()

    expect(rowOf(a).status).toBe('uploading')
    expect(server.calls).not.toContain('presign u1')
    expect(testing.wakeLockWanted()).toBe(true)

    useUploadStore.getState().cancelUpload(a)
    await flush()

    expect(rowOf(a).status).toBe('cancelled')
    expect(aborts(server.calls)).toEqual(['abort u1'])
    // `b` is still moving, so the lock is still wanted. The boolean cannot say
    // which row wants it; it goes only once `b` is cancelled too, below.
    expect(testing.wakeLockWanted()).toBe(true)
    expect(testing.runningIds()).toEqual([b])
    expect(testing.hasAbortController(a)).toBe(false)

    const beat = rowOf(a).heartbeatAt
    await vi.advanceTimersByTimeAsync(60_000)
    expect(rowOf(a).heartbeatAt).toBe(beat)
    expect(aborts(server.calls)).toEqual(['abort u1'])
    expect(server.calls).not.toContain('presign u1')

    // Nothing is moving once the last one is cancelled: the lock goes.
    useUploadStore.getState().cancelUpload(b)
    await flush()
    expect(rowOf(b).status).toBe('cancelled')
    expect(testing.wakeLockWanted()).toBe(false)
  })
})

describe('cancel while storage cannot answer', () => {
  it('a cancelled upload gives its place to the next file at once, not when /upload/abort answers', async () => {
    // APP-BUG-5 (e2e S4). The abort is a request to the API, which asks storage to throw the
    // parts away; with storage hanging the API takes its client's full retry budget to give up
    // (310 s with the e2e MinIO paused, 10.5 s with it unplugged, measured). The run used to
    // await that answer before giving back its place, so the queue stood still behind a row that
    // already read "Cancelled".
    const server = fakeServer(() => 'answer', 'hang')
    const post = vi.mocked(api.post).getMockImplementation()!
    let answerAbort!: () => void
    vi.mocked(api.post).mockImplementation(((path: string, body?: unknown) => {
      if (path !== '/upload/abort') return post(path, body)
      post(path, body)
      return new Promise((resolve) => { answerAbort = () => resolve({}) })
    }) as never)

    const [a, , , d] = drop([small('a.jpg'), small('b.jpg'), small('c.jpg'), small('d.jpg')])
    await settle()
    expect(server.names()).toEqual(['a.jpg', 'b.jpg', 'c.jpg'])
    expect(rowOf(d).status).toBe('queued')
    const revision = useUploadStore.getState().versionsRevision

    useUploadStore.getState().cancelUpload(a)
    await settle()

    expect(rowOf(a).status).toBe('cancelled')
    expect(aborts(server.calls)).toEqual(['abort u1'])
    // The abort is still out, and the next file has started.
    expect(server.names()).toEqual(['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'])
    expect(testing.runningIds()).not.toContain(a)
    // The version list hears of it only once the server has answered.
    expect(useUploadStore.getState().versionsRevision).toBe(revision)
    answerAbort()
    await settle()
    expect(useUploadStore.getState().versionsRevision).toBe(revision + 1)
    expect(aborts(server.calls)).toEqual(['abort u1'])
  })

  it("the next file starts only once every part of the cancelled one has settled, though the abort is still out", async () => {
    // The order APP-BUG-5's fix relies on: with the abort no longer awaited, the run gives its place
    // back right after its parts have settled (`uploadParts` awaits every part before it throws), so
    // the next file can never send while the cancelled one still holds slots of the part budget.
    vi.useFakeTimers()
    const server = fakeServer(() => 'answer')
    const post = vi.mocked(api.post).getMockImplementation()!
    vi.mocked(api.post).mockImplementation(((path: string, body?: unknown) => {
      if (path !== '/upload/abort') return post(path, body)
      post(path, body)
      return new Promise(() => {}) // storage never answers
    }) as never)
    // Every PUT hangs until aborted, and `big`'s report their abort a second late, as a request
    // that takes a moment to wind down does: until then each still holds its slot.
    const ended = new Set<FakeXhr>()
    const xhrs = installXhrFake((url, request) => {
      if (url.includes('/u1/')) {
        const abort = request.abort.bind(request)
        request.abort = () => { setTimeout(() => { abort(); ended.add(request) }, 1_000) }
      }
      return new Promise(() => {})
    })
    const openAt = new Map<string, number>()
    let checking = true
    const stillOpen = (uploadId: string) => xhrs.filter((x) => x.url.includes(`/${uploadId}/`) && !ended.has(x)).length

    // `big` takes every slot of the budget (5 parts in flight); `next` waits for a place.
    const [big, next] = drop([fileOf('big.mov', 80 * MB), small('next.jpg')])
    await flush()
    expect(xhrs.filter((x) => x.url.includes('/u1/'))).toHaveLength(5)
    expect(server.names()).toEqual(['big.mov'])

    const initiate = vi.mocked(api.post).getMockImplementation()!
    vi.mocked(api.post).mockImplementation(((path: string, body?: unknown) => {
      if (checking && path === '/upload/initiate') openAt.set(String((body as { original_filename?: string }).original_filename), stillOpen('u1'))
      return initiate(path, body)
    }) as never)

    useUploadStore.getState().cancelUpload(big)
    await flush()
    // Nothing starts while big's parts wind down.
    expect(server.names()).toEqual(['big.mov'])
    await vi.advanceTimersByTimeAsync(1_000)
    await flush()
    checking = false

    expect(rowOf(big).status).toBe('cancelled')
    expect(server.names()).toEqual(['big.mov', 'next.jpg'])
    expect(openAt.get('next.jpg'), "big's PUTs still open when next asked to start").toBe(0)
    expect(aborts(server.calls)).toEqual(['abort u1'])
    // And next's part goes out within the budget.
    expect(rowOf(next).status).toBe('uploading')
    expect(xhrs.filter((x) => x.url.includes('/u2/'))).toHaveLength(1)
  })
})

describe('cancel, then Remove before the run has settled', () => {
  // #523. Cancel on an uploading row and Remove on a cancelled one are the same X in the same
  // place, so a double click does both. The run ends only once the request out at the cancel
  // has wound down, and by then the row is gone: the abort is still the user's decision.

  /** Every part PUT hangs, and an abort reports only when the test says so. */
  function slowAborts() {
    const pending: Array<() => void> = []
    installXhrFake((_, request) => {
      const abort = request.abort.bind(request)
      request.abort = () => { pending.push(abort) }
      return new Promise(() => {})
    })
    return { windDown: () => { while (pending.length) pending.shift()!() } }
  }

  it('a new upload still sends /upload/abort', async () => {
    const server = fakeServer(() => 'answer')
    const parts = slowAborts()

    const [a] = drop([fileOf('a.mov')])
    await settle()
    expect(rowOf(a).status).toBe('uploading')

    useUploadStore.getState().cancelUpload(a)
    useUploadStore.getState().removeFile(a)
    await settle()
    expect(listed(a)).toBe(false)
    expect(aborts(server.calls)).toEqual([])

    parts.windDown()
    await settle()

    expect(aborts(server.calls)).toEqual(['abort u1'])
    expect(api.post).toHaveBeenCalledWith('/upload/abort', {
      s3_key: 'k1', upload_id: 'u1', version_id: 'v1', discard: true,
    }, { pinSubject: 'user-1' })
    expect(listed(a)).toBe(false)
    expect(testing.runningIds()).toEqual([])
  })

  it('a resumed upload still sends /upload/abort', async () => {
    testing.setClaimSettleMs(0)
    const server = fakeServer(() => 'answer')
    const parts = slowAborts()
    vi.mocked(api.get).mockResolvedValue(resumable({ file_size_bytes: 50 * MB }) as never)
    useUploadStore.setState({
      files: [row({
        id: 'r', status: 'interrupted', fileSize: 50 * MB,
        assetId: 'ra', versionId: 'rv', uploadId: 'ru', s3Key: 'rk',
      })],
    })

    useUploadStore.getState().resumeUpload('r', fileOf('clip.mp4'))
    await settle()
    expect(rowOf('r').status).toBe('uploading')

    useUploadStore.getState().cancelUpload('r')
    useUploadStore.getState().removeFile('r')
    await settle()
    expect(listed('r')).toBe(false)
    expect(aborts(server.calls)).toEqual([])

    parts.windDown()
    await settle()

    expect(aborts(server.calls)).toEqual(['abort ru'])
    expect(api.post).toHaveBeenCalledWith('/upload/abort', {
      s3_key: 'rk', upload_id: 'ru', version_id: 'rv', discard: true,
    }, { pinSubject: 'user-1' })
    expect(testing.runningIds()).toEqual([])
  })

  it('an upload whose initiate was out still sends /upload/abort for what it created', async () => {
    const server = fakeServer(() => 'wait', 'hang')

    const [a] = drop([small('a.jpg')])
    await settle()
    expect(rowOf(a).status).toBe('starting')

    useUploadStore.getState().cancelUpload(a)
    useUploadStore.getState().removeFile(a)
    await settle()
    expect(listed(a)).toBe(false)
    expect(server.others()).toEqual([])

    server.initiates[0].resolve()
    await settle()

    expect(server.others()).toEqual(['abort u1'])
    expect(api.post).toHaveBeenCalledWith('/upload/abort', {
      s3_key: 'k1', upload_id: 'u1', version_id: 'v1', discard: true,
    }, { pinSubject: 'user-1' })
    expect(listed(a)).toBe(false)
    expect(testing.runningIds()).toEqual([])
  })
})

// ---------------------------------------------------------------- cancel all queued

describe('cancelAllQueued', () => {
  it('cancelAllQueued leaves starting and uploading rows alone', async () => {
    const server = fakeServer((_, i) => (i === 0 ? 'answer' : 'wait'), 'hang')
    vi.mocked(api.get).mockImplementation(() => new Promise(() => {}) as never)
    useUploadStore.setState({
      files: [
        row({ id: 'r1', status: 'interrupted', fileSize: MB, assetId: 'a-r1', versionId: 'v-r1', uploadId: 'u-r1' }),
        row({ id: 'r2', status: 'interrupted', fileSize: MB, assetId: 'a-r2', versionId: 'v-r2', uploadId: 'u-r2' }),
      ],
    })

    const [s0, s1] = drop([small('s0.jpg'), small('s1.jpg')])
    await settle()
    useUploadStore.getState().resumeUpload('r1', small('clip.mp4'))
    await settle()
    const [q0, q1] = drop([small('q0.jpg'), small('q1.jpg')])
    useUploadStore.getState().resumeUpload('r2', small('clip.mp4'))
    await settle()

    expect(rowOf(s0).status).toBe('uploading')
    expect(rowOf(s1).status).toBe('starting')
    expect(rowOf('r1')).toMatchObject({ status: 'starting', resuming: true })
    expect([rowOf(q0).status, rowOf(q1).status]).toEqual(['queued', 'queued'])
    expect(rowOf('r2')).toMatchObject({ status: 'interrupted', queuedResume: true })

    useUploadStore.getState().cancelAllQueued()
    await settle()

    expect(listed(q0)).toBe(false)
    expect(listed(q1)).toBe(false)
    expect(rowOf('r2').status).toBe('interrupted')
    expect(rowOf('r2').queuedResume).toBeUndefined()
    expect(rowOf(s0).status).toBe('uploading')
    expect(rowOf(s1).status).toBe('starting')
    expect(rowOf('r1')).toMatchObject({ status: 'starting', resuming: true })
    expect(server.others()).toEqual(['presign u1'])

    // A place frees up, and nothing that was cancelled takes it.
    server.initiates[1].reject(new ApiError(400, 'No'))
    await settle()
    expect(server.names()).toEqual(['s0.jpg', 's1.jpg'])
    expect(api.get).toHaveBeenCalledTimes(1)
  })

  it('cancelAllQueued while the probe holds ends the hold, and a later drop starts', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const server = fakeServer((_, i) => (i === 0 ? new TypeError('Failed to fetch') : 'wait'))

    drop([fileOf('a.mov'), fileOf('b.mov'), fileOf('c.mov')])
    await flush()

    useUploadStore.getState().cancelAllQueued()
    expect(files()).toEqual([])

    drop([fileOf('d.mov')])
    await flush()
    expect(server.names()).toEqual(['a.mov', 'd.mov'])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(server.names()).toEqual(['a.mov', 'd.mov'])
  })
})

// ---------------------------------------------------------------- retry

describe('retry', () => {
  it('retry re-queues a refused row next; an unreadable row offers no retry', async () => {
    const server = fakeServer((_, i) => (i === 0 ? new ApiError(400, 'Too big') : 'wait'))

    const [a, b] = drop([fileOf('a.mov'), fileOf('b.mov'), fileOf('c.mov'), fileOf('d.mov')])
    await settle()
    expect(rowOf(a)).toMatchObject({ status: 'failed', failedBeforeStart: true, retryable: true })
    expect(rowOf(b).status).toBe('starting')
    expect(useUploadStore.getState().canRetry(a)).toBe(true)

    useUploadStore.getState().retryUpload(a)
    expect(rowOf(a).status).toBe('queued')
    expect(rowOf(a).error).toBeUndefined()
    expect(rowOf(a).failedBeforeStart).toBeUndefined()
    expect(useUploadStore.getState().canRetry(a)).toBe(false)

    // The next turn is A's, ahead of C and D.
    server.initiates[1].reject(new ApiError(400, 'No'))
    await settle()
    expect(server.names()).toEqual(['a.mov', 'b.mov', 'a.mov'])

    // An unreadable file (its handle stays unreadable) is refused without Retry.
    useUploadStore.setState((s) => ({
      files: s.files.map((f) => (f.id === b ? { ...f, retryable: false } : f)),
    }))
    expect(useUploadStore.getState().canRetry(b)).toBe(false)
    useUploadStore.getState().retryUpload(b)
    expect(rowOf(b).status).toBe('failed')

    // Without its File -- another tab's row, or one restored after a reload -- there is nothing to send.
    useUploadStore.setState((s) => ({
      files: [...s.files, row({ id: 'x', status: 'failed', failedBeforeStart: true, retryable: true })],
    }))
    expect(useUploadStore.getState().canRetry('x')).toBe(false)
    useUploadStore.getState().retryUpload('x')
    expect(rowOf('x').status).toBe('failed')

    const [restored] = rehydrate([stored().find((f) => f.id === b)!])
    expect(restored.retryable).toBeUndefined()

    await settle()
    expect(server.names()).toEqual(['a.mov', 'b.mov', 'a.mov'])
  })

  it('a retry during a hold waits behind the probe', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const server = fakeServer((_, i) =>
      i === 0 ? new ApiError(400, 'Too big') : i === 1 ? new TypeError('Failed to fetch') : 'wait',
    )

    const [a, b, c] = drop([fileOf('a.mov'), fileOf('b.mov'), fileOf('c.mov')])
    await flush()
    expect(rowOf(a).status).toBe('failed')
    expect(rowOf(b).holdReason).toBe('connection')

    useUploadStore.getState().retryUpload(a)
    await flush()
    expect(server.names()).toEqual(['a.mov', 'b.mov'])

    await vi.advanceTimersByTimeAsync(2_000)
    server.initiates[2].resolve()
    await flush()
    // The probe got through and sent its parts; A, retried, goes before C.
    expect(server.names()).toEqual(['a.mov', 'b.mov', 'b.mov', 'a.mov'])
    expect(rowOf(c).status).toBe('queued')
  })
})
