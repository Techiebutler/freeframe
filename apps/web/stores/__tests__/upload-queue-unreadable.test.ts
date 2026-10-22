/**
 * A file that changed or moved after it was added (spec goal 5, "Readability probe").
 *
 * In WebKit, a `File` touched, rewritten, moved or deleted on disk after it was
 * picked makes `xhr.send(file.slice(...))` hang with no event at all, while
 * `file.slice(0, 1).arrayBuffer()` rejects within milliseconds. So the store
 * reads one byte at the file's turn, before it asks the server for anything,
 * and before every retry of a part. A file that fails the read fails visibly,
 * for good, and the queue goes on.
 *
 * The API is mocked but `ApiError` is the real one, so a refusal and a hold
 * reach the classification as they would in the browser.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  api: { post: vi.fn(), get: vi.fn(), patch: vi.fn() },
}))
vi.mock('swr', () => ({ mutate: vi.fn() }))

import { api } from '@/lib/api'
import { useUploadStore, uploadAllParts, __uploadQueueTesting as testing } from '../upload-store'
import { createPartBudget, type PartBudget } from '@/lib/upload-budget'
import { FileUnreadableError } from '@/lib/upload-readable'
import { signInAs, row } from '@/test/upload-session'
import { installXhrFake, ok, fail } from '@/test/xhr-fake'
import {
  MB, fakeServer, fileOf, small, drop, rowOf, files, stored, settle, flush, resumable,
} from '@/test/upload-queue-server'

const UNREADABLE = 'The file changed or was moved after it was added. Add it again.'
const READ_FAILED = 'This file could not be read.'

/**
 * Lets a test decide what reading the file does from now on. The probe is
 * `file.slice(0, 1).arrayBuffer()`, so that is what changes: readable (the
 * real file), gone (it rejects the way a moved file does), or gated (it waits
 * for the test, so something can happen while the read is out). `onRead` hears
 * each probe, which is the one read of the first byte.
 */
function watched(file: File, onRead: () => void = () => {}) {
  const real = file.slice.bind(file) as Blob['slice']
  let mode: 'readable' | 'gone' | 'gated' = 'readable'
  let reason = 'NotFoundError'
  let said = 'gone'
  const gate: Array<{ pass: () => void; fail: () => void }> = []
  Object.defineProperty(file, 'slice', {
    value: (start?: number, end?: number, type?: string) => {
      if (start === 0 && end === 1) onRead()
      if (mode === 'readable') return real(start, end, type)
      return {
        arrayBuffer: () => {
          if (mode === 'gone') return Promise.reject(new DOMException(said, reason))
          return new Promise<ArrayBuffer>((resolve, reject) => {
            gate.push({
              pass: () => resolve(new ArrayBuffer(1)),
              fail: () => reject(new DOMException(said, reason)),
            })
          })
        },
      } as unknown as Blob
    },
  })
  return {
    /** From now on the file cannot be read; `message` is the browser's own word for why. */
    gone(name = 'NotFoundError', message = 'gone') {
      mode = 'gone'
      reason = name
      said = message
    },
    /** From now on a read waits for `pass()` or `fail()`. */
    gate(name = 'NotFoundError') {
      mode = 'gated'
      reason = name
    },
    /** From now on the file can be read again. */
    readable() {
      mode = 'readable'
    },
    pass: () => gate.shift()!.pass(),
    fail: () => gate.shift()!.fail(),
    reads: () => gate.length,
  }
}

/** An interrupted upload with everything a resume needs. */
const interrupted = (over: Parameters<typeof row>[0] = {}) =>
  row({
    id: 'r', status: 'interrupted', fileSize: MB,
    assetId: 'ra', versionId: 'rv', uploadId: 'ru', s3Key: 'rk',
    ...over,
  })

