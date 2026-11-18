/**
 * Whether a picked file can still be read.
 *
 * A `File` from a picker or a drop is a handle on a file on disk, not a copy.
 * If that file is touched, rewritten, moved or deleted after it was picked, the
 * handle goes stale. Reading it then fails, and sending it can do worse: in
 * WebKit, `xhr.send(file.slice(...))` on a stale handle hangs with no event at
 * all, so nothing ever says the part is stuck (measured in Playwright WebKit
 * 26.4, at least 90 s). Reading one byte of the same handle rejects within a few
 * milliseconds, so that is how the upload store finds out before it sends.
 */

/** What a row says when its file cannot be read. Shown as it is, so it is the whole sentence. */
export const FILE_UNREADABLE_MESSAGE =
  'The file changed or was moved after it was added. Add it again.'

/**
 * What a row says when the file could not be read for a reason this does not
 * recognise (a `SecurityError`, say) and the browser gave no message to show.
 * It says nothing about the file having changed, so it must not claim that.
 */
export const FILE_READ_FAILED_MESSAGE = 'This file could not be read.'

/**
 * The file behind a `File` changed or moved after it was added. Permanent: the
 * handle stays stale, so trying it again cannot help and only adding the file
 * again can.
 */
export class FileUnreadableError extends Error {
  constructor(message: string = FILE_UNREADABLE_MESSAGE) {
    super(message)
    this.name = 'FileUnreadableError'
  }
}

/**
 * The two names a browser gives a handle whose file is gone or changed. Read by
 * name, as the rest of the upload code reads `AbortError`, so a `DOMException`
 * from another realm counts too.
 */
function isStaleHandle(err: unknown): boolean {
  const name = typeof err === 'object' && err !== null ? (err as { name?: unknown }).name : undefined
  return name === 'NotReadableError' || name === 'NotFoundError'
}

/**
 * How long the one-byte read may take before it counts as failed.
 *
 * A stale handle rejects within milliseconds, so this is not for that. It is
 * for a read that never answers -- a network share that dropped, say -- which
 * would otherwise hold the slot it was read in for good, the hang goal 5 of the
 * upload queue spec is there to end. A slow but working disk or share gives one
 * byte in seconds, so the bound is generous: it matches the part watchdog's
 * 90 s, past which a part sent from the same file would be given up on anyway.
 */
const READ_PROBE_TIMEOUT_MS = 90_000

/**
 * Reads the first byte of `file`. Resolves when it can be read, rejects with
 * `FileUnreadableError` when the handle is stale, and rethrows anything else
 * as it came: a failure that says nothing about the file must not be told as if
 * it did.
 *
 * A read that has not answered in `READ_PROBE_TIMEOUT_MS` rejects with a plain
 * error that says `FILE_READ_FAILED_MESSAGE`. It is not a `FileUnreadableError`:
 * a read that hangs says nothing about whether the file changed, so every
 * caller treats it as retryable. The read itself cannot be called off and is
 * left to settle on its own.
 *
 * One byte from the start, whatever the file's size, so it costs the same for
 * a text file and a 50 GB one.
 */
export async function assertReadable(file: Blob): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(FILE_READ_FAILED_MESSAGE)), READ_PROBE_TIMEOUT_MS)
  })
  try {
    await Promise.race([file.slice(0, 1).arrayBuffer(), timedOut])
  } catch (err) {
    if (isStaleHandle(err)) throw new FileUnreadableError()
    throw err
  } finally {
    clearTimeout(timer)
  }
}
