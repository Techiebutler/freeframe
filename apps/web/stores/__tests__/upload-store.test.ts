import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// The real `ApiError`: a failed presign is classified by it.
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  api: {
    post: vi.fn(),
    get: vi.fn(),
  },
}))

import { api } from '@/lib/api'
import { uploadAllParts, PartStalledError, __uploadQueueTesting } from '../upload-store'
import { installXhrFake, ok, fail, type FakeXhr, type PartHandler } from '@/test/xhr-fake'
import { createPartBudget, type PartBudget } from '@/lib/upload-budget'

const CHUNK_SIZE = 10 * 1024 * 1024
/** Mirrors the store's first backoff rung. */
const PART_RETRY_BASE_MS = 2000

/**
 * A budget of `n` slots that only this upload uses, which is what the old
 * `concurrency` argument was. The store passes its tab-wide one instead.
 */
const slots = (n = 5) => ({ budget: createPartBudget(n), fileKey: 'f' })

/** Builds a File of `bytes` length; 15 MB spans two 10 MB parts. */
function makeFile(bytes: number): File {
  return new File([new Uint8Array(bytes)], 'clip.mp4', { type: 'video/mp4' })
}

/** Plays the storage backend for every part PUT; returns the handler to assert on. */
function mockPut(handler?: PartHandler) {
  const put = handler ? vi.fn(handler) : vi.fn<PartHandler>()
  installXhrFake(put)
  return put
}

/**
 * Presigns to a URL that names the part, so a PUT mock can tell parts apart.
 *
 * Keying a mock off call order instead only works while uploads are sequential:
 * once parts are in flight together, call order is decided by scheduling, and a
 * mock that hands out responses positionally will happily bind part 2's ETag to
 * part 1 without any test noticing.
 */
function mockPresignPerPart() {
  vi.mocked(api.post).mockImplementation((_path: string, body: unknown) =>
    Promise.resolve({
      presigned_url: `https://s3.example/part-${(body as { part_number: number }).part_number}`,
    }) as never,
  )
}

/** The part number `mockPresignPerPart` encoded into a presigned URL. */
function partOf(url: string): number {
  return Number(url.split('-').pop())
}

// The part watchdog reads when any part of the tab last moved, which outlives
// a test; each test starts from a tab that has heard nothing.
beforeEach(() => {
  __uploadQueueTesting.reset()
})