/** The presign calls made for one upload, in order. */
const presigns = (calls: string[], uploadId: string) => calls.filter((c) => c === `presign ${uploadId}`)

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.get).mockReset()
  testing.reset()
  // A resume's claim waits for another tab's write still on its way from another process
  // (RESUME_CLAIM_PREFIX). Here every store shares one storage object and sees each write at
  // once, and these cases are about other things: no waiting it out on every resume.
  testing.setClaimSettleMs(0)
  window.localStorage.clear()
  useUploadStore.setState({ files: [], versionsRevision: 0, panelOpen: false })
  signInAs('user-1')
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  testing.reset()
})

describe('a new file whose turn comes', () => {
  it('an unreadable file at its turn fails with no request and the next file starts', async () => {
    const server = fakeServer()
    const a = fileOf('a.mov')
    watched(a).gone('NotReadableError')

    const [idA, idB] = drop([a, small('b.jpg')])
    await settle()

    expect(rowOf(idA)).toMatchObject({
      status: 'failed', failedBeforeStart: true, retryable: false, error: UNREADABLE,
    })
    // Nothing of it reached the server: the only request is the next file's.
    expect(server.calls.filter((c) => c.includes('a.mov'))).toEqual([])
    expect(server.names()).toEqual(['b.jpg'])
    expect(rowOf(idB).status).toBe('processing')

    // The run gave everything back, and Dismiss is all the row offers.
    expect(testing.runningIds()).toEqual([])
    expect(testing.hasAbortController(idA)).toBe(false)
    expect(testing.wakeLockHolders()).toBe(0)
    expect(useUploadStore.getState().canRetry(idA)).toBe(false)
    useUploadStore.getState().retryUpload(idA)
    await settle()
    expect(rowOf(idA).status).toBe('failed')
    expect(server.names()).toEqual(['b.jpg'])
  })

  it('a file that is no longer there counts the same as one that cannot be read', async () => {
    const server = fakeServer()
    const a = small('a.jpg')
    watched(a).gone('NotFoundError')

    const [idA] = drop([a])
    await settle()

    expect(rowOf(idA)).toMatchObject({ status: 'failed', failedBeforeStart: true, retryable: false, error: UNREADABLE })
    expect(server.calls).toEqual([])
  })

  it.each([
    ['says why', 'The operation is insecure.', 'The operation is insecure.'],
    ['says nothing', '', READ_FAILED],
  ])('a read that fails for another reason, where the browser %s, fails the row with Retry and no claim that the file changed', async (_, said, shown) => {
    const server = fakeServer()
    const a = fileOf('a.mov')
    const read = watched(a)
    read.gone('SecurityError', said)

    const [idA, idB] = drop([a, small('b.jpg')])
    await settle()

    expect(rowOf(idA)).toMatchObject({ status: 'failed', failedBeforeStart: true, retryable: true, error: shown })
    expect(server.names()).toEqual(['b.jpg'])
    expect(rowOf(idB).status).toBe('processing')
    expect(useUploadStore.getState().canRetry(idA)).toBe(true)

    // Nothing says the file is gone, so Retry reads it again at its turn.
    read.readable()
    useUploadStore.getState().retryUpload(idA)
    await settle()
    expect(server.names()).toEqual(['b.jpg', 'a.mov'])
    expect(rowOf(idA).status).toBe('processing')
    expect(rowOf(idA).error).toBeUndefined()
  })

  it('cancelling while the file is being read sends nothing, even when the read then passes', async () => {
    const server = fakeServer()
    const a = fileOf('a.mov')
    const read = watched(a)
    read.gate()

    const [idA] = drop([a])
    await settle()
    expect(read.reads()).toBe(1)
    expect(rowOf(idA).status).toBe('starting')

    useUploadStore.getState().cancelUpload(idA)
    read.pass()
    await settle()

    expect(server.calls).toEqual([])
    expect(files().find((f) => f.id === idA)).toBeUndefined()
    expect(testing.runningIds()).toEqual([])
  })

  it('cancelling while the file is being read leaves the row cancelled, not failed, when the read then fails', async () => {
    const server = fakeServer()
    const a = fileOf('a.mov')
    const read = watched(a)
    read.gate()

    const [idA] = drop([a, small('b.jpg')])
    await settle()
    useUploadStore.getState().cancelUpload(idA)
    read.fail()
    await settle()

    expect(files().find((f) => f.id === idA)).toBeUndefined()
    expect(server.names()).toEqual(['b.jpg'])
  })

  it('the file that holds the queue while it waits for the connection fails and passes the hold on', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const server = fakeServer((_, i) => (i === 0 ? new TypeError('Failed to fetch') : 'wait'))
    const a = fileOf('a.mov')
    const read = watched(a)

    const [idA, idB] = drop([a, fileOf('b.mov')])
    await flush()
    expect(rowOf(idA)).toMatchObject({ status: 'queued', holdReason: 'connection' })
    expect(rowOf(idB).holdReason).toBeUndefined()

    // The file is touched while the queue waits on the connection. Its next
    // try is the probe's, and the probe fails before it asks anything.
    read.gone()
    await vi.advanceTimersByTimeAsync(2_000)
    await flush()
    expect(rowOf(idA)).toMatchObject({ status: 'failed', failedBeforeStart: true, retryable: false, error: UNREADABLE })
    expect(server.names()).toEqual(['a.mov'])

    // The hold is still on, and the next file is its probe: it alone tries.
    expect(rowOf(idB)).toMatchObject({ status: 'queued', holdReason: 'connection' })
    await vi.advanceTimersByTimeAsync(2_000)
    await flush()
    expect(server.names()).toEqual(['a.mov', 'b.mov'])
  })

  it.each([
    ['says why', 'The operation is insecure.', 'The operation is insecure.'],
    ['says nothing', '', READ_FAILED],
  ])('a read that fails for another reason, where the browser %s, on the file that holds the queue passes the hold on', async (_, said, shown) => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const server = fakeServer((_body, i) => (i === 0 ? new TypeError('Failed to fetch') : 'wait'))
    const a = fileOf('a.mov')
    const read = watched(a)

    const [idA, idB] = drop([a, fileOf('b.mov')])
    await flush()
    expect(rowOf(idA)).toMatchObject({ status: 'queued', holdReason: 'connection' })

    read.gone('SecurityError', said)
    await vi.advanceTimersByTimeAsync(2_000)
    await flush()
    expect(rowOf(idA)).toMatchObject({ status: 'failed', failedBeforeStart: true, retryable: true, error: shown })
    expect(server.names()).toEqual(['a.mov'])

    // Not stuck on a probe that will never try: the next file is the probe now.
    expect(rowOf(idB)).toMatchObject({ status: 'queued', holdReason: 'connection' })
    await vi.advanceTimersByTimeAsync(2_000)
    await flush()
    expect(server.names()).toEqual(['a.mov', 'b.mov'])
  })

  it('cancelling the file that holds the queue while it is read passes the hold on', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const server = fakeServer((_, i) => (i === 0 ? new TypeError('Failed to fetch') : 'wait'))
    const a = fileOf('a.mov')
    const read = watched(a)

    const [idA, idB] = drop([a, fileOf('b.mov')])
    await flush()
    expect(rowOf(idA).holdReason).toBe('connection')

    // The probe's next try is reading the file when the user cancels it.
    read.gate()
    await vi.advanceTimersByTimeAsync(2_000)
    await flush()
    expect(read.reads()).toBe(1)
    useUploadStore.getState().cancelUpload(idA)
    read.pass()
    await flush()
    expect(server.names()).toEqual(['a.mov'])

    // Not stuck on a probe that will never try: the next file is the probe now.
    expect(rowOf(idB)).toMatchObject({ status: 'queued', holdReason: 'connection' })
    await vi.advanceTimersByTimeAsync(2_000)
    await flush()
    expect(server.names()).toEqual(['a.mov', 'b.mov'])
  })

  it('the only file waiting for the connection fails and ends the hold, so a later drop starts', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const server = fakeServer((_, i) => (i === 0 ? new TypeError('Failed to fetch') : 'answer'))
    const a = fileOf('a.mov')
    const read = watched(a)

    const [idA] = drop([a])
    await flush()
    expect(rowOf(idA).holdReason).toBe('connection')

    read.gone()
    await vi.advanceTimersByTimeAsync(2_000)
    await flush()
    expect(rowOf(idA)).toMatchObject({ status: 'failed', error: UNREADABLE })

    drop([small('c.jpg')])
    await flush()
    expect(server.names()).toEqual(['a.mov', 'c.jpg'])
  })
})

