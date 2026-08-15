import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
  api: {
    post: vi.fn(),
    get: vi.fn(),
  },
}))

import { api } from '@/lib/api'
import { uploadAllParts } from '../upload-store'

const CHUNK_SIZE = 10 * 1024 * 1024
/** Mirrors the store's first backoff rung. */
const PART_RETRY_BASE_MS = 2000

/** Builds a File of `bytes` length; 15 MB spans two 10 MB parts. */
function makeFile(bytes: number): File {
  return new File([new Uint8Array(bytes)], 'clip.mp4', { type: 'video/mp4' })
}

function okResponse(etag: string) {
  return { ok: true, headers: { get: () => etag } }
}

function failResponse(status = 503, statusText = 'Service Unavailable') {
  return { ok: false, status, statusText, headers: { get: () => null } }
}

/**
 * Presigns to a URL that names the part, so a fetch mock can tell parts apart.
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
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      const part = partOf(url)
      await new Promise((resolve) => setTimeout(resolve, part === 1 ? 50 : 5))
      completionOrder.push(part)
      return okResponse(`"etag-${part}"`)
    }) as unknown as typeof fetch

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
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      const part = partOf(url)
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      // Deliberately reversed: the last part is quickest, so parts complete in
      // the opposite order to the one they must be returned in. A uniform delay
      // would let an append-on-completion implementation pass.
      await new Promise((resolve) => setTimeout(resolve, (4 - part) * 10))
      inFlight -= 1
      completionOrder.push(part)
      return okResponse(`"etag-${part}"`)
    }) as unknown as typeof fetch

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
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (partOf(url) === 1) return failResponse(403, 'Forbidden')
      await new Promise((resolve) => setTimeout(resolve, 10))
      return failResponse(503)
    }) as unknown as typeof fetch

    const promise = uploadAllParts(makeFile(2 * CHUNK_SIZE + 1000), 'key', 'upload-1', controller, vi.fn(), 3)
    const settled = promise.then(() => 'resolved').catch((err: Error) => err.message)
    await vi.advanceTimersByTimeAsync(PART_RETRY_BASE_MS)
    await vi.runAllTimersAsync()

    expect(await settled).toContain('Part 1 failed')
    // One PUT per part, plus at most one more per sibling already in flight —
    // nowhere near the 3 + 8 + 8 a full ladder would produce.
    expect(vi.mocked(global.fetch).mock.calls.length).toBeLessThanOrEqual(6)
  })

  it('never exceeds the configured concurrency', async () => {
    vi.mocked(api.post).mockImplementation((_path: string, body: unknown) =>
      Promise.resolve({ presigned_url: `https://s3.example/part-${(body as { part_number: number }).part_number}` }) as never,
    )

    let inFlight = 0
    let maxInFlight = 0
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 10))
      inFlight -= 1
      return okResponse(`"etag-${url.split('-').pop()}"`)
    }) as unknown as typeof fetch

    // 5 parts, but only 2 workers.
    const promise = uploadAllParts(makeFile(4 * CHUNK_SIZE + 1000), 'key', 'upload-1', controller, vi.fn(), 2)
    await vi.runAllTimersAsync()
    const parts = await promise

    expect(maxInFlight).toBe(2)
    expect(parts.map((p) => p.PartNumber)).toEqual([1, 2, 3, 4, 5])
  })

  it('retries a part that fails transiently and still succeeds', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(failResponse())
      .mockResolvedValueOnce(failResponse())
      .mockResolvedValueOnce(okResponse('"etag-1"')) as unknown as typeof fetch

    const promise = uploadAllParts(makeFile(1024), 'key', 'upload-1', controller, vi.fn())
    await vi.runAllTimersAsync()

    expect(await promise).toEqual([{ PartNumber: 1, ETag: '"etag-1"' }])
    expect(global.fetch).toHaveBeenCalledTimes(3)
  })

  it('re-fetches the presigned URL on every attempt, since it can expire mid-backoff', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(failResponse())
      .mockResolvedValueOnce(okResponse('"etag-1"')) as unknown as typeof fetch

    const promise = uploadAllParts(makeFile(1024), 'key', 'upload-1', controller, vi.fn())
    await vi.runAllTimersAsync()
    await promise

    const presignCalls = vi.mocked(api.post).mock.calls.filter((c) => c[0] === '/upload/presign-part')
    expect(presignCalls).toHaveLength(2)
  })

  it('gives up after the attempt limit and surfaces the last error', async () => {
    global.fetch = vi.fn().mockResolvedValue(failResponse(500, 'Internal Server Error')) as unknown as typeof fetch

    const promise = uploadAllParts(makeFile(1024), 'key', 'upload-1', controller, vi.fn())
    const assertion = expect(promise).rejects.toThrow(/Part 1 failed/)
    await vi.runAllTimersAsync()
    await assertion

    expect(global.fetch).toHaveBeenCalledTimes(8)
  })

  it('does not retry a 4xx, which would fail identically every time', async () => {
    global.fetch = vi.fn().mockResolvedValue(failResponse(403, 'Forbidden')) as unknown as typeof fetch

    const promise = uploadAllParts(makeFile(1024), 'key', 'upload-1', controller, vi.fn())
    const assertion = expect(promise).rejects.toThrow(/Forbidden/)
    await vi.runAllTimersAsync()
    await assertion

    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('does retry a 429, which explicitly invites a later attempt', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(failResponse(429, 'Too Many Requests'))
      .mockResolvedValueOnce(okResponse('"etag-1"')) as unknown as typeof fetch

    const promise = uploadAllParts(makeFile(1024), 'key', 'upload-1', controller, vi.fn())
    await vi.runAllTimersAsync()

    expect(await promise).toEqual([{ PartNumber: 1, ETag: '"etag-1"' }])
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })

  it('wakes a part waiting on backoff as soon as a sibling fails for good', async () => {
    mockPresignPerPart()
    // Part 2 fails transiently and settles into its first 2s backoff. Part 1
    // then fails permanently at t=100ms. Part 2 has no reason to serve out the
    // rest of that sleep: the upload it belongs to is already lost.
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (partOf(url) === 2) return failResponse(503)
      await new Promise((resolve) => setTimeout(resolve, 100))
      return failResponse(403, 'Forbidden')
    }) as unknown as typeof fetch

    let settled = false
    const promise = uploadAllParts(makeFile(CHUNK_SIZE + 1000), 'key', 'upload-1', controller, vi.fn(), 2)
    promise.catch(() => { settled = true })

    // Well past part 1's failure, and well short of part 2's 2s+jitter rung.
    await vi.advanceTimersByTimeAsync(500)
    expect(settled).toBe(true)

    await expect(promise).rejects.toThrow(/Part 1 failed/)
  })

  it('does not retry once the upload was cancelled', async () => {
    global.fetch = vi.fn().mockImplementation(() => {
      controller.abort()
      return Promise.reject(new DOMException('The operation was aborted', 'AbortError'))
    }) as unknown as typeof fetch

    const promise = uploadAllParts(makeFile(1024), 'key', 'upload-1', controller, vi.fn())
    const assertion = expect(promise).rejects.toThrow(/aborted/)
    await vi.runAllTimersAsync()
    await assertion

    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('throws before any request when cancelled upfront', async () => {
    global.fetch = vi.fn() as unknown as typeof fetch
    controller.abort()

    await expect(
      uploadAllParts(makeFile(1024), 'key', 'upload-1', controller, vi.fn()),
    ).rejects.toThrow(/cancelled/)

    expect(global.fetch).not.toHaveBeenCalled()
  })
})
