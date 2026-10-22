/**
 * The upload queue, driven through the store.
 *
 * Every file dropped or picked used to initiate at once, each with its own pool
 * of part workers. Now rows wait in a tab-wide queue and start at their turn:
 * at most three files are active, and the next one starts only while the active
 * files leave part slots free (spec goal 2). Nothing reaches the server for a
 * file before its turn (goal 4), and an initiate that fails is either the
 * server refusing this file, which fails the row and lets the queue go on, or
 * the connection or storage being down, which holds the queue (goal 6).
 *
 * The API is mocked but `ApiError` is the real one, so `code` and `retryAfter`
 * reach the classification as they would in the browser.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  api: { post: vi.fn(), get: vi.fn(), patch: vi.fn() },
}))
vi.mock('swr', () => ({ mutate: vi.fn() }))

import { api, ApiError } from '@/lib/api'
import { useUploadStore, __uploadQueueTesting as testing, type UploadFile } from '../upload-store'
import { installXhrFake, ok } from '@/test/xhr-fake'
import { signInAs, row } from '@/test/upload-session'

const MB = 1024 * 1024
const CHUNK = 10 * MB

/**
 * A file that says it is `size` bytes without allocating them. The parts cut
 * from it are empty, which the fake storage never looks at.
 */
function fileOf(name: string, size = 50 * MB, type = 'video/quicktime'): File {
  const file = new File([new Uint8Array(1)], name, { type })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

/** At most 5 MiB: certainly one part, so it counts 1 against the budget while it starts. */
const small = (name: string) => fileOf(name, 1 * MB, 'image/jpeg')

type Body = Record<string, unknown>

interface Initiate {
  body: Body
  resolve: (over?: Record<string, unknown>) => void
  reject: (err: unknown) => void
}

/**
 * The API and the storage backend.
 *
 * `plan` decides each initiate as it arrives: `'answer'` answers it at once,
 * `'wait'` leaves it to the test (`initiates[i].resolve()` / `.reject()`), and
 * anything else is the error it fails with. With `parts: 'hang'` every part PUT
 * waits for the test to `finish()` it.
 */
function fakeServer(
  plan: (body: Body, index: number) => unknown = () => 'answer',
  parts: 'ok' | 'hang' = 'ok',
) {
  const initiates: Initiate[] = []
  /** Initiates and aborts, in the order they were sent. */
  const calls: string[] = []
  const inFlight: Array<{ url: string; finish: () => void }> = []

  vi.mocked(api.post).mockImplementation(((path: string, body?: unknown) => {
    const b = (body ?? {}) as Body
    if (path === '/upload/initiate' || /^\/assets\/[^/]+\/versions$/.test(path)) {
      const n = initiates.length + 1
      calls.push(`initiate ${String(b.original_filename)}`)
      let resolve!: (value: unknown) => void
      let reject!: (err: unknown) => void
      const answer = new Promise((res, rej) => {
        resolve = res
        reject = rej
      })
      const entry: Initiate = {
        body: b,
        resolve: (over = {}) =>
          resolve({
            upload_id: `u${n}`, s3_key: `k${n}`, asset_id: `a${n}`, version_id: `v${n}`,
            chunk_size_bytes: CHUNK, ...over,
          }),
        reject,
      }
      initiates.push(entry)
      const decided = plan(b, n - 1)
      if (decided === 'answer') entry.resolve()
      else if (decided !== 'wait') entry.reject(decided)
      return answer
    }
    if (path === '/upload/presign-part') {
      return Promise.resolve({ presigned_url: `https://s3.test/${String(b.upload_id)}/${String(b.part_number)}` })
    }
    if (path === '/upload/abort') calls.push(`abort ${String(b.upload_id)}`)
    return Promise.resolve({})
  }) as never)

  installXhrFake((url) => {
    if (parts === 'ok') return ok('"e"')
    return new Promise((resolve) => inFlight.push({ url, finish: () => resolve(ok('"e"')) }))
  })

  return {
    initiates,
    calls,
    inFlight,
    /** The file name of every initiate, in the order they were sent. */
    names: () => initiates.map((i) => String(i.body.original_filename)),
    /** Finishes the oldest part PUT still on the wire. */
    finishOne: () => inFlight.shift()!.finish(),
  }
}

function drop(files: File[], projectId = 'p1'): string[] {
  return useUploadStore.getState().startUploads(
    files.map((file) => ({ file, assetName: file.name.replace(/\.[^.]+$/, '') })),
    projectId,
    'Project',
    null,
  )
}

const rowOf = (id: string) => useUploadStore.getState().files.find((f) => f.id === id)!
const files = () => useUploadStore.getState().files
const active = () => files().filter((f) => f.status === 'starting' || f.status === 'uploading')
const stored = (): UploadFile[] =>
  JSON.parse(window.localStorage.getItem('ff-uploads') ?? '{}').state?.files ?? []

/** Lets every promise job and zero-delay timer that is due run, with real timers. */
async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0))
}