describe('a part that is tried again', () => {
  it('a file that becomes unreadable mid-upload ends interrupted and the queue continues', async () => {
    vi.useFakeTimers()
    const server = fakeServer()
    const a = fileOf('a.mov')
    const read = watched(a)
    // Every part of A fails once, and the file is touched as that happens.
    // B's parts go through.
    installXhrFake((url) => {
      if (url.includes('/u1/')) {
        read.gone('NotReadableError')
        return fail(503)
      }
      return ok('"e"')
    })

    const [idA, idB] = drop([a, small('b.jpg')])
    await flush()
    // A's five parts are in backoff and still count against the budget, so B waits.
    expect(rowOf(idA).status).toBe('uploading')
    expect(presigns(server.calls, 'u1')).toHaveLength(5)
    expect(server.names()).toEqual(['a.mov'])

    await vi.advanceTimersByTimeAsync(3_000)
    await flush()

    // A has ids, so it can be resumed by picking the file again.
    expect(rowOf(idA)).toMatchObject({
      status: 'interrupted', error: UNREADABLE, uploadId: 'u1', versionId: 'v1', s3Key: 'k1',
    })
    // No retry reached the server: the probe came before the presign. And
    // nothing was aborted, since the parts already sent are what a resume keeps.
    expect(presigns(server.calls, 'u1')).toHaveLength(5)
    expect(server.calls).not.toContain('abort u1')
    expect(server.calls).not.toContain('complete u1')

    // A's run is over, its slots are free, and B went through to the end.
    expect(testing.runningIds()).not.toContain(idA)
    expect(testing.hasAbortController(idA)).toBe(false)
    expect(server.names()).toEqual(['a.mov', 'b.jpg'])
    expect(rowOf(idB).status).toBe('processing')
    expect(useUploadStore.getState().canResume(idA)).toBe(true)
  })

  it('reads once the retry holds its slot and before it asks for a URL, then gives the slot back', async () => {
    vi.useFakeTimers()
    // Every call the part makes on the budget, the presign and the read, in order.
    const events: string[] = []
    const real = createPartBudget(1)
    const budget: PartBudget = {
      size: real.size,
      acquire: async (key, signal, kind) => {
        events.push(`acquire ${kind}`)
        const release = await real.acquire(key, signal, kind)
        events.push(`granted ${kind}`)
        return () => {
          events.push(`release ${kind}`)
          release()
        }
      },
      sleeping: (key) => {
        events.push('sleeping')
        real.sleeping(key)
      },
      woke: (key) => {
        events.push('woke')
        real.woke(key)
      },
      setRank: real.setRank,
      forget: (key) => {
        events.push('forget')
        real.forget(key)
      },
    }
    vi.mocked(api.post).mockImplementation((() => {
      events.push('presign')
      return Promise.resolve({ presigned_url: 'https://s3.test/x/1' })
    }) as never)

    const file = fileOf('a.mov', 10 * MB)
    const read = watched(file, () => events.push('read'))
    installXhrFake(() => {
      read.gone()
      return fail(503)
    })

    const ended = uploadAllParts(file, 'k', 'u', new AbortController(), () => {}, {
      budget, fileKey: 'f:1',
    }).catch((err: unknown) => err)
    await vi.advanceTimersByTimeAsync(3_000)
    const err = await ended

    expect(err).toBeInstanceOf(FileUnreadableError)
    expect(events).toEqual([
      'acquire fresh', 'granted fresh', 'presign',
      // The part backs off: asleep before the slot is free, awake and asking again with nothing between.
      'sleeping', 'release fresh', 'woke', 'acquire retry', 'granted retry',
      // Slot in hand, nothing asked of the server yet: the read, and the slot goes back.
      'read', 'release retry',
      'forget',
    ])
  })

  it('a file that is still readable is retried as before, and read once at its turn and once for the retry', async () => {
    vi.useFakeTimers()
    const server = fakeServer()
    let puts = 0
    installXhrFake(() => (++puts === 1 ? fail(503) : ok('"e"')))
    const a = small('a.jpg')
    const probes = vi.spyOn(a, 'slice')

    const [id] = drop([a])
    await flush()
    expect(rowOf(id).status).toBe('uploading')

    await vi.advanceTimersByTimeAsync(3_000)
    await flush()

    // The first attempt of a part is not read: a hang there is the watchdog's.
    expect(probes.mock.calls.filter(([start, end]) => start === 0 && end === 1)).toHaveLength(2)
    expect(puts).toBe(2)
    expect(presigns(server.calls, 'u1')).toHaveLength(2)
    expect(rowOf(id).status).toBe('processing')
    expect(rowOf(id).error).toBeUndefined()
  })
})

