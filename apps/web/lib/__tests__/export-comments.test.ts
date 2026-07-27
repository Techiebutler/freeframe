import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../auth', () => ({ getAccessToken: () => 'tok-123' }))

import { exportComments, FpsRequiredError } from '../export-comments'

function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const blob = new Blob(['data'])
  const res = {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    blob: async () => blob,
  }
  const fn = vi.fn(async () => res)
  vi.stubGlobal('fetch', fn)
  return Object.assign(fn, { blob })
}

/**
 * Spies on document.createElement, delegating to the real implementation so
 * jsdom gives us a genuine <a> element, while recording it (and stubbing its
 * click()) so we can assert on download attribute / click invocation without
 * triggering a real navigation.
 */
function spyOnAnchorCreation() {
  const originalCreateElement = document.createElement.bind(document)
  let anchor: HTMLAnchorElement | undefined
  const spy = vi
    .spyOn(document, 'createElement')
    .mockImplementation(((tagName: string) => {
      const el = originalCreateElement(tagName as keyof HTMLElementTagNameMap)
      if (tagName === 'a') {
        anchor = el as HTMLAnchorElement
        vi.spyOn(anchor, 'click').mockImplementation(() => {})
      }
      return el
    }) as typeof document.createElement)
  return {
    spy,
    getAnchor: () => anchor,
  }
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

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
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

  it('throws an Error carrying the exact string detail for a non-fps 422 (and not an FpsRequiredError)', async () => {
    const detailMessage =
      'EDL/FCPXML/Premiere XML export is only available for video assets; use format=csv'
    mockFetch(422, { detail: detailMessage })

    let caught: unknown
    try {
      await exportComments({ assetId: 'a1', versionId: 'v1', format: 'edl' })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(Error)
    expect(caught).not.toBeInstanceOf(FpsRequiredError)
    expect((caught as Error).message).toBe(detailMessage)
  })

  it('creates an object URL from the response blob, downloads it under the server-supplied filename, and revokes the URL after the cleanup delay', async () => {
    vi.useFakeTimers()
    const fetchFn = mockFetch(200, null, {
      'content-disposition':
        'attachment; filename="Demo Asset_v2_comments.edl"; filename*=UTF-8\'\'Demo%20Asset_v2_comments.edl',
    })
    const { getAnchor } = spyOnAnchorCreation()

    await exportComments({ assetId: 'a1', versionId: 'v2', format: 'edl' })

    const anchor = getAnchor()
    expect(anchor).toBeDefined()
    expect(anchor?.download).toBe('Demo Asset_v2_comments.edl')
    expect(anchor?.click).toHaveBeenCalledTimes(1)
    expect(URL.createObjectURL).toHaveBeenCalledWith(fetchFn.blob)
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1000)

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:x')
  })

  it('falls back to a format-based filename when no Content-Disposition header is present', async () => {
    vi.useFakeTimers()
    mockFetch(200, null)
    const { getAnchor } = spyOnAnchorCreation()

    await exportComments({ assetId: 'a1', versionId: 'v1', format: 'premiere_xml' })

    expect(getAnchor()?.download).toBe('comments.xml')

    vi.advanceTimersByTime(1000)
  })
})
