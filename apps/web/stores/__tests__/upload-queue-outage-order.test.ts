/**
 * Files held back by one outage start again in the order they were dropped.
 *
 * Spec, "What success looks like": files start in the order you dropped them.
 * When several files are initiating and the connection goes, their initiates
 * fail in whatever order the network gives up on them. The first to fail
 * becomes the hold's probe and the others wait behind it. Neither the order
 * the failures arrived in nor which of them happened to fail first may change
 * the order the files start in once the connection is back, and a row sent back
 * to wait keeps its place in the panel.
 *
 * The API is mocked but `ApiError` is the real one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  api: { post: vi.fn(), get: vi.fn(), patch: vi.fn() },
}))
vi.mock('swr', () => ({ mutate: vi.fn() }))

import { ApiError } from '@/lib/api'
import { useUploadStore, __uploadQueueTesting as testing } from '../upload-store'
import { signInAs } from '@/test/upload-session'
import { fakeServer, small, drop, rowOf, flush } from '@/test/upload-queue-server'

const offline = () => new TypeError('Failed to fetch')

beforeEach(() => {
  vi.clearAllMocks()
  testing.reset()
  window.localStorage.clear()
  useUploadStore.setState({ files: [], versionsRevision: 0, panelOpen: false })
  signInAs('user-1')
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  testing.reset()
})

/**
 * Three small files, all initiating at once, whose initiates then fail in
 * `failOrder` (indexes into the drop). Every later initiate is answered.
 */
async function outage(failOrder: number[]) {
  const server = fakeServer((_, i) => (i < 3 ? 'wait' : 'answer'))
  const ids = drop([small('01.jpg'), small('02.jpg'), small('03.jpg')])
  await flush()
  expect(server.names()).toEqual(['01.jpg', '02.jpg', '03.jpg'])
  const seqs = ids.map((id) => rowOf(id).queueSeq)

  for (const i of failOrder) {
    server.initiates[i].reject(offline())
    await flush()
  }
  return { server, ids, seqs }
}

