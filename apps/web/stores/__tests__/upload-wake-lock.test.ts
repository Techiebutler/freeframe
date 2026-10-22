import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  api: {
    post: vi.fn(),
    get: vi.fn(),
  },
}))
vi.mock('swr', () => ({ mutate: vi.fn() }))

import { useUploadStore, __uploadQueueTesting as testing, type UploadFile } from '../upload-store'
import { row, signInAs } from '@/test/upload-session'

// Rows belong to the account that added them: with nobody signed in, nothing is added.
beforeEach(() => signInAs('u1'))

/** Minimal stand-in for a WakeLockSentinel. */
function makeSentinel() {
  return {
    release: vi.fn().mockResolvedValue(undefined),
    addEventListener: vi.fn(),
  }
}

/** The whole list of rows, as a drop, a run or a poll would leave it. */
function setRows(...rows: Partial<UploadFile>[]) {
  useUploadStore.setState({ files: rows.map((r, i) => row({ id: `r${i + 1}`, ...r })) })
}

/** Change one row, the way a run does as it goes. */
function patch(id: string, change: Partial<UploadFile>) {
  useUploadStore.setState((s) => ({
    files: s.files.map((f) => (f.id === id ? { ...f, ...change } : f)),
  }))
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('upload wake lock', () => {
  let request: ReturnType<typeof vi.fn>
  let sentinel: ReturnType<typeof makeSentinel>

  beforeEach(() => {
    sentinel = makeSentinel()
    request = vi.fn().mockResolvedValue(sentinel)
    Object.defineProperty(navigator, 'wakeLock', {
      value: { request },
      configurable: true,
      writable: true,
    })
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  })

  afterEach(() => {
    // Nothing moving gives the lock back, and leaves none for the next test.
    useUploadStore.setState({ files: [] })
    testing.reset()
    Reflect.deleteProperty(navigator as object, 'wakeLock')
    Reflect.deleteProperty(document as object, 'visibilityState')
  })

  // ------------------------------------------------------------ held while moving

  it('held while a row is starting or uploading', async () => {
    setRows({ status: 'starting' })
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('screen'))
    expect(testing.wakeLockWanted()).toBe(true)

    // From starting to sending: still the one lock, neither given back nor asked for again.
    patch('r1', { status: 'uploading', progress: 10 })
    await Promise.resolve()
    expect(request).toHaveBeenCalledTimes(1)
    expect(sentinel.release).not.toHaveBeenCalled()
    expect(testing.wakeLockWanted()).toBe(true)
  })

  it('a resume that is starting holds it', async () => {
    setRows({ status: 'starting', resuming: true })
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('screen'))
  })

  it('a finalizing row holds it', async () => {
    // Finalizing is a flag on an uploading row: the bytes are all sent and the
    // page is waiting on storage, which the page has to stay open for.
    setRows({ status: 'uploading', finalizing: true, progress: 100 })
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('screen'))
    expect(sentinel.release).not.toHaveBeenCalled()
  })

  it('gives the lock back when the last moving row settles', async () => {
    setRows({ status: 'uploading' }, { id: 'r2', status: 'uploading' })
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))

    patch('r1', { status: 'processing', progress: 100 })
    expect(sentinel.release).not.toHaveBeenCalled() // r2 is still sending

    patch('r2', { status: 'failed' })
    expect(sentinel.release).toHaveBeenCalledTimes(1)
    expect(testing.wakeLockWanted()).toBe(false)
  })

  // ------------------------------------------------------------ not held while waiting

  it('released during a hold and while rows only wait', async () => {
    setRows({ status: 'uploading' }, { id: 'r2', status: 'queued' })
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))

    // The storage fills up: the sending row stops, the others wait on the hold.
    patch('r1', { status: 'queued', holdReason: 'storage' })
    expect(sentinel.release).toHaveBeenCalledTimes(1)
    expect(testing.wakeLockWanted()).toBe(false)

    // Waiting for a turn, held, or queued to resume: nothing is moving.
    useUploadStore.setState((s) => ({
      files: [
        ...s.files,
        row({ id: 'r3', status: 'interrupted', queuedResume: true }),
        row({ id: 'r4', status: 'interrupted', queuedResume: true, holdReason: 'connection' }),
      ],
    }))
    await Promise.resolve()
    expect(request).toHaveBeenCalledTimes(1)
    expect(testing.wakeLockWanted()).toBe(false)
  })

  it('is never asked for while rows only wait, finished or stopped', async () => {
    setRows(
      { status: 'queued' },
      { id: 'r2', status: 'queued', holdReason: 'connection' },
      { id: 'r3', status: 'interrupted', queuedResume: true },
      { id: 'r4', status: 'interrupted' },
      { id: 'r5', status: 'processing' },
      { id: 'r6', status: 'complete' },
      { id: 'r7', status: 'failed' },
      { id: 'r8', status: 'cancelled' },
    )
    await Promise.resolve()
    expect(request).not.toHaveBeenCalled()
  })

  it("another account's rows do not hold it", async () => {
    // A hidden old-account run can still be sending (spec goal 10). The lock
    // follows only the rows this account can see.
    setRows({ status: 'uploading', ownerId: 'u2' })
    await Promise.resolve()
    expect(request).not.toHaveBeenCalled()
    expect(testing.wakeLockWanted()).toBe(false)

    // Its owner signs in: the row is theirs to see, and it is sending.
    signInAs('u2')
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    expect(testing.wakeLockWanted()).toBe(true)

    // And back: hidden again, so the lock goes.
    signInAs('u1')
    expect(sentinel.release).toHaveBeenCalledTimes(1)
    expect(testing.wakeLockWanted()).toBe(false)
  })

  // ------------------------------------------------------------ visibility

  it('re-acquired on visibility', async () => {
    setRows({ status: 'uploading' })
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    const onRelease = sentinel.addEventListener.mock.calls.find(([type]) => type === 'release')?.[1]
    expect(onRelease).toBeTypeOf('function')

    // The tab is hidden: the browser drops the lock by itself and says so.
    const next = makeSentinel()
    request.mockResolvedValue(next)
    setVisibility('hidden')
    onRelease()
    expect(request).toHaveBeenCalledTimes(1)

    // Back on screen the dropped lock is dead, and a fresh one is asked for.
    setVisibility('visible')
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))

    // And that one is held and given back like the first.
    patch('r1', { status: 'processing' })
    expect(next.release).toHaveBeenCalledTimes(1)
  })

  it('does not ask again on visibility while a lock is still held', async () => {
    setRows({ status: 'uploading' })
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))

    setVisibility('visible')
    await Promise.resolve()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('coming back to the tab asks for nothing while nothing is moving', async () => {
    setRows({ status: 'queued' }, { id: 'r2', status: 'processing' })
    setVisibility('hidden')
    setVisibility('visible')
    await Promise.resolve()
    expect(request).not.toHaveBeenCalled()

    // Not after a lock was held and given back, either.
    setRows({ status: 'uploading' })
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    patch('r1', { status: 'complete' })
    setVisibility('visible')
    await Promise.resolve()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('tries again on visibility after the browser refused it while hidden', async () => {
    // Asked for while hidden, the browser refuses.
    request.mockRejectedValueOnce(new DOMException('hidden', 'NotAllowedError'))
    setVisibility('hidden')
    setRows({ status: 'uploading' })
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    await Promise.resolve()

    setVisibility('visible')
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
  })

  // ------------------------------------------------------------ one lock, no extra work

  it('requests the lock only once while several rows move', async () => {
    setRows({ status: 'uploading' })
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))

    useUploadStore.setState((s) => ({ files: [...s.files, row({ id: 'r2', status: 'starting' })] }))
    await Promise.resolve()
    expect(request).toHaveBeenCalledTimes(1)
  })

  // Several files can take their turn in the same tick (up to three), so there
  // are several rows starting before the first request has resolved.
  it('requests a single sentinel when several rows start in the same tick', async () => {
    const acquired: ReturnType<typeof makeSentinel>[] = []
    request.mockImplementation(async () => {
      const next = makeSentinel()
      acquired.push(next)
      return next
    })

    setRows({ status: 'starting' })
    patch('r1', { status: 'uploading' })
    useUploadStore.setState((s) => ({ files: [...s.files, row({ id: 'r2', status: 'starting' })] }))
    useUploadStore.setState((s) => ({ files: [...s.files, row({ id: 'r3', status: 'starting' })] }))
    await vi.waitFor(() => expect(request).toHaveBeenCalled())

    expect(request).toHaveBeenCalledTimes(1)

    useUploadStore.setState({ files: [] })
    const stillHeld = acquired.filter((s) => s.release.mock.calls.length === 0)
    expect(stillHeld).toHaveLength(0)
  })

  it('does nothing on a progress tick', async () => {
    // The lock is refused, so nothing is held and a tick that asked again would
    // show: each of these writes changes the row, none changes whether it moves.
    request.mockRejectedValue(new DOMException('denied', 'NotAllowedError'))
    setRows({ status: 'uploading' })
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    await Promise.resolve()

    for (let progress = 1; progress <= 5; progress++) patch('r1', { progress })
    await Promise.resolve()
    expect(request).toHaveBeenCalledTimes(1)

    // Nor does a write that changes a row that is not moving.
    patch('r1', { status: 'processing' })
    for (let progress = 1; progress <= 5; progress++) patch('r1', { processingProgress: progress })
    expect(request).toHaveBeenCalledTimes(1)
    expect(sentinel.release).not.toHaveBeenCalled()
  })

  // ------------------------------------------------------------ best effort

  it('is a no-op when the browser has no Wake Lock API', () => {
    Reflect.deleteProperty(navigator as object, 'wakeLock')
    expect(() => {
      setRows({ status: 'uploading' })
      patch('r1', { status: 'processing' })
    }).not.toThrow()
  })

  it('does not fail the upload when the lock is refused', async () => {
    request.mockRejectedValue(new DOMException('denied', 'NotAllowedError'))
    expect(() => setRows({ status: 'starting' })).not.toThrow()
    await vi.waitFor(() => expect(request).toHaveBeenCalled())
    await Promise.resolve()

    // The row is as the run left it; no lock is not an error on it.
    expect(useUploadStore.getState().files[0]).toMatchObject({ status: 'starting' })
    expect(useUploadStore.getState().files[0].error).toBeUndefined()
    expect(() => patch('r1', { status: 'processing' })).not.toThrow()
  })

  it('releases a lock that arrives after the last row stopped moving', async () => {
    let handOver: (s: unknown) => void = () => {}
    request.mockImplementation(() => new Promise((resolve) => { handOver = resolve }))

    setRows({ status: 'starting' }) // the request is in flight
    patch('r1', { status: 'failed' }) // a short upload ends before it resolves
    handOver(sentinel) // only now does the browser hand the sentinel over

    await vi.waitFor(() => expect(sentinel.release).toHaveBeenCalled())
  })

  it('keeps a lock that arrives after the rows stopped and started moving again', async () => {
    let handOver: (s: unknown) => void = () => {}
    request.mockImplementation(() => new Promise((resolve) => { handOver = resolve }))

    setRows({ status: 'starting' })
    patch('r1', { status: 'queued', holdReason: 'connection' })
    patch('r1', { status: 'starting', holdReason: undefined })
    handOver(sentinel)
    await Promise.resolve()
    await Promise.resolve()

    expect(request).toHaveBeenCalledTimes(1)
    expect(sentinel.release).not.toHaveBeenCalled()
  })
})