/** The same, under fake timers, without moving the clock. */
async function flush() {
  for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0)
}

/** What zustand's persist middleware does on the way in. */
function rehydrate(rows: UploadFile[]): UploadFile[] {
  const opts = (useUploadStore as unknown as {
    persist: { getOptions: () => { merge?: (p: unknown, c: unknown) => { files: UploadFile[] } } }
  }).persist.getOptions()
  return opts.merge!({ files: rows }, { files: [] }).files
}

beforeEach(() => {
  vi.clearAllMocks()
  testing.reset()
  window.localStorage.clear()
  useUploadStore.setState({ files: [], versionsRevision: 0, panelOpen: false })
  signInAs('user-1')
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  testing.reset()
})

// ---------------------------------------------------------------- the start rule

describe('the start rule', () => {
  it('dropping three large files sends exactly one initiate before its answer', async () => {
    const server = fakeServer(() => 'wait')

    const ids = drop([fileOf('a.mov'), fileOf('b.mov'), fileOf('c.mov')])
    await settle()

    expect(server.names()).toEqual(['a.mov'])
    expect(ids.map((id) => rowOf(id).status)).toEqual(['starting', 'queued', 'queued'])

    // And it stays one while the answer is out, whatever else asks the queue
    // to look again: until the server picks a part size, the file starting
    // counts as the whole budget.
    drop([small('d.jpg')])
    await settle()
    expect(server.names()).toEqual(['a.mov'])
  })

  it('the next file initiates when the active file is on its last parts', async () => {
    // Six parts: five on the wire at once, the sixth waiting for a slot.
    const server = fakeServer(() => 'answer', 'hang')

    drop([fileOf('a.mov', 60 * MB), fileOf('b.mov')])
    await settle()
    expect(server.inFlight).toHaveLength(5)

    server.finishOne()
    await settle()
    // Five parts left, every slot in use: nothing for a second file yet.
    expect(server.names()).toEqual(['a.mov'])

    server.finishOne()
    await settle()
    // Four left: a slot is free, and the next file starts on it.
    expect(server.names()).toEqual(['a.mov', 'b.mov'])
  })

  it('never more than 3 rows are starting or uploading', async () => {
    const server = fakeServer(() => 'wait')

    drop(Array.from({ length: 6 }, (_, i) => small(`s${i}.jpg`)))
    await settle()
    expect(active()).toHaveLength(3)
    expect(files().filter((f) => f.status === 'queued')).toHaveLength(3)

    for (let answered = 0; answered < 6; answered++) {
      server.initiates[answered].resolve()
      await settle()
      expect(active().length).toBeLessThanOrEqual(3)
    }
    expect(server.names()).toEqual(['s0.jpg', 's1.jpg', 's2.jpg', 's3.jpg', 's4.jpg', 's5.jpg'])
  })

  it('files start in drop order across two drops', async () => {
    const server = fakeServer(() => 'answer', 'ok')

    drop([fileOf('a1.mov'), small('a2.jpg'), fileOf('a3.mov')])
    drop([small('b1.jpg'), fileOf('b2.mov')])

    await vi.waitFor(() => expect(server.names()).toHaveLength(5))
    expect(server.names()).toEqual(['a1.mov', 'a2.jpg', 'a3.mov', 'b1.jpg', 'b2.mov'])
  })

  it('with budget 5, while file A holds all 5 slots with 4+ parts left, file B does not initiate', async () => {
    // Eight parts. While five or more are unfinished, A has every slot.
    const server = fakeServer(() => 'answer', 'hang')

    drop([fileOf('a.mov', 80 * MB), small('b.jpg')])
    await settle()
    expect(server.inFlight).toHaveLength(5)

    for (let done = 1; done <= 3; done++) {
      server.finishOne()
      await settle()
      expect(server.inFlight).toHaveLength(5)
      expect(server.names()).toEqual(['a.mov'])
    }

    // Four left: one slot free, and B, a single part, takes its turn.
    server.finishOne()
    await settle()
    expect(server.names()).toEqual(['a.mov', 'b.jpg'])
  })

  it('cancelling an Initiating row does not let a 4th file start before its initiate answer is handled', async () => {
    // A cancelled row whose initiate is still out may yet have created an
    // upload, which has to be thrown away. Until then it is still active.
    const server = fakeServer(() => 'wait', 'hang')

    const ids = drop([small('s0.jpg'), small('s1.jpg'), small('s2.jpg'), small('s3.jpg')])
    await settle()
    expect(server.names()).toEqual(['s0.jpg', 's1.jpg', 's2.jpg'])

    useUploadStore.getState().cancelUpload(ids[0])
    await settle()
    expect(server.names()).toHaveLength(3)

    server.initiates[0].resolve()
    await settle()
    expect(server.calls).toEqual([
      'initiate s0.jpg', 'initiate s1.jpg', 'initiate s2.jpg', 'abort u1', 'initiate s3.jpg',
    ])
  })

  it('a free part slot goes to the file that started first', async () => {
    // A small file and a large one start together. The large one's initiate
    // answers first and takes every slot; once the small one is ready, the
    // next free slot is its, because it started first.
    const server = fakeServer(() => 'wait', 'hang')

    drop([small('a.jpg'), fileOf('b.mov', 80 * MB)])
    await settle()
    expect(server.names()).toEqual(['a.jpg', 'b.mov'])

    server.initiates[1].resolve()
    await settle()
    expect(server.inFlight.map((p) => p.url.split('/')[3])).toEqual(['u2', 'u2', 'u2', 'u2', 'u2'])

    server.initiates[0].resolve()
    await settle()
    expect(server.inFlight).toHaveLength(5)

    server.finishOne()
    await settle()
    expect(server.inFlight.map((p) => p.url.split('/')[3])).toContain('u1')
  })

  it('the same File dropped twice gives two rows and two initiates', async () => {
    const server = fakeServer(() => 'wait')
    const file = small('same.jpg')

    const [first] = drop([file])
    const [second] = drop([file])
    await settle()

    expect(first).not.toBe(second)
    expect(files().filter((f) => f.fileName === 'same.jpg')).toHaveLength(2)
    expect(server.names()).toEqual(['same.jpg', 'same.jpg'])
  })
})

