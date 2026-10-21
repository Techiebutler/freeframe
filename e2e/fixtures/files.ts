import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { E2E_ROOT } from './env'

const CHUNK = 4 * 1024 * 1024

/**
 * Where scenarios keep files they change while an upload is reading them
 * (touch, rewrite, remove). Gitignored.
 */
export function liveFilesDir(...sub: string[]): string {
  return path.join(E2E_ROOT, '.live-files', ...sub)
}

/** Smallest file `writePng` can make: signature, IHDR, an empty private chunk, IDAT, IEND. */
const MIN_PNG_BYTES = 100

/** One PNG chunk: length, type, data, CRC of type and data. */
function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

/**
 * A valid PNG of exactly `bytes` bytes whose bulk is random.
 *
 * One transparent pixel, plus a private ancillary chunk (`ruRd`, which every
 * decoder skips) holding the random bytes. Unlike random bytes under an `.mp4`
 * name, the transcoder can read it, so the upload finishes as "Ready" at once.
 */
async function writePng(file: string, bytes: number): Promise<void> {
  if (bytes < MIN_PNG_BYTES) throw new Error(`A PNG needs at least ${MIN_PNG_BYTES} bytes, asked for ${bytes}`)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0) // width
  ihdr.writeUInt32BE(1, 4) // height
  ihdr.set([8, 6, 0, 0, 0], 8) // 8-bit RGBA, no interlace
  const idat = pngChunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0, 0])))
  const iend = pngChunk('IEND', Buffer.alloc(0))
  const lead = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr)])
  const payload = bytes - lead.length - 12 - idat.length - iend.length // 12 = length + type + CRC

  const handle = await fs.open(file, 'w')
  try {
    await handle.write(lead)
    const head = Buffer.alloc(8)
    head.writeUInt32BE(payload, 0)
    head.write('ruRd', 4, 'ascii')
    await handle.write(head)
    let crc = crc32(head.subarray(4))
    for (let left = payload; left > 0; ) {
      const piece = randomBytes(Math.min(CHUNK, left))
      crc = crc32(piece, crc)
      await handle.write(piece)
      left -= piece.length
    }
    const tail = Buffer.alloc(4)
    tail.writeUInt32BE(crc, 0)
    await handle.write(tail)
    await handle.write(idat)
    await handle.write(iend)
  } finally {
    await handle.close()
  }
}

/** Write `bytes` of random data to `file`, replacing whatever was there. */
async function writeRandom(file: string, bytes: number): Promise<void> {
  if (file.toLowerCase().endsWith('.png')) return writePng(file, bytes)
  const handle = await fs.open(file, 'w')
  try {
    let left = bytes
    while (left > 0) {
      const n = Math.min(CHUNK, left)
      await handle.write(randomBytes(n))
      left -= n
    }
  } finally {
    await handle.close()
  }
}

/**
 * Real files with random content on disk, so a browser reads them from the
 * filesystem the way it reads a user's pick or drop.
 *
 * Random bytes rather than zeros: nothing between the browser and the bucket
 * may compress, dedupe or short-circuit them, and every call yields files no
 * earlier run has stored.
 *
 * Names keep their extension, because the browser derives the MIME type from
 * it and the API refuses types it does not know (`.mp4` is `video/mp4`). The
 * bytes are not that format, so the transcoder cannot decode them: the row
 * reads "Processing" until the transcoder has retried and given up, minutes
 * later. A `.png` is the exception, a valid image padded to size with random
 * bytes, and finishes as "Ready" at once. Prefer it unless a scenario is about
 * video, because a project with a row stuck in "Processing" keeps an event
 * stream open, and a browser stalls every other request to the API once six
 * are (the HTTP/1.1 limit per host).
 *
 * Returns the absolute paths, in the order given.
 */
export async function makeFiles(
  dir: string,
  specs: Array<{ name: string; bytes: number }>,
): Promise<string[]> {
  await fs.mkdir(dir, { recursive: true })
  const paths: string[] = []
  for (const spec of specs) {
    const file = path.join(dir, spec.name)
    await writeRandom(file, spec.bytes)
    paths.push(file)
  }
  return paths
}

/** Bump a file's modification time to now, leaving its bytes alone. */
export async function touch(file: string): Promise<void> {
  const now = new Date()
  await fs.utimes(file, now, now)
}

/** Delete a file. Not an error if it is already gone. */
export async function remove(file: string): Promise<void> {
  await fs.rm(file, { force: true })
}

/** Replace a file's content, in place, with `bytes` of new random data. */
export async function rewrite(file: string, bytes: number): Promise<void> {
  await writeRandom(file, bytes)
}
