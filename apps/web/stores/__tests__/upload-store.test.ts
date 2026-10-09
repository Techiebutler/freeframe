import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
  api: {
    post: vi.fn(),
    get: vi.fn(),
  },
}))

import { api } from '@/lib/api'
import { uploadAllParts } from '../upload-store'
import { installXhrFake, ok, fail, type FakeXhr, type PartHandler } from '@/test/xhr-fake'

const CHUNK_SIZE = 10 * 1024 * 1024
/** Mirrors the store's first backoff rung. */
const PART_RETRY_BASE_MS = 2000

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
    const promise = uploadAllParts(makeFile(CHUNK_SIZE + 5_000_000), 'key', 'upload-1', controller, onProgress)
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
    const promise = uploadAllParts(makeFile(2 * CHUNK_SIZE + 1000), 'key', 'upload-1', controller, vi.fn(), 3)
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

    const promise = uploadAllParts(makeFile(2 * CHUNK_SIZE + 1000), 'key', 'upload-1', controller, vi.fn(), 3)
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
    const promise = uploadAllParts(makeFile(4 * CHUNK_SIZE + 1000), 'key', 'upload-1', controller, vi.fn(), 2)
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

    const promise = uploadAllParts(makeFile(1024), 'key', 'upload-1', controller, vi.fn())
    await vi.runAllTimersAsync()

    expect(await promise).toEqual([{ PartNumber: 1, ETag: '"etag-1"' }])
    expect(put).toHaveBeenCalledTimes(3)
  })

  it('re-fetches the presigned URL on every attempt, since it can expire mid-backoff', async () => {
    const put = mockPut()
    put
      .mockResolvedValueOnce(fail())
      .mockResolvedValueOnce(ok('"etag-1"'))

    const promise = uploadAllParts(makeFile(1024), 'key', 'upload-1', controller, vi.fn())
    await vi.runAllTimersAsync()
    await promise

    const presignCalls = vi.mocked(api.post).mock.calls.filter((c) => c[0] === '/upload/presign-part')
    expect(presignCalls).toHaveLength(2)
  })

  it('gives up after the attempt limit and surfaces the last error', async () => {
    const put = mockPut()
    put.mockResolvedValue(fail(500, 'Internal Server Error'))

    const promise = uploadAllParts(makeFile(1024), 'key', 'upload-1', controller, vi.fn())
    const assertion = expect(promise).rejects.toThrow(/Part 1 failed/)
    await vi.runAllTimersAsync()
    await assertion

    expect(put).toHaveBeenCalledTimes(8)
  })

  it('does not retry a 4xx, which would fail identically every time', async () => {
    const put = mockPut()
    put.mockResolvedValue(fail(403, 'Forbidden'))

    const promise = uploadAllParts(makeFile(1024), 'key', 'upload-1', controller, vi.fn())
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

    const promise = uploadAllParts(makeFile(1024), 'key', 'upload-1', controller, vi.fn())
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
    const promise = uploadAllParts(makeFile(CHUNK_SIZE + 1000), 'key', 'upload-1', controller, vi.fn(), 2)
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

    const promise = uploadAllParts(makeFile(1024), 'key', 'upload-1', controller, vi.fn())
    const assertion = expect(promise).rejects.toThrow(/cancelled/)
    await vi.runAllTimersAsync()
    await assertion

    expect(put).toHaveBeenCalledTimes(1)
  })

  it('throws before any request when cancelled upfront', async () => {
    const put = mockPut()
    controller.abort()

    await expect(
      uploadAllParts(makeFile(1024), 'key', 'upload-1', controller, vi.fn()),
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

    const promise = uploadAllParts(makeFile(1000), 'key', 'upload-1', controller, onProgress)
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
    const promise = uploadAllParts(makeFile(37_500), 'key', 'upload-1', controller, onProgress, 5, {
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

    const promise = uploadAllParts(makeFile(2000), 'key', 'upload-1', controller, onProgress, 2, {
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

    const promise = uploadAllParts(makeFile(2100), 'key', 'upload-1', controller, onProgress, 3, {
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

    const promise = uploadAllParts(makeFile(1000), 'key', 'upload-1', controller, onProgress)
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

    const promise = uploadAllParts(makeFile(1000), 'key', 'upload-1', controller, onProgress)
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

    const promise = uploadAllParts(makeFile(CHUNK_SIZE + 1000), 'key', 'upload-1', controller, vi.fn(), 1)
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

    const promise = uploadAllParts(makeFile(1024), 'key', 'upload-1', controller, vi.fn())
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

    const promise = uploadAllParts(makeFile(1024), 'key', 'upload-1', controller, vi.fn())
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

    const promise = uploadAllParts(makeFile(1024), 'key', 'upload-1', controller, vi.fn())
    await vi.runAllTimersAsync()

    expect(await promise).toEqual([{ PartNumber: 1, ETag: '"etag-1"' }])
    expect(put).toHaveBeenCalledTimes(2)
  })

  it('names a network error in its own words once every attempt has failed', async () => {
    // The browser's own text differs by browser ("Failed to fetch", "Load
    // failed"); the row shows this one instead.
    mockPut(() => Promise.reject(new Error('offline')))

    const promise = uploadAllParts(makeFile(1024), 'key', 'upload-1', controller, vi.fn())
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

    const promise = uploadAllParts(makeFile(1024), 'key', 'upload-1', controller, vi.fn())
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

    const promise = uploadAllParts(makeFile(1024), 'key', 'upload-1', controller, vi.fn())
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

    const promise = uploadAllParts(makeFile(CHUNK_SIZE + 1000), 'key', 'upload-1', controller, vi.fn())
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

    const promise = uploadAllParts(makeFile(1024), 'key', 'upload-1', controller, vi.fn())
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

    const promise = uploadAllParts(makeFile(1024), 'key', 'upload-1', controller, vi.fn())
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

    const promise = uploadAllParts(makeFile(1024), 'key', 'upload-1', controller, vi.fn())
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

    const promise = uploadAllParts(makeFile(4 * CHUNK_SIZE + 1000), 'key', 'upload-1', controller, vi.fn(), 5)
    await vi.runAllTimersAsync()
    expect(await promise).toHaveLength(5)

    expect([2, 3, 4, 5].map((part) => attempts.get(part))).toEqual([2, 2, 2, 2])
    expect(live.size).toBe(0)
  })
})
