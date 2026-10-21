import { describe, it, expect, afterEach, vi } from 'vitest'
import { assertReadable, FileUnreadableError, FILE_UNREADABLE_MESSAGE } from '@/lib/upload-readable'

/** What `Blob.prototype.slice` hands back when the bytes behind the blob are gone. */
function sliceThatRejects(reason: unknown) {
  return vi.spyOn(Blob.prototype, 'slice').mockReturnValue({
    arrayBuffer: () => Promise.reject(reason),
  } as unknown as Blob)
}

afterEach(() => {
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