describe('uploadAllParts', () => {
  let controller: AbortController

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    controller = new AbortController()
    // Every attempt fetches its own presigned URL.
    vi.mocked(api.post).mockResolvedValue({ presigned_url: 'https://s3.example/part' })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('binds each ETag to its own part even when the later part finishes first', async () => {
    mockPresignPerPart()
    // Part 1 lands after part 2. An implementation that appended results in
    // completion order, or a mock that served them positionally, would tie
    // "etag-2" to part 1 here and CompleteMultipartUpload would reject the
    // whole upload with InvalidPart after every byte had already moved.
    const completionOrder: number[] = []
    mockPut(async (url: string) => {
      const part = partOf(url)
      await new Promise((resolve) => setTimeout(resolve, part === 1 ? 50 : 5))
      completionOrder.push(part)
      return ok(`"etag-${part}"`)
    })

    const onProgress = vi.fn()
    const promise = uploadAllParts(makeFile(CHUNK_SIZE + 5_000_000), 'key', 'upload-1', controller, onProgress, slots())
    await vi.runAllTimersAsync()

    expect(completionOrder).toEqual([2, 1]) // the assertion below is only meaningful if this held
    expect(await promise).toEqual([
      { PartNumber: 1, ETag: '"etag-1"' },
      { PartNumber: 2, ETag: '"etag-2"' },
    ])
    expect(onProgress).toHaveBeenLastCalledWith(95)
  })

  it('keeps several parts in flight and still returns them in order', async () => {
    mockPresignPerPart()

    let inFlight = 0
    let maxInFlight = 0
    const completionOrder: number[] = []
    mockPut(async (url: string) => {
      const part = partOf(url)
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      // Deliberately reversed: the last part is quickest, so parts complete in
      // the opposite order to the one they must be returned in. A uniform delay
      // would let an append-on-completion implementation pass.
      await new Promise((resolve) => setTimeout(resolve, (4 - part) * 10))
      inFlight -= 1
      completionOrder.push(part)
      return ok(`"etag-${part}"`)
    })

    // 3 parts, 3 workers — all three should be in flight simultaneously.
    const promise = uploadAllParts(makeFile(2 * CHUNK_SIZE + 1000), 'key', 'upload-1', controller, vi.fn(), slots(3))
    await vi.runAllTimersAsync()
    const parts = await promise

    expect(maxInFlight).toBe(3)
    expect(completionOrder).toEqual([3, 2, 1])
    expect(parts).toEqual([
      { PartNumber: 1, ETag: '"etag-1"' },
      { PartNumber: 2, ETag: '"etag-2"' },
      { PartNumber: 3, ETag: '"etag-3"' },
    ])
  })

  it('stops the other workers as soon as a part fails for good', async () => {
    mockPresignPerPart()
    // Part 1 is rejected permanently on its first attempt. Parts 2 and 3 would
    // otherwise climb the full 8-attempt ladder — about 254s of backoff — before
    // the pool drained and the user was told the upload had already failed.
    const put = mockPut(async (url: string) => {
      if (partOf(url) === 1) return fail(403, 'Forbidden')
      await new Promise((resolve) => setTimeout(resolve, 10))
      return fail(503)
    })

    const promise = uploadAllParts(makeFile(2 * CHUNK_SIZE + 1000), 'key', 'upload-1', controller, vi.fn(), slots(3))
    const settled = promise.then(() => 'resolved').catch((err: Error) => err.message)
    await vi.advanceTimersByTimeAsync(PART_RETRY_BASE_MS)
    await vi.runAllTimersAsync()

    expect(await settled).toContain('Part 1 failed')
    // One PUT per part, plus at most one more per sibling already in flight —
    // nowhere near the 3 + 8 + 8 a full ladder would produce.
    expect(put.mock.calls.length).toBeLessThanOrEqual(6)
  })

  it('never exceeds the configured concurrency', async () => {
    vi.mocked(api.post).mockImplementation((_path: string, body: unknown) =>
      Promise.resolve({ presigned_url: `https://s3.example/part-${(body as { part_number: number }).part_number}` }) as never,
    )

    let inFlight = 0
    let maxInFlight = 0
    mockPut(async (url: string) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 10))
      inFlight -= 1
      return ok(`"etag-${url.split('-').pop()}"`)
    })

    // 5 parts, but only 2 workers.
    const promise = uploadAllParts(makeFile(4 * CHUNK_SIZE + 1000), 'key', 'upload-1', controller, vi.fn(), slots(2))
    await vi.runAllTimersAsync()
    const parts = await promise

    expect(maxInFlight).toBe(2)
    expect(parts.map((p) => p.PartNumber)).toEqual([1, 2, 3, 4, 5])
  })

  it('retries a part that fails transiently and still succeeds', async () => {
    const put = mockPut()
    put
      .mockResolvedValueOnce(fail())
      .mockResolvedValueOnce(fail())
      .mockResolvedValueOnce(ok('"etag-1"'))

    const promise = uploadAllParts(makeFile(1024), 'key', 'upload-1', controller, vi.fn(), slots())
    await vi.runAllTimersAsync()

    expect(await promise).toEqual([{ PartNumber: 1, ETag: '"etag-1"' }])
    expect(put).toHaveBeenCalledTimes(3)
  })

  it('re-fetches the presigned URL on every attempt, since it can expire mid-backoff', async () => {
    const put = mockPut()
    put
      .mockResolvedValueOnce(fail())
      .mockResolvedValueOnce(ok('"etag-1"'))

    const promise = uploadAllParts(makeFile(1024), 'key', 'upload-1', controller, vi.fn(), slots())
    await vi.runAllTimersAsync()
    await promise

    const presignCalls = vi.mocked(api.post).mock.calls.filter((c) => c[0] === '/upload/presign-part')
    expect(presignCalls).toHaveLength(2)
  })

  it('gives up after the attempt limit and surfaces the last error', async () => {
    const put = mockPut()
    put.mockResolvedValue(fail(500, 'Internal Server Error'))

    const promise = uploadAllParts(makeFile(1024), 'key', 'upload-1', controller, vi.fn(), slots())
    const assertion = expect(promise).rejects.toThrow(/Part 1 failed/)
    await vi.runAllTimersAsync()
    await assertion

    expect(put).toHaveBeenCalledTimes(8)
  })

  it('does not retry a 4xx, which would fail identically every time', async () => {
    const put = mockPut()
    put.mockResolvedValue(fail(403, 'Forbidden'))

    const promise = uploadAllParts(makeFile(1024), 'key', 'upload-1', controller, vi.fn(), slots())
    const assertion = expect(promise).rejects.toThrow(/Forbidden/)
    await vi.runAllTimersAsync()
    await assertion

    expect(put).toHaveBeenCalledTimes(1)
  })

  it('does retry a 429, which explicitly invites a later attempt', async () => {
    const put = mockPut()
    put
      .mockResolvedValueOnce(fail(429, 'Too Many Requests'))
      .mockResolvedValueOnce(ok('"etag-1"'))

    const promise = uploadAllParts(makeFile(1024), 'key', 'upload-1', controller, vi.fn(), slots())
    await vi.runAllTimersAsync()

    expect(await promise).toEqual([{ PartNumber: 1, ETag: '"etag-1"' }])
    expect(put).toHaveBeenCalledTimes(2)
  })

  it('wakes a part waiting on backoff as soon as a sibling fails for good', async () => {
    mockPresignPerPart()
    // Part 2 fails transiently and settles into its first 2s backoff. Part 1
    // then fails permanently at t=100ms. Part 2 has no reason to serve out the
    // rest of that sleep: the upload it belongs to is already lost.
    mockPut(async (url: string) => {
      if (partOf(url) === 2) return fail(503)
      await new Promise((resolve) => setTimeout(resolve, 100))
      return fail(403, 'Forbidden')
    })

    let settled = false
    const promise = uploadAllParts(makeFile(CHUNK_SIZE + 1000), 'key', 'upload-1', controller, vi.fn(), slots(2))
    promise.catch(() => { settled = true })

    // Well past part 1's failure, and well short of part 2's 2s+jitter rung.
    await vi.advanceTimersByTimeAsync(500)
    expect(settled).toBe(true)

    await expect(promise).rejects.toThrow(/Part 1 failed/)
  })

  it('does not retry once the upload was cancelled', async () => {
    // Cancelled while the part is on the wire: the request is aborted, and the
    // abort is not mistaken for a network error worth another attempt.
    const put = mockPut(() => {
      controller.abort()
      return new Promise(() => {})
    })

    const promise = uploadAllParts(makeFile(1024), 'key', 'upload-1', controller, vi.fn(), slots())
    const assertion = expect(promise).rejects.toThrow(/cancelled/)
    await vi.runAllTimersAsync()
    await assertion

    expect(put).toHaveBeenCalledTimes(1)
  })

  it('throws before any request when cancelled upfront', async () => {
    const put = mockPut()
    controller.abort()

    await expect(
      uploadAllParts(makeFile(1024), 'key', 'upload-1', controller, vi.fn(), slots()),
    ).rejects.toThrow(/cancelled/)

    expect(put).not.toHaveBeenCalled()
  })
})