describe('a queued resume whose turn comes', () => {
  // The file is read after `/parts` has answered, and only for an upload that
  // still takes parts: `/parts` creates nothing, and an upload whose object is
  // whole needs no bytes from the file.

  it('an unreadable file ends the resume interrupted with the reason before any part is sent, and can be picked again', async () => {
    const server = fakeServer()
    vi.mocked(api.get).mockResolvedValue(resumable() as never)
    useUploadStore.setState({ files: [interrupted()] })
    const clip = small('clip.mp4')
    watched(clip).gone()

    useUploadStore.getState().resumeUpload('r', clip)
    await settle()

    expect(api.get).toHaveBeenCalledTimes(1)
    expect(rowOf('r')).toMatchObject({
      status: 'interrupted', error: UNREADABLE, versionId: 'rv', uploadId: 'ru', s3Key: 'rk',
    })
    expect(rowOf('r').resuming).toBeUndefined()
    expect(rowOf('r').queuedResume).toBeUndefined()
    // No presign, no abort, no completion: what the server holds stays for the next Resume.
    expect(server.calls).toEqual([])
    expect(testing.runningIds()).toEqual([])
    expect(testing.hasAbortController('r')).toBe(false)

    // The fresh file the user picks resumes it.
    expect(useUploadStore.getState().canResume('r')).toBe(true)
    useUploadStore.getState().resumeUpload('r', small('clip.mp4'))
    await settle()
    expect(api.get).toHaveBeenCalledTimes(2)
    expect(rowOf('r').status).toBe('processing')
    expect(rowOf('r').error).toBeUndefined()
  })

  it('an assembled upload completes whatever the picked file is', async () => {
    const server = fakeServer()
    vi.mocked(api.get).mockResolvedValue(resumable({ state: 'assembled' }) as never)
    useUploadStore.setState({ files: [interrupted()] })
    const clip = small('clip.mp4')
    const read = watched(clip, () => {})
    read.gone()

    useUploadStore.getState().resumeUpload('r', clip)
    await settle()

    expect(server.calls).toEqual(['complete ru'])
    expect(rowOf('r').status).toBe('processing')
    expect(rowOf('r').error).toBeUndefined()
  })

  it.each([
    ['says why', 'The operation is insecure.', 'The operation is insecure.'],
    ['says nothing', '', READ_FAILED],
  ])('a read that fails for another reason, where the browser %s, ends the resume interrupted without claiming the file changed', async (_, said, shown) => {
    const server = fakeServer()
    vi.mocked(api.get).mockResolvedValue(resumable() as never)
    useUploadStore.setState({ files: [interrupted()] })
    const clip = small('clip.mp4')
    watched(clip).gone('SecurityError', said)

    useUploadStore.getState().resumeUpload('r', clip)
    await settle()

    expect(rowOf('r')).toMatchObject({ status: 'interrupted', error: shown, uploadId: 'ru' })
    expect(server.calls).toEqual([])
    expect(testing.runningIds()).toEqual([])
  })

  it('cancelling while the file is read stands, and discards what the server holds', async () => {
    const server = fakeServer()
    vi.mocked(api.get).mockResolvedValue(resumable() as never)
    useUploadStore.setState({ files: [interrupted()] })
    const clip = small('clip.mp4')
    const read = watched(clip)
    read.gate()

    useUploadStore.getState().resumeUpload('r', clip)
    await settle()
    expect(read.reads()).toBe(1)
    useUploadStore.getState().cancelUpload('r')
    read.fail()
    await settle()

    expect(rowOf('r').status).toBe('cancelled')
    expect(rowOf('r').error).toBeUndefined()
    expect(server.calls).toEqual(['abort ru'])
    expect(testing.runningIds()).toEqual([])
  })

  it('the queue goes on past it', async () => {
    const server = fakeServer()
    vi.mocked(api.get).mockResolvedValue(resumable() as never)
    useUploadStore.setState({ files: [interrupted()] })
    const clip = small('clip.mp4')
    watched(clip).gone('NotReadableError')

    useUploadStore.getState().resumeUpload('r', clip)
    drop([small('b.jpg')])
    await settle()

    expect(rowOf('r')).toMatchObject({ status: 'interrupted', error: UNREADABLE })
    expect(server.names()).toEqual(['b.jpg'])
  })

  it('a file that becomes unreadable while the missing parts are sent ends interrupted with the reason', async () => {
    vi.useFakeTimers()
    const server = fakeServer()
    vi.mocked(api.get).mockResolvedValue(resumable({ file_size_bytes: 50 * MB }) as never)
    useUploadStore.setState({ files: [interrupted({ fileSize: 50 * MB })] })
    const clip = fileOf('clip.mp4', 50 * MB, 'video/mp4')
    const read = watched(clip)
    installXhrFake(() => {
      read.gone('NotReadableError')
      return fail(503)
    })

    useUploadStore.getState().resumeUpload('r', clip)
    await flush()
    expect(rowOf('r')).toMatchObject({ status: 'uploading' })
    expect(presigns(server.calls, 'ru')).toHaveLength(5)

    await vi.advanceTimersByTimeAsync(3_000)
    await flush()

    expect(rowOf('r')).toMatchObject({ status: 'interrupted', error: UNREADABLE, versionId: 'rv', uploadId: 'ru' })
    expect(presigns(server.calls, 'ru')).toHaveLength(5)
    expect(server.calls.filter((c) => c.startsWith('abort'))).toEqual([])
    expect(testing.runningIds()).toEqual([])
    expect(useUploadStore.getState().canResume('r')).toBe(true)
  })

  it.each([
    ['a file that changed or moved', 'NotFoundError', 'gone', UNREADABLE],
    ['a read that fails for another reason', 'SecurityError', '', READ_FAILED],
  ])('the held resume whose /parts then answers and finds %s ends the hold, so the next file starts', async (_, name, said, shown) => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const server = fakeServer()
    vi.mocked(api.get)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue(resumable() as never)
    useUploadStore.setState({ files: [interrupted()] })
    const clip = small('clip.mp4')
    const read = watched(clip)
    read.gone(name, said)

    useUploadStore.getState().resumeUpload('r', clip)
    await flush()
    expect(rowOf('r')).toMatchObject({ status: 'interrupted', queuedResume: true, holdReason: 'connection' })
    drop([small('s.jpg')])
    await flush()
    expect(server.names()).toEqual([])

    // The probe's next try gets `/parts` through, which ends the hold; only then is the file read.
    await vi.advanceTimersByTimeAsync(2_000)
    await flush()

    expect(rowOf('r')).toMatchObject({ status: 'interrupted', error: shown, uploadId: 'ru' })
    expect(rowOf('r').queuedResume).toBeUndefined()
    expect(rowOf('r').holdReason).toBeUndefined()
    expect(server.names()).toEqual(['s.jpg'])
    expect(stored().find((f) => f.id === 'r')).toMatchObject({ status: 'interrupted', uploadId: 'ru' })
  })
})
