/**
 * The client's list of uploadable types must be the server's.
 *
 * A drop is filtered in the browser, so a file the client does not list never
 * reaches the server. The only source of truth for what the server accepts is
 * `ALLOWED_MIME_TYPES` in `apps/api/schemas/upload.py`, the set
 * `/upload/initiate` checks. A type the server gains but the client lacks is
 * silently skipped from every folder drop; one the client keeps after the
 * server drops it fails at initiate. This reads the Python source, so either
 * drift fails the web tests instead.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, it, expect } from 'vitest'

import { ALLOWED_MIME_TYPES, TYPE_BY_EXTENSION } from '../upload-media-types'

function serverAllowedMimeTypes(): string[] {
  const src = readFileSync(join(__dirname, '../../../api/schemas/upload.py'), 'utf8')
  const block = src.match(/^ALLOWED_MIME_TYPES\s*=\s*\{([\s\S]*?)^\}/m)
  if (!block) {
    throw new Error(
      'ALLOWED_MIME_TYPES = { ... } was not found in apps/api/schemas/upload.py. If it was ' +
        'renamed or moved, update this test rather than deleting it: it is what keeps ' +
        'the client filter in step with the server.',
    )
  }
  const body = block[1].replace(/#.*$/gm, '')
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1])
}

describe('uploadable types', () => {
  it('ALLOWED_MIME_TYPES is the set apps/api/schemas/upload.py accepts', () => {
    const server = serverAllowedMimeTypes()
    expect(server.length).toBeGreaterThan(0)
    expect([...ALLOWED_MIME_TYPES].sort()).toEqual([...new Set(server)].sort())
    expect(new Set(ALLOWED_MIME_TYPES).size).toBe(ALLOWED_MIME_TYPES.length)
  })

  it('every extension maps to a type the server accepts', () => {
    const server = new Set(serverAllowedMimeTypes())
    for (const [ext, type] of Object.entries(TYPE_BY_EXTENSION)) {
      expect({ ext, accepted: server.has(type) }).toEqual({ ext, accepted: true })
    }
  })
})
