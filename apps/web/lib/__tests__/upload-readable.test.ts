import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  assertReadable, FileUnreadableError, FILE_UNREADABLE_MESSAGE, FILE_READ_FAILED_MESSAGE,
} from '@/lib/upload-readable'

/** What `Blob.prototype.slice` hands back when the bytes behind the blob are gone. */
function sliceThatRejects(reason: unknown) {
  return vi.spyOn(Blob.prototype, 'slice').mockReturnValue({
    arrayBuffer: () => Promise.reject(reason),
  } as unknown as Blob)
}

/** A read that answers only when the test says so, or never. */
function sliceThatWaits() {
  let answer!: () => void
  vi.spyOn(Blob.prototype, 'slice').mockReturnValue({
    arrayBuffer: () => new Promise<ArrayBuffer>((resolve) => {
      answer = () => resolve(new ArrayBuffer(1))
    }),
  } as unknown as Blob)
  return { answer: () => answer() }
}

/** Mirrors the module's bound on the read. */
const READ_PROBE_TIMEOUT_MS = 90_000

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('assertReadable', () => {
  it('resolves for a file the browser can still read', async () => {
    await expect(assertReadable(new File([new Uint8Array(4)], 'a.mov'))).resolves.toBeUndefined()
  })

  it('reads one byte from the start, not the file', async () => {
    const slice = vi.spyOn(Blob.prototype, 'slice')
    await assertReadable(new File([new Uint8Array(4)], 'a.mov'))
    expect(slice).toHaveBeenCalledTimes(1)
    expect(slice).toHaveBeenCalledWith(0, 1)
  })

  it('resolves for an empty file', async () => {
    await expect(assertReadable(new File([], 'empty.txt'))).resolves.toBeUndefined()
  })

  it('maps NotReadableError and NotFoundError, rethrows others', async () => {
    for (const name of ['NotReadableError', 'NotFoundError']) {
      sliceThatRejects(new DOMException('gone', name))
      const err = await assertReadable(new Blob(['x'])).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(FileUnreadableError)
      expect((err as Error).message).toBe(
        'The file changed or was moved after it was added. Add it again.',
      )
      vi.restoreAllMocks()
    }

    // Anything else says nothing about the file, so it is not told as if it did.
    for (const other of [
      new DOMException('blocked', 'SecurityError'),
      new DOMException('stopped', 'AbortError'),
      new TypeError('not a blob'),
    ]) {
      sliceThatRejects(other)
      const err = await assertReadable(new Blob(['x'])).catch((e: unknown) => e)
      expect(err).toBe(other)
      expect(err).not.toBeInstanceOf(FileUnreadableError)
      vi.restoreAllMocks()
    }
  })

  it('gives up on a read that has not answered in 90 s, as a read failure and not a changed file', async () => {
    // A read that hangs -- a network drive that dropped, say -- would hold the
    // slot it was read in forever. It says nothing about whether the file
    // changed, so it fails the way any other unexplained read failure does:
    // retryably.
    vi.useFakeTimers()
    sliceThatWaits()
    let outcome: unknown = 'pending'
    void assertReadable(new Blob(['x'])).then(
      () => { outcome = 'resolved' },
      (err: unknown) => { outcome = err },
    )

    await vi.advanceTimersByTimeAsync(READ_PROBE_TIMEOUT_MS - 1)
    expect(outcome).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    expect(outcome).toBeInstanceOf(Error)
    expect(outcome).not.toBeInstanceOf(FileUnreadableError)
    expect((outcome as Error).message).toBe(FILE_READ_FAILED_MESSAGE)
  })

  it('waits out a slow read that does answer, and leaves no timer behind', async () => {
    // A file on a sleeping disk or a slow share can take seconds to give its
    // first byte. That is a readable file.
    vi.useFakeTimers()
    const read = sliceThatWaits()
    let outcome: unknown = 'pending'
    void assertReadable(new Blob(['x'])).then(
      () => { outcome = 'resolved' },
      (err: unknown) => { outcome = err },
    )

    await vi.advanceTimersByTimeAsync(60_000)
    read.answer()
    await vi.advanceTimersByTimeAsync(0)
    expect(outcome).toBe('resolved')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('exposes the exact message for the panel to show', () => {
    expect(FILE_UNREADABLE_MESSAGE).toBe(
      'The file changed or was moved after it was added. Add it again.',
    )
    const err = new FileUnreadableError()
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('FileUnreadableError')
    expect(err.message).toBe(FILE_UNREADABLE_MESSAGE)
  })
})