describe('uploadAllParts progress', () => {
  let controller: AbortController

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    controller = new AbortController()
    mockPresignPerPart()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const percents = (onProgress: ReturnType<typeof vi.fn>) => onProgress.mock.calls.map(([p]) => p as number)

  it('moves while a part is on the wire, not only when it finishes', async () => {
    // The point of #313: one 10 MB part is minutes on a slow uplink, and a bar
    // that counts finished parts stands still for all of them.
    const onProgress = vi.fn()
    let beforeReply: number[] = []
    mockPut(async (_url, request) => {
      request.progress(250)
      request.progress(500)
      request.progress(750)
      beforeReply = percents(onProgress)
      return ok('"etag-1"')
    })

    const promise = uploadAllParts(makeFile(1000), 'key', 'upload-1', controller, onProgress, slots())
    await vi.runAllTimersAsync()
    await promise

    expect(beforeReply).toEqual([24, 48, 71])
    expect(percents(onProgress)).toEqual([24, 48, 71, 95])
  })

  it('reports each whole percent at most once, rising, and never past 95', async () => {
    // Every report is a persisted store write and a re-render of the panel, so
    // hundreds of progress events must not become hundreds of writes.
    const onProgress = vi.fn()
    let events = 0
    mockPut(async (url, request) => {
      const size = request.body!.size
      for (let k = 1; k <= 20; k++) {
        request.progress(Math.round((size * k) / 20))
        events += 1
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
      return ok(`"etag-${partOf(url)}"`)
    })

    // 38 parts, the last one short.
    const promise = uploadAllParts(makeFile(37_500), 'key', 'upload-1', controller, onProgress, {
      ...slots(5),
      chunkSize: 1000,
    })
    await vi.runAllTimersAsync()
    expect(await promise).toHaveLength(38)

    const seen = percents(onProgress)
    expect(events).toBe(38 * 20)
    expect(seen.length).toBeLessThanOrEqual(96)
    expect(seen.length).toBeGreaterThan(38) // finer than one step per part
    seen.forEach((p, i) => {
      if (i > 0) expect(p).toBeGreaterThan(seen[i - 1])
    })
    expect(Math.max(...seen)).toBe(95)
    expect(seen[seen.length - 1]).toBe(95)
  })

  it('drops what a failed attempt sent, and waits rather than going backwards', async () => {
    // Part 1 gets 900 of its 1000 bytes across and fails. While it waits out
    // its backoff, part 2 finishes. Kept, part 1's 900 bytes would show 90%
    // with half the upload done; dropped, the bar says 48% and holds there
    // until the retry has caught up, instead of falling back from 43.
    const onProgress = vi.fn()
    const attempts = new Map<number, number>()
    mockPut(async (url, request) => {
      const part = partOf(url)
      const attempt = (attempts.get(part) ?? 0) + 1
      attempts.set(part, attempt)
      if (part === 1 && attempt === 1) {
        request.progress(900)
        await new Promise((resolve) => setTimeout(resolve, 10))
        return fail(503)
      }
      if (part === 2) await new Promise((resolve) => setTimeout(resolve, 20))
      request.progress(part === 1 ? 500 : 1000)
      await new Promise((resolve) => setTimeout(resolve, 10))
      return ok(`"etag-${part}"`)
    })

    const promise = uploadAllParts(makeFile(2000), 'key', 'upload-1', controller, onProgress, {
      ...slots(2),
      chunkSize: 1000,
    })
    await vi.runAllTimersAsync()
    await promise

    expect(attempts.get(1)).toBe(2)
    expect(percents(onProgress)).toEqual([43, 48, 71, 95])
  })

  it('counts a short last part at its own length when it finishes first', async () => {
    // 2100 bytes in parts of 1000: part 3 is 100 bytes. Finishing first, it is
    // 100 of 2100 bytes, 5%; counted as a whole chunk it would claim 45%.
    const onProgress = vi.fn()
    const release: Array<() => void> = []
    mockPut((url) => {
      const part = partOf(url)
      if (part === 3) return ok('"etag-3"')
      return new Promise((resolve) => release.push(() => resolve(ok(`"etag-${part}"`))))
    })

    const promise = uploadAllParts(makeFile(2100), 'key', 'upload-1', controller, onProgress, {
      ...slots(3),
      chunkSize: 1000,
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(percents(onProgress)).toEqual([5])

    release.forEach((r) => r())
    await vi.runAllTimersAsync()
    await promise
    expect(percents(onProgress)).toEqual([5, 50, 95])
  })

  it('reports nothing for a part that fails before its first progress event', async () => {
    // The row is set to 0 before the upload starts and has just stopped when
    // this fails. A 0 written now would also stamp a fresh heartbeat on it.
    const onProgress = vi.fn()
    mockPut(() => fail(403, 'Forbidden'))

    const promise = uploadAllParts(makeFile(1000), 'key', 'upload-1', controller, onProgress, slots())
    const assertion = expect(promise).rejects.toThrow('Part 1 failed: Forbidden')
    await vi.runAllTimersAsync()
    await assertion

    expect(onProgress).not.toHaveBeenCalled()
  })

  it('never reports more than 95, whatever a progress event claims', async () => {
    // The panel prints the number as it is, so an overcount reads "Uploading 103%".
    const onProgress = vi.fn()
    mockPut((_url, request) => {
      request.progress(5000)
      return ok('"etag-1"')
    })

    const promise = uploadAllParts(makeFile(1000), 'key', 'upload-1', controller, onProgress, slots())
    await vi.runAllTimersAsync()
    await promise

    expect(percents(onProgress)).toEqual([95])
  })
})

describe('the part PUT', () => {
  let controller: AbortController

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    controller = new AbortController()
    mockPresignPerPart()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('sends the part to the presigned URL with no Content-Type', async () => {
    // The presign signs bucket, key, upload id and part number and nothing
    // else. The file is typed, so a slice that carried the type over would
    // make the browser add a header the signature does not cover.
    let request: FakeXhr | undefined
    mockPut((_url, r) => {
      request = r
      return ok('"etag-1"')
    })

    const promise = uploadAllParts(makeFile(CHUNK_SIZE + 1000), 'key', 'upload-1', controller, vi.fn(), slots(1))
    await vi.runAllTimersAsync()
    await promise

    expect(request!.method).toBe('PUT')
    expect(request!.url).toBe('https://s3.example/part-2')
    expect(request!.body!.size).toBe(1000)
    expect(request!.body!.type).toBe('')
    expect(request!.requestHeaders).toEqual({})
  })

  it('sets no timeout and sends no credentials, as the fetch call did not', async () => {
    // A timeout would cut off a 10 MB part that is merely slow, which on the
    // uplinks #313 is about takes minutes; fetch had none. And credentials
    // make the browser refuse the answer from a bucket whose CORS rule allows
    // origin `*`, which is the common way to set one up.
    let request: FakeXhr | undefined
    mockPut((_url, r) => {
      request = r
      return ok('"etag-1"')
    })

    const promise = uploadAllParts(makeFile(1024), 'key', 'upload-1', controller, vi.fn(), slots())
    await vi.runAllTimersAsync()
    await promise

    expect(request!.timeout).toBe(0)
    expect(request!.withCredentials).toBe(false)
  })

  it('retries a network error, as it did a failed fetch', async () => {
    const put = mockPut()
    put
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(ok('"etag-1"'))

    const promise = uploadAllParts(makeFile(1024), 'key', 'upload-1', controller, vi.fn(), slots())
    await vi.runAllTimersAsync()

    expect(await promise).toEqual([{ PartNumber: 1, ETag: '"etag-1"' }])
    expect(put).toHaveBeenCalledTimes(2)
  })

  it('retries a timeout', async () => {
    const put = mockPut()
    put
      .mockImplementationOnce((_url, request) => {
        request.expire()
        return new Promise(() => {})
      })
      .mockResolvedValueOnce(ok('"etag-1"'))

    const promise = uploadAllParts(makeFile(1024), 'key', 'upload-1', controller, vi.fn(), slots())
    await vi.runAllTimersAsync()

    expect(await promise).toEqual([{ PartNumber: 1, ETag: '"etag-1"' }])
    expect(put).toHaveBeenCalledTimes(2)
  })

  it('names a network error in its own words once every attempt has failed', async () => {
    // The browser's own text differs by browser ("Failed to fetch", "Load
    // failed"); the row shows this one instead.
    mockPut(() => Promise.reject(new Error('offline')))

    const promise = uploadAllParts(makeFile(1024), 'key', 'upload-1', controller, vi.fn(), slots())
    const assertion = expect(promise).rejects.toThrow(/^Part 1 failed: network error$/)
    await vi.runAllTimersAsync()
    await assertion
  })

  it('retries an abort the browser started itself, which is not a cancel', async () => {
    // window.stop(), or Stop or Esc on a pending navigation, aborts an
    // in-flight XHR without the signal. fetch rejected with a TypeError there,
    // and the part was retried.
    const put = mockPut()
    put
      .mockImplementationOnce((_url, request) => {
        request.abort()
        return new Promise(() => {})
      })
      .mockResolvedValueOnce(ok('"etag-1"'))

    const promise = uploadAllParts(makeFile(1024), 'key', 'upload-1', controller, vi.fn(), slots())
    await vi.runAllTimersAsync()

    expect(await promise).toEqual([{ PartNumber: 1, ETag: '"etag-1"' }])
    expect(put).toHaveBeenCalledTimes(2)
    expect(put.mock.calls[0][1].aborted).toBe(true)
  })

  it('names an abort the browser started in its own words once every attempt has failed', async () => {
    mockPut((_url, request) => {
      request.abort()
      return new Promise(() => {})
    })

    const promise = uploadAllParts(makeFile(1024), 'key', 'upload-1', controller, vi.fn(), slots())
    const assertion = expect(promise).rejects.toThrow(/^Part 1 failed: aborted$/)
    await vi.runAllTimersAsync()
    await assertion
  })

  it('reads the ETag quietly, and leaves it empty when the bucket does not expose it', async () => {
    // docs/deployment.md allows a bucket whose CORS rule does not expose the
    // ETag. getResponseHeader('ETag') logs "Refused to get unsafe header" for
    // every part there; fetch was silent.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockPut((url) => (partOf(url) === 1 ? { ...ok('"etag-1"'), exposeEtag: false } : ok('"etag-2"')))

    const promise = uploadAllParts(makeFile(CHUNK_SIZE + 1000), 'key', 'upload-1', controller, vi.fn(), slots())
    await vi.runAllTimersAsync()

    expect(await promise).toEqual([
      { PartNumber: 1, ETag: '' },
      { PartNumber: 2, ETag: '"etag-2"' },
    ])
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('does not take a status of 0 for a 4xx', async () => {
    const put = mockPut()
    put
      .mockResolvedValueOnce({ status: 0 })
      .mockResolvedValueOnce(ok('"etag-1"'))

    const promise = uploadAllParts(makeFile(1024), 'key', 'upload-1', controller, vi.fn(), slots())
    await vi.runAllTimersAsync()

    expect(await promise).toEqual([{ PartNumber: 1, ETag: '"etag-1"' }])
    expect(put).toHaveBeenCalledTimes(2)
  })

  it('sends nothing when the cancel lands between presign and PUT', async () => {
    let releasePresign!: () => void
    vi.mocked(api.post).mockImplementation(
      () => new Promise((resolve) => {
        releasePresign = () => resolve({ presigned_url: 'https://s3.example/part-1' } as never)
      }) as never,
    )
    const put = mockPut(() => ok('"etag-1"'))

    const promise = uploadAllParts(makeFile(1024), 'key', 'upload-1', controller, vi.fn(), slots())
    const settled = promise.catch((err: unknown) => err)
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    releasePresign()
    await vi.runAllTimersAsync()

    const err = await settled
    expect(err).toBeInstanceOf(DOMException)
    expect((err as DOMException).name).toBe('AbortError')
    // The part's own error, not the fallback `uploadAllParts` makes up.
    expect((err as DOMException).message).toBe('Part 1 cancelled')
    expect(put).not.toHaveBeenCalled()
  })

  it('aborts a part in flight and rejects with its own AbortError', async () => {
    // The error the part raised is the one that comes out, not the fallback
    // `uploadAllParts` makes up when a cancel lands between parts.
    const requests: FakeXhr[] = []
    mockPut((_url, request) => {
      requests.push(request)
      return new Promise(() => {})
    })

    const promise = uploadAllParts(makeFile(1024), 'key', 'upload-1', controller, vi.fn(), slots())
    const settled = promise.catch((err: unknown) => err)
    await vi.advanceTimersByTimeAsync(0)
    expect(requests).toHaveLength(1)
    controller.abort()
    await vi.runAllTimersAsync()

    const err = await settled
    expect(requests[0].aborted).toBe(true)
    expect(err).toBeInstanceOf(DOMException)
    expect((err as DOMException).name).toBe('AbortError')
    expect((err as DOMException).message).toBe('Part 1 cancelled')
  })

  it('leaves no abort listener behind once the parts have settled', async () => {
    // The pool signal outlives every part, so a listener per request that is
    // not taken off again piles up for the length of the upload.
    const live = new Set<unknown>()
    const add = AbortSignal.prototype.addEventListener
    const remove = AbortSignal.prototype.removeEventListener
    vi.spyOn(AbortSignal.prototype, 'addEventListener').mockImplementation(function (
      this: AbortSignal, type: string, listener: unknown, options?: unknown,
    ) {
      if (type === 'abort') live.add(listener)
      return add.call(this, type, listener as EventListener, options as AddEventListenerOptions)
    })
    vi.spyOn(AbortSignal.prototype, 'removeEventListener').mockImplementation(function (
      this: AbortSignal, type: string, listener: unknown, options?: unknown,
    ) {
      if (type === 'abort') live.delete(listener)
      return remove.call(this, type, listener as EventListener, options as EventListenerOptions)
    })

    // One part succeeds outright, the others after a 503, a network error, a
    // timeout and an abort the browser started itself.
    const attempts = new Map<number, number>()
    mockPut(async (url, request) => {
      const part = partOf(url)
      const attempt = (attempts.get(part) ?? 0) + 1
      attempts.set(part, attempt)
      if (attempt === 1) {
        if (part === 2) return fail(503)
        if (part === 3) throw new Error('offline')
        if (part === 4) {
          request.expire()
          return new Promise(() => {})
        }
        if (part === 5) {
          request.abort()
          return new Promise(() => {})
        }
      }
      return ok(`"etag-${part}"`)
    })

    const promise = uploadAllParts(makeFile(4 * CHUNK_SIZE + 1000), 'key', 'upload-1', controller, vi.fn(), slots(5))
    // Past the first backoff rung and its jitter, and well short of any
    // watchdog, so a watchdog left behind is still pending to be counted.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await promise).toHaveLength(5)

    expect([2, 3, 4, 5].map((part) => attempts.get(part))).toEqual([2, 2, 2, 2])
    expect(live.size).toBe(0)
    // Nor a watchdog: each attempt's clock went with it, however it settled.
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('the part watchdog', () => {
  let controller: AbortController

  /** Mirror the store's watchdog: no progress while bytes remain, and the wait after the last byte. */
  const PART_STALL_MS = 90_000
  const PART_RESPONSE_WAIT_MS = 300_000

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    controller = new AbortController()
    mockPresignPerPart()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  /** A part on the wire that only an abort ends, as a WebKit PUT on a changed file is. */
  const hang = () => new Promise<never>(() => {})

  it('a part with no progress for 90 s is aborted and retried', async () => {
    // In WebKit a part whose file changed on disk hangs with no event at all,
    // so nothing but a clock can say it is stuck. The retry reads the file
    // first (Task 3.1), which is what turns that hang into a clear failure.
    const requests: FakeXhr[] = []
    const put = mockPut()
    put
      .mockImplementationOnce((_url, request) => {
        requests.push(request)
        return hang()
      })
      .mockImplementationOnce((_url, request) => {
        requests.push(request)
        return ok('"etag-1"')
      })

    const promise = uploadAllParts(makeFile(1024), 'key', 'upload-1', controller, vi.fn(), slots())
    await vi.advanceTimersByTimeAsync(PART_STALL_MS - 1)
    expect(requests).toHaveLength(1)
    expect(requests[0].aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    expect(requests[0].aborted).toBe(true)

    await vi.runAllTimersAsync()
    expect(await promise).toEqual([{ PartNumber: 1, ETag: '"etag-1"' }])
    expect(put).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('names a stall, not a cancel, once every attempt has stalled', async () => {
    // The watchdog's own abort must not come out as an AbortError: the caller
    // takes that for a user cancel and discards every part the backend holds.
    const put = mockPut(() => hang())

    const promise = uploadAllParts(makeFile(1024), 'key', 'upload-1', controller, vi.fn(), slots())
    const settled = promise.catch((err: unknown) => err)
    await vi.runAllTimersAsync()

    const err = await settled
    expect(err).toBeInstanceOf(PartStalledError)
    expect(err).not.toBeInstanceOf(DOMException)
    expect((err as Error).message).toBe('Part 1 failed: no progress for 90 s')
    expect(put).toHaveBeenCalledTimes(8)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('progress every 60 s keeps a slow part alive', async () => {
    // A slow but live uplink must never be cut off: any byte that moves resets
    // the clock, however long the part takes in all.
    let request!: FakeXhr
    let answer!: () => void
    const put = mockPut((_url, r) => {
      request = r
      return new Promise((resolve) => {
        answer = () => resolve(ok('"etag-1"'))
      })
    })

    const promise = uploadAllParts(makeFile(1024), 'key', 'upload-1', controller, vi.fn(), slots())
    await vi.advanceTimersByTimeAsync(0)
    for (let k = 1; k <= 10; k++) {
      await vi.advanceTimersByTimeAsync(60_000)
      expect(request.aborted).toBe(false)
      request.progress(k * 100)
    }

    answer()
    await vi.advanceTimersByTimeAsync(0)
    expect(await promise).toEqual([{ PartNumber: 1, ETag: '"etag-1"' }])
    expect(put).toHaveBeenCalledTimes(1)
    expect(request.aborted).toBe(false)
    // The watchdog went with the answer.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a part that sent every byte waits 5 min for its answer, then retries', async () => {
    // Storage, or a proxy that buffers the body, can take a while to answer a
    // 256 MiB part after its last byte, and nothing moves on the upload side
    // meanwhile. The 90 s clock would cut that off; the wait for an answer is
    // longer.
    const requests: FakeXhr[] = []
    const put = mockPut()
    put
      .mockImplementationOnce((_url, request) => {
        requests.push(request)
        request.progress(512)
        request.progress(1024)
        return hang()
      })
      .mockImplementationOnce((_url, request) => {
        requests.push(request)
        return ok('"etag-1"')
      })

    const promise = uploadAllParts(makeFile(1024), 'key', 'upload-1', controller, vi.fn(), slots())
    await vi.advanceTimersByTimeAsync(PART_STALL_MS * 2)
    expect(requests[0].aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(PART_RESPONSE_WAIT_MS - PART_STALL_MS * 2 - 1)
    expect(requests[0].aborted).toBe(false)
    expect(requests).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(requests[0].aborted).toBe(true)

    await vi.runAllTimersAsync()
    expect(await promise).toEqual([{ PartNumber: 1, ETag: '"etag-1"' }])
    expect(put).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('names the wait for an answer once every attempt has run it out', async () => {
    mockPut((_url, request) => {
      request.progress(1024)
      return hang()
    })

    const promise = uploadAllParts(makeFile(1024), 'key', 'upload-1', controller, vi.fn(), slots())
    const settled = promise.catch((err: unknown) => err)
    await vi.runAllTimersAsync()

    const err = await settled
    expect(err).toBeInstanceOf(PartStalledError)
    expect((err as Error).message).toBe('Part 1 failed: no answer 5 min after its last byte')
  })

  it('user cancel during a stall still reports AbortError', async () => {
    const requests: FakeXhr[] = []
    const put = mockPut((_url, request) => {
      requests.push(request)
      return hang()
    })

    const promise = uploadAllParts(makeFile(1024), 'key', 'upload-1', controller, vi.fn(), slots())
    const settled = promise.catch((err: unknown) => err)
    await vi.advanceTimersByTimeAsync(PART_STALL_MS - 30_000)
    controller.abort()
    await vi.advanceTimersByTimeAsync(0)

    const err = await settled
    expect(requests[0].aborted).toBe(true)
    expect(err).toBeInstanceOf(DOMException)
    expect((err as DOMException).name).toBe('AbortError')
    expect((err as DOMException).message).toBe('Part 1 cancelled')
    // The watchdog went with the cancel: nothing fires later, and nothing is retried.
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(PART_RESPONSE_WAIT_MS)
    expect(put).toHaveBeenCalledTimes(1)
  })

  /**
   * Two parts of 1000 bytes in flight together. Each part's first attempt
   * stays on the wire until the test answers it; any later attempt succeeds.
   */
  function twoParts() {
    const first = new Map<number, { request: FakeXhr; answer: () => void }>()
    const put = mockPut((url, request) => {
      const part = partOf(url)
      if (first.has(part)) return ok(`"etag-${part}"`)
      return new Promise((resolve) => {
        first.set(part, { request, answer: () => resolve(ok(`"etag-${part}"`)) })
      })
    })
    const promise = uploadAllParts(makeFile(2000), 'key', 'upload-1', controller, vi.fn(), {
      budget: createPartBudget(2), fileKey: 'f', chunkSize: 1000,
    })
    const part = (n: number) => first.get(n)!
    const attemptsOf = (n: number) => put.mock.calls.filter(([url]) => partOf(url) === n).length
    return { promise, part, attemptsOf }
  }

  it('a part waiting for a socket is not given up on while another part of the tab is moving', async () => {
    // Over HTTP/1.1 a browser holds a request past the sixth to a host until a
    // socket is free, and that request reports no progress meanwhile
    // (measured: about 12.5 s for 24 MiB parts in Chromium and WebKit). The
    // link is busy, not dead, so the waiting part is left alone.
    const { promise, part, attemptsOf } = twoParts()
    await vi.advanceTimersByTimeAsync(0)
    const sending = part(1).request
    const waiting = part(2).request

    for (let t = 1; t <= 8; t++) {
      await vi.advanceTimersByTimeAsync(30_000)
      sending.progress(t * 100)
      // Its first byte at 120 s, past the 90 s a moving part is allowed.
      if (t >= 4) waiting.progress((t - 3) * 100)
    }
    expect(sending.aborted).toBe(false)
    expect(waiting.aborted).toBe(false)

    part(1).answer()
    part(2).answer()
    await vi.advanceTimersByTimeAsync(0)
    expect(await promise).toEqual([
      { PartNumber: 1, ETag: '"etag-1"' },
      { PartNumber: 2, ETag: '"etag-2"' },
    ])
    expect([attemptsOf(1), attemptsOf(2)]).toEqual([1, 1])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a part that has sent nothing is given up on once the whole tab has been silent for 90 s', async () => {
    // The other part moves until 40 s and then stops. The waiting part has
    // not been waiting on a busy link since then, and goes 90 s after it.
    const { promise, part, attemptsOf } = twoParts()
    await vi.advanceTimersByTimeAsync(0)
    const sending = part(1).request
    const waiting = part(2).request

    await vi.advanceTimersByTimeAsync(10_000)
    sending.progress(100)
    await vi.advanceTimersByTimeAsync(30_000)
    sending.progress(200)

    await vi.advanceTimersByTimeAsync(PART_STALL_MS - 1)
    expect(waiting.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    // 130 s: 90 s after the tab's last byte, not 90 s after the send.
    expect(waiting.aborted).toBe(true)

    await vi.runAllTimersAsync()
    expect(await promise).toHaveLength(2)
    expect(attemptsOf(2)).toBe(2)
  })

  it('a part that never starts is given up on at 5 min even while another part keeps moving', async () => {
    // A WebKit PUT of a file that changed on disk hangs with no event at all,
    // whatever its siblings do. The cap ends it, and its retry reads the file.
    const { promise, part, attemptsOf } = twoParts()
    await vi.advanceTimersByTimeAsync(0)
    const sending = part(1).request
    const waiting = part(2).request

    for (let t = 1; t <= 9; t++) {
      await vi.advanceTimersByTimeAsync(30_000)
      sending.progress(t * 50)
    }
    await vi.advanceTimersByTimeAsync(PART_RESPONSE_WAIT_MS - 270_000 - 1)
    expect(waiting.aborted).toBe(false)
    sending.progress(500)
    await vi.advanceTimersByTimeAsync(1)
    expect(waiting.aborted).toBe(true)
    expect(sending.aborted).toBe(false)

    part(1).answer()
    await vi.runAllTimersAsync()
    expect(await promise).toHaveLength(2)
    expect([attemptsOf(1), attemptsOf(2)]).toEqual([1, 2])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a progress event after the part settled leaves no timer behind', async () => {
    // Browsers report upload progress before the answer, but a stray event
    // after it must not arm a watchdog nothing will ever clear.
    let request!: FakeXhr
    mockPut((_url, r) => {
      request = r
      return ok('"etag-1"')
    })

    const promise = uploadAllParts(makeFile(1024), 'key', 'upload-1', controller, vi.fn(), slots())
    await vi.advanceTimersByTimeAsync(0)
    expect(await promise).toEqual([{ PartNumber: 1, ETag: '"etag-1"' }])

    // Straight to the handler: the fake, like a browser, drops it once settled.
    request.upload.onprogress!({ loaded: 512, total: 1024, lengthComputable: true } as ProgressEvent)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a stalled attempt goes to sleep before it gives its slot back', async () => {
    // A stall is a failed attempt like any other, so it keeps the budget's
    // order (see 'a failing attempt goes to sleep before it gives its slot back').
    const inner = createPartBudget(2)
    const log: string[] = []
    const budget: PartBudget = {
      size: inner.size,
      acquire: async (fileKey, signal, kind) => {
        log.push(`acquire ${kind}`)
        const release = await inner.acquire(fileKey, signal, kind)
        return () => {
          log.push('release')
          release()
        }
      },
      sleeping: (fileKey) => {
        log.push('sleeping')
        inner.sleeping(fileKey)
      },
      woke: (fileKey) => {
        log.push('woke')
        inner.woke(fileKey)
      },
      setRank: (fileKey, rank) => inner.setRank(fileKey, rank),
      forget: (fileKey) => {
        log.push('forget')
        inner.forget(fileKey)
      },
    }
    const put = mockPut()
    put.mockImplementationOnce(() => hang()).mockResolvedValueOnce(ok('"etag-1"'))

    const promise = uploadAllParts(makeFile(1000), 'key', 'upload-1', controller, vi.fn(), {
      budget, fileKey: 'f', chunkSize: 1000,
    })
    await vi.runAllTimersAsync()
    await promise

    expect(log).toEqual([
      'acquire fresh', 'sleeping', 'release', 'woke', 'acquire retry', 'release', 'forget',
    ])
  })
})

describe('uploadAllParts and the part budget', () => {
  let controller: AbortController

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    controller = new AbortController()
    mockPresignPerPart()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** The part numbers presigned so far, in the order they were asked for. */
  const presigned = () =>
    vi.mocked(api.post).mock.calls
      .filter(([path]) => path === '/upload/presign-part')
      .map(([, body]) => (body as { part_number: number }).part_number)

  /** Settles later, when the test says so; the part stays on the wire until then. */
  function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((r) => {
      resolve = r
    })
    return { promise, resolve }
  }

  /** How many of `acquires` have been granted so far. */
  function grantCounter(acquires: Array<Promise<() => void>>) {
    const count = { granted: 0, releases: [] as Array<() => void> }
    acquires.forEach((p) =>
      p.then(
        (release) => {
          count.granted += 1
          count.releases.push(release)
        },
        () => {},
      ),
    )
    return count
  }

  it('presign is requested only after a slot is held', async () => {
    const finish: Array<() => void> = []
    mockPut((url) => new Promise((resolve) => finish.push(() => resolve(ok(`"etag-${partOf(url)}"`)))))

    const promise = uploadAllParts(makeFile(2000), 'key', 'upload-1', controller, vi.fn(), {
      budget: createPartBudget(1),
      fileKey: 'f',
      chunkSize: 1000,
    })
    await vi.advanceTimersByTimeAsync(0)
    // Part 2 waits for the slot part 1 holds; it has not asked for a URL that
    // could expire while it waits.
    expect(presigned()).toEqual([1])

    finish[0]()
    await vi.advanceTimersByTimeAsync(0)
    expect(presigned()).toEqual([1, 2])

    finish[1]()
    await vi.runAllTimersAsync()
    expect(await promise).toHaveLength(2)
  })

  it('a part in backoff releases its slot to another file but not to a fresh part of its own file', async () => {
    // Presigned URLs that name the file as well as the part.
    vi.mocked(api.post).mockImplementation((_path: string, body: unknown) => {
      const { s3_key, part_number } = body as { s3_key: string; part_number: number }
      return Promise.resolve({ presigned_url: `https://s3.example/${s3_key}/part-${part_number}` }) as never
    })
    const sent: string[] = []
    const attempts = new Map<string, number>()
    const a2 = deferred<void>()
    mockPut(async (url) => {
      const name = url.slice('https://s3.example/'.length)
      const attempt = (attempts.get(name) ?? 0) + 1
      attempts.set(name, attempt)
      sent.push(`${name}#${attempt}`)
      if (name === 'a/part-1' && attempt === 1) return fail(503)
      if (name === 'a/part-2') await a2.promise
      return ok(`"${name}"`)
    })

    const budget = createPartBudget(2)
    // File a asks first, so it is served first while it may be.
    const a = uploadAllParts(makeFile(3000), 'a', 'upload-a', controller, vi.fn(), {
      budget, fileKey: 'a', chunkSize: 1000,
    })
    const b = uploadAllParts(makeFile(1000), 'b', 'upload-b', new AbortController(), vi.fn(), {
      budget, fileKey: 'b', chunkSize: 1000,
    })

    // Well inside a/part-1's first backoff (2 s and jitter).
    await vi.advanceTimersByTimeAsync(100)
    expect(sent).toEqual(['a/part-1#1', 'a/part-2#1', 'b/part-1#1'])
    await expect(b).resolves.toHaveLength(1)
    // b is done and a slot is free, and still a/part-3 waits: file a has a
    // part asleep, and a fresh part of its own may not take the slot it left.
    await vi.advanceTimersByTimeAsync(100)
    expect(sent).not.toContain('a/part-3#1')

    await vi.advanceTimersByTimeAsync(PART_RETRY_BASE_MS + 300)
    a2.resolve()
    await vi.runAllTimersAsync()
    expect(await a).toHaveLength(3)
    expect(sent).toEqual(['a/part-1#1', 'a/part-2#1', 'b/part-1#1', 'a/part-1#2', 'a/part-3#1'])
  })

  it('with every PUT failing, presign calls stay within budget × 8', async () => {
    // Storage is down. Each part fails and goes to sleep; if the slot it left
    // went to the next part of the same file, that part would fail and sleep
    // too, and within one ladder most of the 500 would be in backoff, each
    // presigning again on every rung.
    const put = mockPut(() => fail(503))
    const file = new File([new Uint8Array(500 * 1024)], 'clip.mp4', { type: 'video/mp4' })

    const promise = uploadAllParts(file, 'key', 'upload-1', controller, vi.fn(), {
      budget: createPartBudget(5),
      fileKey: 'f',
      chunkSize: 1024,
    })
    const assertion = expect(promise).rejects.toThrow(/failed/)
    await vi.runAllTimersAsync()
    await assertion

    // The ladder was climbed (one part made all 8 attempts) ...
    expect(presigned().length).toBeGreaterThanOrEqual(8)
    // ... by no more parts than the budget has slots.
    expect(presigned().length).toBeLessThanOrEqual(5 * 8)
    expect(new Set(presigned()).size).toBeLessThanOrEqual(5)
    expect(put.mock.calls.length).toBeLessThanOrEqual(5 * 8)
  })

  it('aborting releases all slots and rejects waiters', async () => {
    const budget = createPartBudget(2)
    const other = new AbortController()
    // Another file holds one slot from the start.
    const first = grantCounter([budget.acquire('other', other.signal, 'fresh')])
    await vi.advanceTimersByTimeAsync(0)
    expect(first.granted).toBe(1)

    // This upload gets the other slot for part 1, which stays on the wire;
    // parts 2 to 4 wait.
    const put = mockPut(() => new Promise(() => {}))
    let settled = false
    const promise = uploadAllParts(makeFile(4000), 'key', 'upload-1', controller, vi.fn(), {
      budget, fileKey: 'f', chunkSize: 1000,
    })
    const outcome = promise.then(
      () => 'resolved',
      (err: unknown) => err,
    ).finally(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(presigned()).toEqual([1])

    // The other file now wants a second slot, and is ranked ahead of this one,
    // so the slot part 1 gives up on the cancel goes to it. Nothing frees a
    // slot for this upload's waiters after that: only the cancel can end them.
    budget.setRank('other', 0)
    const second = grantCounter([budget.acquire('other', other.signal, 'fresh')])

    controller.abort()
    await vi.advanceTimersByTimeAsync(0)

    expect(settled).toBe(true)
    const err = await outcome
    expect(err).toBeInstanceOf(DOMException)
    expect((err as DOMException).name).toBe('AbortError')
    expect(put.mock.calls[0][1].aborted).toBe(true)
    // Part 1's slot came back and went to the other file.
    expect(second.granted).toBe(1)
    expect(presigned()).toEqual([1])

    // With the other file done, the whole budget is free again.
    first.releases.forEach((release) => release())
    second.releases.forEach((release) => release())
    const probe = grantCounter([
      budget.acquire('probe', new AbortController().signal, 'fresh'),
      budget.acquire('probe', new AbortController().signal, 'fresh'),
    ])
    await vi.advanceTimersByTimeAsync(0)
    expect(probe.granted).toBe(2)
  })

  it('onUnfinished counts in-flight and sleeping parts', async () => {
    const attempts = new Map<number, number>()
    const part2 = deferred<void>()
    mockPut(async (url) => {
      const part = partOf(url)
      const attempt = (attempts.get(part) ?? 0) + 1
      attempts.set(part, attempt)
      if (part === 1 && attempt === 1) return fail(503)
      if (part === 2) await part2.promise
      return ok(`"etag-${part}"`)
    })
    const onUnfinished = vi.fn()

    const promise = uploadAllParts(makeFile(3000), 'key', 'upload-1', controller, vi.fn(), {
      budget: createPartBudget(2),
      fileKey: 'f',
      chunkSize: 1000,
      onUnfinished,
    })
    await vi.advanceTimersByTimeAsync(100)
    // Part 1 asleep, part 2 on the wire, part 3 not yet sent: none finished.
    expect(onUnfinished.mock.calls.map(([n]) => n)).toEqual([3])

    part2.resolve()
    await vi.advanceTimersByTimeAsync(100)
    // Parts 2 and 3 are done; part 1 is still asleep, and still unfinished.
    expect(attempts.get(1)).toBe(1)
    expect(onUnfinished.mock.calls.map(([n]) => n)).toEqual([3, 2, 1])

    await vi.runAllTimersAsync()
    expect(await promise).toHaveLength(3)
    expect(onUnfinished.mock.calls.map(([n]) => n)).toEqual([3, 2, 1, 0])
  })

  it('reports nothing unfinished once a run that failed has settled', async () => {
    // The parts the run never finished are not going to be sent by it, so the
    // queue must stop counting them against the budget while the row settles.
    mockPut((url) => (partOf(url) === 1 ? fail(403, 'Forbidden') : new Promise(() => {})))
    const onUnfinished = vi.fn()

    const promise = uploadAllParts(makeFile(3000), 'key', 'upload-1', controller, vi.fn(), {
      budget: createPartBudget(3),
      fileKey: 'f',
      chunkSize: 1000,
      onUnfinished,
    })
    const settled = promise.catch((err: unknown) => err)
    await vi.runAllTimersAsync()

    expect(await settled).toBeInstanceOf(Error)
    expect(onUnfinished.mock.calls.map(([n]) => n)).toEqual([3, 0])
  })

  it('does not count parts the backend already holds as unfinished', async () => {
    mockPut((url) => ok(`"etag-${partOf(url)}"`))
    const onUnfinished = vi.fn()

    const promise = uploadAllParts(makeFile(3000), 'key', 'upload-1', controller, vi.fn(), {
      budget: createPartBudget(2),
      fileKey: 'f',
      chunkSize: 1000,
      alreadyHeld: [1, 3],
      onUnfinished,
    })
    await vi.runAllTimersAsync()
    expect(await promise).toEqual([{ PartNumber: 2, ETag: '"etag-2"' }])
    expect(onUnfinished.mock.calls.map(([n]) => n)).toEqual([1, 0])
  })

  it('a failing attempt goes to sleep before it gives its slot back, and asks again as it wakes', async () => {
    // The budget grants on a microtask. A part that gave its slot back and only
    // then said it was asleep -- a microtask later, in some outer catch -- would
    // let the grant pass hand the slot to a fresh part of the same file, which
    // is the storm the cap exists to stop. And a part that woke and asked again
    // only later would let a fresh part slip in ahead of its retry.
    const inner = createPartBudget(2)
    const log: string[] = []
    let wokeThisRun = false
    const budget: PartBudget = {
      size: inner.size,
      acquire: async (fileKey, signal, kind) => {
        log.push(kind === 'retry' && !wokeThisRun ? 'acquire retry, late' : `acquire ${kind}`)
        const release = await inner.acquire(fileKey, signal, kind)
        return () => {
          log.push('release')
          release()
        }
      },
      sleeping: (fileKey) => {
        log.push('sleeping')
        inner.sleeping(fileKey)
      },
      woke: (fileKey) => {
        log.push('woke')
        wokeThisRun = true
        void Promise.resolve().then(() => {
          wokeThisRun = false
        })
        inner.woke(fileKey)
      },
      setRank: (fileKey, rank) => inner.setRank(fileKey, rank),
      forget: (fileKey) => {
        log.push('forget')
        inner.forget(fileKey)
      },
    }
    const put = mockPut()
    put.mockResolvedValueOnce(fail()).mockResolvedValueOnce(ok('"etag-1"'))

    const promise = uploadAllParts(makeFile(1000), 'key', 'upload-1', controller, vi.fn(), {
      budget,
      fileKey: 'f',
      chunkSize: 1000,
    })
    await vi.runAllTimersAsync()
    await promise

    expect(log).toEqual([
      'acquire fresh', 'sleeping', 'release', 'woke', 'acquire retry', 'release', 'forget',
    ])
  })

  it('keeps the slots of parts still settling after a sibling fails for good', async () => {
    // Part 1 is refused for good while part 2 is still waiting on its presign,
    // which cannot be called back. Part 2 holds its slot until that answers:
    // forgetting the file on the first error would count the slot free while
    // the request is still out, and hand it to another file on top.
    const presign2 = deferred<void>()
    vi.mocked(api.post).mockImplementation(async (_path: string, body: unknown) => {
      const part = (body as { part_number: number }).part_number
      if (part === 2) await presign2.promise
      return { presigned_url: `https://s3.example/part-${part}` } as never
    })
    const put = mockPut(() => fail(403, 'Forbidden'))
    const budget = createPartBudget(2)

    let settled = false
    const promise = uploadAllParts(makeFile(2000), 'key', 'upload-1', controller, vi.fn(), {
      budget, fileKey: 'f', chunkSize: 1000,
    })
    const outcome = promise.then(
      () => 'resolved',
      (err: Error) => err.message,
    ).finally(() => {
      settled = true
    })
    const other = new AbortController()
    const others = grantCounter([
      budget.acquire('other', other.signal, 'fresh'),
      budget.acquire('other', other.signal, 'fresh'),
    ])

    await vi.advanceTimersByTimeAsync(0)
    expect(put).toHaveBeenCalledTimes(1)
    // Part 1's slot is free and went to the other file; part 2's is not.
    expect(others.granted).toBe(1)
    expect(settled).toBe(false)

    presign2.resolve()
    await vi.runAllTimersAsync()
    expect(await outcome).toContain('Part 1 failed')
    expect(put).toHaveBeenCalledTimes(1) // part 2 never went out
    expect(others.granted).toBe(2)
  })
})