// ---------------------------------------------------------------- nothing before the turn

describe('a queued row', () => {
  it('a queued row registers no abort controller, heartbeat or wake lock', async () => {
    fakeServer(() => 'wait')

    const [a, b] = drop([fileOf('a.mov'), fileOf('b.mov')])
    await settle()

    expect(testing.hasAbortController(a)).toBe(true)
    expect(rowOf(a).ownerTab).toBeDefined()
    expect(testing.wakeLockHolders()).toBe(1)

    expect(testing.hasAbortController(b)).toBe(false)
    expect(rowOf(b).ownerTab).toBeUndefined()
    expect(rowOf(b).heartbeatAt).toBeUndefined()
  })

  it('queued rows are never persisted', async () => {
    const server = fakeServer(() => 'wait', 'hang')

    const [a, b, c] = drop([fileOf('a.mov'), fileOf('b.mov'), fileOf('c.mov')])
    await settle()
    useUploadStore.getState().setPanelOpen(true)
    // Not even the starting one: until initiate answers it has nothing to come back to.
    expect(stored().map((f) => f.id)).toEqual([])

    server.initiates[0].resolve()
    await settle()
    useUploadStore.getState().setPanelOpen(false)
    expect(stored().map((f) => f.id)).toEqual([a])
    expect(stored().map((f) => f.id)).not.toContain(b)
    expect(stored().map((f) => f.id)).not.toContain(c)
  })

  it('rename while queued sends the new name at initiate', async () => {
    const server = fakeServer(() => 'wait')

    const [, b] = drop([fileOf('a.mov'), fileOf('b.mov')])
    await settle()
    expect(await useUploadStore.getState().renameUpload(b, 'Ep04 final')).toBeNull()
    // Nothing on the server to rename yet.
    expect(api.patch).not.toHaveBeenCalled()

    server.initiates[0].reject(new ApiError(400, 'Too big'))
    await settle()

    expect(server.initiates[1].body.asset_name).toBe('Ep04 final')
    expect(api.patch).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------- refusals

describe('an initiate the server refuses', () => {
  it('a 400 at initiate fails that row with Retry and the next file starts', async () => {
    const server = fakeServer((_, i) => (i === 0 ? new ApiError(400, 'Storage limit reached') : 'wait'))

    const [a, b] = drop([fileOf('a.mov'), fileOf('b.mov')])
    await settle()

    expect(rowOf(a)).toMatchObject({
      status: 'failed', failedBeforeStart: true, retryable: true, error: 'Storage limit reached',
    })
    expect(rowOf(b).status).toBe('starting')
    expect(server.names()).toEqual(['a.mov', 'b.mov'])
  })

  it('a coded 500 storage_error fails the row with its message and the queue continues', async () => {
    const server = fakeServer((_, i) =>
      i === 0 ? new ApiError(500, 'Storage refused: AccessDenied', { code: 'storage_error' }) : 'wait',
    )

    const [a, b] = drop([fileOf('a.mov'), fileOf('b.mov')])
    await settle()

    expect(rowOf(a)).toMatchObject({
      status: 'failed', failedBeforeStart: true, retryable: true, error: 'Storage refused: AccessDenied',
    })
    expect(rowOf(a).holdReason).toBeUndefined()
    expect(rowOf(b).status).toBe('starting')
    expect(server.names()).toEqual(['a.mov', 'b.mov'])
  })

  it('an empty drop adds nothing and opens nothing', () => {
    expect(useUploadStore.getState().startUploads([], 'p1')).toEqual([])
    expect(files()).toEqual([])
    expect(useUploadStore.getState().panelOpen).toBe(false)
  })

  it('a refusal with no message still says why', async () => {
    fakeServer(() => new ApiError(403, '  '))

    const [a] = drop([small('a.jpg')])
    await settle()

    expect(rowOf(a).error).toBe('The server refused this upload.')
  })

  it('a refused row restored from storage has no retryable flag', async () => {
    // Retry needs the File, which only this tab, and only until a reload, holds.
    fakeServer(() => new ApiError(400, 'Unsupported file type'))

    const [a] = drop([small('a.xyz')])
    await settle()
    expect(rowOf(a).retryable).toBe(true)

    const saved = stored().find((f) => f.id === a)!
    expect(saved).toMatchObject({ status: 'failed', failedBeforeStart: true, error: 'Unsupported file type' })
    expect(saved).not.toHaveProperty('retryable')

    const [restored] = rehydrate([saved])
    expect(restored.status).toBe('failed')
    expect(restored.retryable).toBeUndefined()
  })

  it('a zero-byte file is refused (422) and the queue continues', async () => {
    const server = fakeServer((body) =>
      body.file_size_bytes === 0 ? new ApiError(422, 'file_size_bytes: Input should be greater than 0') : 'wait',
    )

    const [empty] = drop([
      new File([], 'empty.mov', { type: 'video/quicktime' }), small('b.jpg'), small('c.jpg'), small('d.jpg'),
    ])
    await settle()

    expect(rowOf(empty)).toMatchObject({ status: 'failed', failedBeforeStart: true, retryable: true })
    expect(server.names()).toEqual(['empty.mov', 'b.jpg', 'c.jpg', 'd.jpg'])
  })

  it('a 404 project fails its files at their turn while another project\'s files start', async () => {
    const server = fakeServer((body) =>
      body.project_id === 'gone' ? new ApiError(404, 'Project not found') : 'wait',
    )

    const gone = drop([small('g0.jpg'), small('g1.jpg'), small('g2.jpg'), small('g3.jpg')], 'gone')
    const live = drop([small('l0.jpg'), small('l1.jpg')], 'live')
    await settle()

    for (const id of gone) {
      expect(rowOf(id)).toMatchObject({ status: 'failed', failedBeforeStart: true, error: 'Project not found' })
    }
    expect(live.map((id) => rowOf(id).status)).toEqual(['starting', 'starting'])
    // Each file was asked about at its own turn, not failed for its neighbour.
    expect(server.names()).toEqual(['g0.jpg', 'g1.jpg', 'g2.jpg', 'g3.jpg', 'l0.jpg', 'l1.jpg'])
  })
})

// ---------------------------------------------------------------- holds

describe('an initiate that cannot get through', () => {
  it('a TypeError at initiate holds the queue and the 9 rows behind are not failed', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const server = fakeServer((_, i) => (i <= 1 ? new TypeError('Failed to fetch') : 'wait'))

    const ids = drop(Array.from({ length: 10 }, (_, i) => fileOf(`f${i}.mov`)))
    await flush()

    expect(rowOf(ids[0])).toMatchObject({ status: 'queued', holdReason: 'connection' })
    for (const id of ids.slice(1)) {
      expect(rowOf(id).status).toBe('queued')
      expect(rowOf(id).holdReason).toBeUndefined()
    }
    expect(server.names()).toEqual(['f0.mov'])
    // Not an ApiError, so nothing on screen says what it was. The console does.
    expect(warn).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(server.names()).toEqual(['f0.mov'])

    // Only the probe tries again, and fails the same way: still one warning.
    await vi.advanceTimersByTimeAsync(1_000)
    await flush()
    expect(server.names()).toEqual(['f0.mov', 'f0.mov'])
    expect(rowOf(ids[0])).toMatchObject({ status: 'queued', holdReason: 'connection' })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(files().some((f) => f.status === 'failed')).toBe(false)
  })

  it('a second file that cannot get through waits behind the probe, then starts after it', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Both small, so both start at once; both fail; the first is the probe.
    const server = fakeServer((_, i) => (i <= 1 ? new TypeError('Failed to fetch') : 'wait'))

    const [s0, s1, s2] = drop([small('s0.jpg'), small('s1.jpg'), small('s2.jpg')])
    await flush()
    expect(server.names()).toEqual(['s0.jpg', 's1.jpg', 's2.jpg'])
    expect(rowOf(s0)).toMatchObject({ status: 'queued', holdReason: 'connection' })
    expect(rowOf(s1).status).toBe('queued')
    expect(rowOf(s1).holdReason).toBeUndefined()
    expect(rowOf(s2).status).toBe('starting')

    await vi.advanceTimersByTimeAsync(2_000)
    expect(server.names()).toEqual(['s0.jpg', 's1.jpg', 's2.jpg', 's0.jpg'])
    server.initiates[3].resolve()
    await flush()

    // The probe got through: the hold is over and the file behind it goes next.
    expect(server.names()).toEqual(['s0.jpg', 's1.jpg', 's2.jpg', 's0.jpg', 's1.jpg'])
  })

  it('a coded 503 holds, then retries after retry_after', async () => {
    vi.useFakeTimers()
    const server = fakeServer(
      (_, i) =>
        i === 0
          ? new ApiError(503, 'Storage is not answering', { code: 'storage_unavailable', retryAfter: 5 })
          : 'answer',
      'hang',
    )

    const [a, b] = drop([fileOf('a.mov', 30 * MB), small('b.jpg')])
    await flush()
    expect(rowOf(a)).toMatchObject({ status: 'queued', holdReason: 'storage' })
    expect(rowOf(b).status).toBe('queued')

    await vi.advanceTimersByTimeAsync(4_999)
    expect(server.names()).toEqual(['a.mov'])

    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(server.names().slice(0, 2)).toEqual(['a.mov', 'a.mov'])
    expect(rowOf(a).status).toBe('uploading')
    expect(rowOf(a).holdReason).toBeUndefined()
    // The hold is over, and A's three parts leave room for B.
    expect(server.names()).toEqual(['a.mov', 'a.mov', 'b.jpg'])
  })

  it('a 502 and a 429 at initiate each hold, and the 9 rows behind are not failed', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const server = fakeServer((_, i) =>
      i === 0 ? new ApiError(502, 'Bad Gateway') : i === 1 ? new ApiError(429, 'Too Many Requests') : 'wait',
    )

    const ids = drop(Array.from({ length: 10 }, (_, i) => fileOf(`f${i}.mov`)))
    await flush()
    expect(rowOf(ids[0])).toMatchObject({ status: 'queued', holdReason: 'connection' })
    expect(server.names()).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(2_000)
    await flush()
    // The 429 is a hold too, and the wait doubles.
    expect(server.names()).toEqual(['f0.mov', 'f0.mov'])
    expect(rowOf(ids[0])).toMatchObject({ status: 'queued', holdReason: 'connection' })
    for (const id of ids.slice(1)) {
      expect(rowOf(id).status).toBe('queued')
      expect(rowOf(id).holdReason).toBeUndefined()
    }

    await vi.advanceTimersByTimeAsync(3_999)
    expect(server.names()).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(server.names()).toHaveLength(3)
    expect(files().some((f) => f.status === 'failed')).toBe(false)
  })
})

describe('a storage outage that answers the same retry-after every time', () => {
  it('backs off: 5 initiates in the first 2 minutes, not one every 5 s', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const server = fakeServer(() =>
      new ApiError(503, 'Storage is not answering', { code: 'storage_unavailable', retryAfter: 5 }))

    const [a] = drop([fileOf('a.mov')])
    await flush()
    expect(rowOf(a)).toMatchObject({ status: 'queued', holdReason: 'storage' })

    await vi.advanceTimersByTimeAsync(120_000)
    await flush()

    // Tries at 0, 5, 15, 35 and 75 s; the next is due at 135 s.
    expect(server.names()).toHaveLength(5)
  })
})

