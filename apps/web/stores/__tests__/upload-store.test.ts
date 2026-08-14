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

  it('uploads each part in order and reports the collected ETags', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(okResponse('"etag-1"'))
      .mockResolvedValueOnce(okResponse('"etag-2"')) as unknown as typeof fetch

    const onProgress = vi.fn()
    const promise = uploadAllParts(makeFile(CHUNK_SIZE + 5_000_000), 'key', 'upload-1', controller, onProgress)
    await vi.runAllTimersAsync()

    expect(await promise).toEqual([
      { PartNumber: 1, ETag: '"etag-1"' },
      { PartNumber: 2, ETag: '"etag-2"' },
    ])
    expect(onProgress).toHaveBeenLastCalledWith(95)
  })

  it('keeps several parts in flight and still returns them in order', async () => {
    // Part-specific URLs so the fetch mock can tell which part it is serving.
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

    // 3 parts, 3 workers — all three should be in flight simultaneously.
    const promise = uploadAllParts(makeFile(2 * CHUNK_SIZE + 1000), 'key', 'upload-1', controller, vi.fn(), 3)
    await vi.runAllTimersAsync()
    const parts = await promise

    expect(maxInFlight).toBe(3)
    expect(parts).toEqual([
      { PartNumber: 1, ETag: '"etag-1"' },
      { PartNumber: 2, ETag: '"etag-2"' },
      { PartNumber: 3, ETag: '"etag-3"' },
    ])
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
