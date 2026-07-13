import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../auth', () => ({ getAccessToken: () => 'tok-123' }))

import { exportComments, FpsRequiredError } from '../export-comments'

function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const res = {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    blob: async () => new Blob(['data']),
  }
  const fn = vi.fn(async () => res)
  vi.stubGlobal('fetch', fn)
  return fn
}

describe('exportComments', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:x'),
      revokeObjectURL: vi.fn(),
    })
  })

  it('calls the export endpoint with auth and params', async () => {
    const fetchFn = mockFetch(200, null, {
      'content-disposition': 'attachment; filename="a_v2_comments.edl"',
    })
    await exportComments({ assetId: 'a1', versionId: 'v1', format: 'edl' })
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/assets/a1/comments/export?')
    expect(url).toContain('format=edl')
    expect(url).toContain('version_id=v1')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-123')
  })

  it('passes fps and include_resolved when provided', async () => {
    const fetchFn = mockFetch(200, null)
    await exportComments({ assetId: 'a1', versionId: 'v1', format: 'edl', fps: 29.97, includeResolved: false })
    const [url] = fetchFn.mock.calls[0] as unknown as [string]
    expect(url).toContain('fps=29.97')
    expect(url).toContain('include_resolved=false')
  })

  it('throws FpsRequiredError on the fps_required 422', async () => {
    mockFetch(422, { detail: { code: 'fps_required', message: 'need fps' } })
    await expect(
      exportComments({ assetId: 'a1', versionId: 'v1', format: 'edl' }),
    ).rejects.toBeInstanceOf(FpsRequiredError)
  })

  it('throws a plain error on other failures', async () => {
    mockFetch(500, null)
    await expect(
      exportComments({ assetId: 'a1', versionId: 'v1', format: 'csv' }),
    ).rejects.toThrow('Export failed (500)')
  })
})