// ---------------------------------------------------------------- a run that throws

describe('a run that throws before it reaches the server', () => {
  it('ends, gives back its place and its wake lock, and a later drop still starts', async () => {
    // Saving the row can throw (a full quota), and the first save of a run is
    // its first heartbeat. Here the 2nd and 3rd writes fail: the heartbeat, then
    // the row's own failure, so the run itself ends by throwing.
    const server = fakeServer(() => 'wait')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const realSetItem = Storage.prototype.setItem
    let writes = 0
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === 'ff-uploads') {
        writes += 1
        if (writes === 2 || writes === 3) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
      }
      return realSetItem.call(this, key, value)
    })

    const [a] = drop([fileOf('a.mov')])
    await settle()

    expect(rowOf(a).status).toBe('failed')
    expect(server.names()).toEqual([])
    expect(testing.runningIds()).toEqual([])
    expect(testing.hasAbortController(a)).toBe(false)
    expect(testing.wakeLockHolders()).toBe(0)
    // Not left as an unhandled rejection.
    expect(errors).toHaveBeenCalled()

    drop([fileOf('b.mov')])
    await settle()
    expect(server.names()).toEqual(['b.mov'])
  })

  it("a hold probe whose retry throws passes the hold on, and the file waiting behind it starts", async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const server = fakeServer((_, i) => (i === 0 ? new TypeError('Failed to fetch') : 'answer'))
    const [a] = drop([fileOf('a.mov')])
    await flush()
    expect(rowOf(a)).toMatchObject({ status: 'queued', holdReason: 'connection' })
    const [b] = drop([fileOf('b.mov')])
    await flush()
    expect(rowOf(b).status).toBe('queued')

    // At a's retry the first save of its run is refused (a full quota), so
    // the run throws before it reaches the server.
    const realSetItem = Storage.prototype.setItem
    let refused = 0
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === 'ff-uploads' && refused === 0) {
        refused += 1
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
      }
      return realSetItem.call(this, key, value)
    })
    await vi.advanceTimersByTimeAsync(2_000)
    await flush()
    expect(refused).toBe(1)
    expect(rowOf(a).status).toBe('failed')

    // The hold passed to b, which probes on the same backoff.
    await vi.advanceTimersByTimeAsync(60_000)
    await flush()
    expect(server.names()).toEqual(['a.mov', 'b.mov'])
    expect(rowOf(b).status).not.toBe('queued')
    expect(testing.runningIds()).toEqual(expect.not.arrayContaining([a]))
  })
})