describe('files held back by one outage', () => {
  it('failing in the order 1, 3, 2 start again as 1, 2, 3', async () => {
    const { server, ids } = await outage([0, 2, 1])
    expect(rowOf(ids[0]).holdReason).toBe('connection')

    await vi.advanceTimersByTimeAsync(2_000)
    await flush()

    expect(server.names().slice(3)).toEqual(['01.jpg', '02.jpg', '03.jpg'])
  })

  it('failing in the order 3, 1, 2 start again as 1, 2, 3: the earliest file waiting is the one that tries', async () => {
    const { server, ids } = await outage([2, 0, 1])
    // The probe role went to the earliest of them, so only that row says why it waits.
    expect(rowOf(ids[0])).toMatchObject({ status: 'queued', holdReason: 'connection' })
    expect(rowOf(ids[1]).holdReason).toBeUndefined()
    expect(rowOf(ids[2])).toMatchObject({ status: 'queued' })
    expect(rowOf(ids[2]).holdReason).toBeUndefined()

    // Still one probe on the same backoff: nothing is tried before the first wait is over.
    await vi.advanceTimersByTimeAsync(1_999)
    expect(server.names()).toHaveLength(3)

    await vi.advanceTimersByTimeAsync(1)
    await flush()

    expect(server.names().slice(3)).toEqual(['01.jpg', '02.jpg', '03.jpg'])
  })

  it('keeps every row where it was in the panel', async () => {
    const { ids, seqs } = await outage([2, 0, 1])
    expect(ids.map((id) => rowOf(id).queueSeq)).toEqual(seqs)

    await vi.advanceTimersByTimeAsync(2_000)
    await flush()
    expect(ids.map((id) => rowOf(id).queueSeq)).toEqual(seqs)
  })

  it('an earlier file that fails while the probe is already trying again waits behind it', async () => {
    // One probe at a time: a try that is out is never doubled by a second one.
    const server = fakeServer((_, i) => (i < 4 ? 'wait' : 'answer'))
    const ids = drop([small('01.jpg'), small('02.jpg'), small('03.jpg')])
    await flush()

    server.initiates[2].reject(offline())
    await flush()
    await vi.advanceTimersByTimeAsync(2_000)
    await flush()
    // 03's second try is out.
    expect(server.names()).toEqual(['01.jpg', '02.jpg', '03.jpg', '03.jpg'])

    server.initiates[1].reject(offline())
    await flush()
    server.initiates[0].reject(offline())
    await flush()
    expect(rowOf(ids[0]).holdReason).toBeUndefined()
    expect(server.names()).toHaveLength(4)

    // The probe got through: the rows behind it start in drop order.
    server.initiates[3].resolve()
    await flush()
    expect(server.names().slice(4)).toEqual(['01.jpg', '02.jpg'])
  })

  it('when that try fails, the earliest file waiting takes the role over for the next try', async () => {
    const server = fakeServer((_, i) => (i < 4 ? 'wait' : 'answer'))
    const ids = drop([small('01.jpg'), small('02.jpg'), small('03.jpg')])
    await flush()

    server.initiates[2].reject(offline())
    await flush()
    await vi.advanceTimersByTimeAsync(2_000)
    await flush()
    server.initiates[1].reject(offline())
    await flush()
    server.initiates[0].reject(offline())
    await flush()
    expect(rowOf(ids[2]).holdReason).toBeUndefined()

    // 03's try fails too: it goes back to its place in line, and 01 makes the next try.
    server.initiates[3].reject(offline())
    await flush()
    expect(rowOf(ids[0])).toMatchObject({ status: 'queued', holdReason: 'connection' })
    expect(rowOf(ids[2])).toMatchObject({ status: 'queued' })
    expect(rowOf(ids[2]).holdReason).toBeUndefined()

    // The backoff carried on: the next try is 4 s later, and it is 01's.
    await vi.advanceTimersByTimeAsync(3_999)
    expect(server.names()).toHaveLength(4)
    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(server.names().slice(4)).toEqual(['01.jpg', '02.jpg', '03.jpg'])
  })

  it('a file that takes the role over with a longer retry-after waits for it, and the backoff doubles from it', async () => {
    const server = fakeServer((_, i) => (i < 4 ? 'wait' : 'answer'))
    const ids = drop([small('01.jpg'), small('02.jpg'), small('03.jpg')])
    await flush()

    server.initiates[2].reject(offline())
    await flush()
    await vi.advanceTimersByTimeAsync(500)
    // 03 is waiting 1.5 s more; 01 is told to come back in 5 s.
    server.initiates[0].reject(new ApiError(503, 'Storage is not answering', { code: 'storage_unavailable', retryAfter: 5 }))
    await flush()
    expect(rowOf(ids[0])).toMatchObject({ status: 'queued', holdReason: 'storage' })

    await vi.advanceTimersByTimeAsync(4_999)
    expect(server.names()).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(server.names()).toEqual(['01.jpg', '02.jpg', '03.jpg', '01.jpg'])

    // That try fails as well: the next wait is 10 s, double the 5 s.
    server.initiates[3].reject(offline())
    await flush()
    await vi.advanceTimersByTimeAsync(9_999)
    expect(server.names()).toHaveLength(4)
    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(server.names().slice(4, 5)).toEqual(['01.jpg'])
  })

  it('a file that takes the role over with a shorter retry-after does not bring the try forward', async () => {
    const storage = (seconds: number) =>
      new ApiError(503, 'Storage is not answering', { code: 'storage_unavailable', retryAfter: seconds })
    const server = fakeServer((_, i) => (i < 3 ? 'wait' : 'answer'))
    drop([small('01.jpg'), small('02.jpg'), small('03.jpg')])
    await flush()

    server.initiates[2].reject(storage(30))
    await flush()
    await vi.advanceTimersByTimeAsync(500)
    server.initiates[0].reject(storage(5))
    await flush()

    // The try stays due 30 s after 03 failed.
    await vi.advanceTimersByTimeAsync(29_499)
    expect(server.names()).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(server.names().slice(3, 4)).toEqual(['01.jpg'])
  })
})