// ---------------------------------------------------------------- resume and saving

describe('a resume', () => {
  it('waits for its turn instead of starting beside three active files', async () => {
    const server = fakeServer(() => 'wait')
    useUploadStore.setState({
      files: [row({ id: 'r', status: 'interrupted', fileSize: 1 * MB, assetId: 'ra', versionId: 'rv', uploadId: 'ru' })],
    })

    drop([small('s0.jpg'), small('s1.jpg'), small('s2.jpg')])
    await settle()
    useUploadStore.getState().resumeUpload('r', small('clip.mp4'))
    await settle()

    expect(api.get).not.toHaveBeenCalled()
    expect(rowOf('r')).toMatchObject({ status: 'interrupted', queuedResume: true })

    vi.mocked(api.get).mockImplementation(() => new Promise(() => {}) as never)
    server.initiates[0].reject(new ApiError(400, 'No'))
    await settle()
    // Its turn: it goes ahead of nothing that was already running, and starts.
    expect(api.get).toHaveBeenCalledWith('/upload/rv/parts', { pinSubject: 'user-1' })
    expect(rowOf('r')).toMatchObject({ status: 'starting', resuming: true })
  })

  it('goes ahead of files that have not started, behind the one that has', async () => {
    const server = fakeServer(() => 'wait')
    useUploadStore.setState({
      files: [row({ id: 'r', status: 'interrupted', fileSize: 50 * MB, assetId: 'ra', versionId: 'rv', uploadId: 'ru' })],
    })
    vi.mocked(api.get).mockImplementation(() => new Promise(() => {}) as never)

    drop([fileOf('a.mov'), fileOf('b.mov'), fileOf('c.mov')])
    await settle()
    useUploadStore.getState().resumeUpload('r', fileOf('clip.mp4'))
    await settle()
    expect(api.get).not.toHaveBeenCalled()

    server.initiates[0].reject(new ApiError(400, 'No'))
    await settle()

    expect(api.get).toHaveBeenCalledWith('/upload/rv/parts', { pinSubject: 'user-1' })
    expect(server.names()).toEqual(['a.mov'])
  })

  it('that cannot reach the server holds the queue as a held resume, never as a queued file', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const server = fakeServer(() => 'wait')
    vi.mocked(api.get).mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockImplementation(() => new Promise(() => {}) as never)
    useUploadStore.setState({
      files: [row({ id: 'r', status: 'interrupted', fileSize: 50 * MB, assetId: 'ra', versionId: 'rv', uploadId: 'ru' })],
    })

    useUploadStore.getState().resumeUpload('r', fileOf('clip.mp4'))
    await flush()
    // It still has its upload on the server, so it is still the interrupted row it was.
    expect(rowOf('r')).toMatchObject({ status: 'interrupted', queuedResume: true, holdReason: 'connection' })
    expect(rowOf('r').resuming).toBeUndefined()

    // Nothing else starts while it holds.
    drop([small('s.jpg')])
    await flush()
    expect(server.names()).toEqual([])

    await vi.advanceTimersByTimeAsync(2_000)
    expect(api.get).toHaveBeenCalledTimes(2)
    expect(rowOf('r')).toMatchObject({ status: 'starting', resuming: true })
  })

  it('that is discarded gives up its turn before Discard asks the server anything', async () => {
    const server = fakeServer(() => 'wait')
    useUploadStore.setState({
      files: [row({ id: 'r', status: 'interrupted', fileSize: 1 * MB, assetId: 'ra', versionId: 'rv', uploadId: 'ru', s3Key: 'rk' })],
    })
    let answerParts!: (value: unknown) => void
    vi.mocked(api.get).mockImplementation(() => new Promise((resolve) => {
      answerParts = resolve
    }) as never)

    drop([small('s0.jpg'), small('s1.jpg'), small('s2.jpg')])
    await settle()
    useUploadStore.getState().resumeUpload('r', small('clip.mp4'))
    const discarding = useUploadStore.getState().discardUpload('r')
    expect(api.get).toHaveBeenCalledTimes(1) // Discard's own /parts

    // A place frees up while Discard waits on the server: the row must not take it.
    server.initiates[0].reject(new ApiError(400, 'No'))
    await settle()
    expect(api.get).toHaveBeenCalledTimes(1)
    expect(rowOf('r').status).toBe('interrupted')
    expect(rowOf('r').queuedResume).toBeUndefined()

    answerParts({
      state: 'resumable', upload_id: 'ru', s3_key: 'rk', asset_id: 'ra', version_id: 'rv',
      chunk_size_bytes: CHUNK, file_size_bytes: MB, original_filename: 'clip.mp4', mime_type: 'video/mp4',
      held_part_numbers: [], last_activity_at: null,
    })
    expect(await discarding).toBeNull()
    expect(server.calls).toContain('abort ru')
    expect(files().find((f) => f.id === 'r')).toBeUndefined()
  })

  it('is not queued while a run of the same row is still settling', async () => {
    // The run's transfer broke after its completion was sent, and it is still
    // asking the server whether the object is whole. A second run started now
    // would have its row rewritten by the first run's answer.
    let answerParts!: (value: unknown) => void
    vi.mocked(api.post).mockImplementation(((path: string) => {
      if (path === '/upload/initiate') {
        return Promise.resolve({ upload_id: 'u1', s3_key: 'k1', asset_id: 'a1', version_id: 'v1', chunk_size_bytes: CHUNK })
      }
      if (path === '/upload/presign-part') return Promise.resolve({ presigned_url: 'https://s3.test/u1/1' })
      if (path === '/upload/complete') return Promise.reject(new TypeError('Failed to fetch'))
      return Promise.resolve({})
    }) as never)
    vi.mocked(api.get).mockImplementation(((path: string) => {
      if (path.startsWith('/assets/')) return Promise.resolve({ id: 'a1', latest_version: null })
      return new Promise((resolve) => {
        answerParts = resolve
      })
    }) as never)
    installXhrFake(() => ok('"e"'))

    const [a] = drop([small('a.jpg')])
    await vi.waitFor(() => expect(rowOf(a).status).toBe('interrupted'))
    await settle()
    expect(testing.runningIds()).toEqual([a])

    useUploadStore.getState().resumeUpload(a, small('a.jpg'))
    await settle()
    expect(rowOf(a).queuedResume).toBeUndefined()
    expect(api.get).toHaveBeenCalledTimes(2) // the asset read and the run's own /parts

    answerParts({ state: 'resumable' })
    await settle()
    expect(testing.runningIds()).toEqual([])
    expect(rowOf(a).status).toBe('interrupted')
  })

  it('a resuming or queued resume row is saved as plain interrupted', () => {
    useUploadStore.setState({
      files: [
        row({ id: 'q', status: 'interrupted', versionId: 'v1', uploadId: 'u1', queuedResume: true, holdReason: 'storage' }),
        row({ id: 's', status: 'starting', versionId: 'v2', uploadId: 'u2', resuming: true }),
        row({ id: 'n', status: 'starting' }),
        row({ id: 'w', status: 'queued' }),
      ],
    })

    const saved = stored()
    expect(saved.map((f) => f.id).sort()).toEqual(['q', 's'])
    for (const f of saved) {
      expect(f.status).toBe('interrupted')
      expect(f).not.toHaveProperty('queuedResume')
      expect(f).not.toHaveProperty('resuming')
      expect(f).not.toHaveProperty('holdReason')
    }
  })
})
