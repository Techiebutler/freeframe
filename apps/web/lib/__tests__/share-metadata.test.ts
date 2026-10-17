/**
 * Regression tests for the server-side share metadata builder.
 *
 * All tokens are synthetic dummies; every API response is mocked. The
 * fail-closed matrix (public preview vs non-200 vs unverifiable) is asserted
 * here, plus the no-private-leak scan of the final metadata object. The API's
 * preview endpoint is the gate — these tests pin the client half: strict
 * parsing, absolute base-path-aware image URLs, generic card on any failure.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.hoisted(() => {
  // The lib reads both of these at module load; pin them before the import below.
  process.env.API_INTERNAL_URL = 'http://api.test:8000'
  process.env.NEXT_PUBLIC_API_URL = '/api'
})

import {
  buildShareMetadata,
  fetchShareForMetadata,
  parseShareMetadataPayload,
  resolveAppOriginFromHeaders,
  sharePreviewImageUrl,
  GENERIC_SHARE_DESCRIPTION,
  GENERIC_BRAND_TITLE,
} from '../share-metadata'

const TOKEN = '00000000-0000-4000-8000-000000000001'
const TOKEN2 = '00000000-0000-4000-8000-000000000002'

// ─── parseShareMetadataPayload ───────────────────────────────────────────────

describe('parseShareMetadataPayload — the fail-closed matrix', () => {
  it('accepts a clean preview answer', () => {
    const parsed = parseShareMetadataPayload({
      title: 'Q3 rollout cut',
      description: 'Final review cut',
      has_image: true,
    })
    expect(parsed).toEqual({
      title: 'Q3 rollout cut',
      description: 'Final review cut',
    })
  })

  it('accepts a preview without description or image', () => {
    expect(parseShareMetadataPayload({ title: 'T', has_image: false })).toEqual({
      title: 'T',
      description: null,
    })
    expect(parseShareMetadataPayload({ title: 'T' })).toEqual({
      title: 'T',
      description: null,
    })
  })

  it('ignores anything outside the published preview contract', () => {
    // has_image values never change the parsed shape, and extra fields stay private.
    expect(parseShareMetadataPayload({ title: 'T', has_image: 'yes' })?.title).toBe('T')
    expect(
      parseShareMetadataPayload({ title: 'T', secret_note: 'private marker' }),
    ).toEqual({ title: 'T', description: null })
  })

  it('fails closed on missing, empty or blank titles', () => {
    expect(parseShareMetadataPayload({ title: null, has_image: false })).toBeNull()
    expect(parseShareMetadataPayload({ title: '' })).toBeNull()
    expect(parseShareMetadataPayload({ title: '   ' })).toBeNull()
    expect(parseShareMetadataPayload({})).toBeNull()
  })

  it('fails closed on non-object payloads', () => {
    expect(parseShareMetadataPayload(null)).toBeNull()
    expect(parseShareMetadataPayload('oops')).toBeNull()
    expect(parseShareMetadataPayload(42)).toBeNull()
    expect(parseShareMetadataPayload(['title'])).toBeNull()
  })

  it('normalises blank descriptions to null', () => {
    expect(parseShareMetadataPayload({ title: 'T', description: '  ' })?.description).toBeNull()
    expect(parseShareMetadataPayload({ title: 'T', description: null })?.description).toBeNull()
    expect(parseShareMetadataPayload({ title: 'T', description: 'd' })?.description).toBe('d')
  })
})

// ─── fetchShareForMetadata ───────────────────────────────────────────────────

describe('fetchShareForMetadata', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const apiOk = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

  it('fetches the preview endpoint unauthenticated and uncached', async () => {
    fetchMock.mockResolvedValue(apiOk({ title: 'T', has_image: false }))
    const result = await fetchShareForMetadata(TOKEN)
    expect(result).toEqual({ ok: true, share: { title: 'T', description: null } })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`http://api.test:8000/share/${TOKEN}/preview`)
    expect(init.cache).toBe('no-store')
    expect(init.headers).toEqual({ Accept: 'application/json' })
    // No credentials may ever ride along: the metadata view must be the
    // logged-out crawler's view.
    expect(JSON.stringify(init.headers)).not.toContain('Authorization')
  })

  it('encodes the token into the request path', async () => {
    fetchMock.mockResolvedValue(apiOk({ title: 'T' }))
    await fetchShareForMetadata('tok with space')
    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://api.test:8000/share/tok%20with%20space/preview',
    )
  })

  it.each([404, 403, 410, 429, 500])('fails closed on HTTP %i', async (status) => {
    fetchMock.mockResolvedValue({ ok: false, status, json: async () => ({}) })
    expect(await fetchShareForMetadata(TOKEN)).toEqual({ ok: false })
  })

  it('fails closed when the body is not JSON', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token')
      },
    })
    expect(await fetchShareForMetadata(TOKEN)).toEqual({ ok: false })
  })

  it('fails closed on a 200 without a title', async () => {
    // Defense in depth: the API should never do this, but the parser must not
    // publish an untitled share either.
    fetchMock.mockResolvedValue(apiOk({ has_image: true }))
    expect(await fetchShareForMetadata(TOKEN)).toEqual({ ok: false })
  })

  it('fails closed on network errors and timeouts', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    expect(await fetchShareForMetadata(TOKEN)).toEqual({ ok: false })
    fetchMock.mockRejectedValue(new DOMException('timed out', 'AbortError'))
    expect(await fetchShareForMetadata(TOKEN2)).toEqual({ ok: false })
  })
})

// ─── sharePreviewImageUrl ────────────────────────────────────────────────────

describe('sharePreviewImageUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('joins the /api proxy path with the resolved origin (production shape)', () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', '/api')
    const url = sharePreviewImageUrl(TOKEN, 'https://review.example.ai')
    expect(url).toBe(`https://review.example.ai/api/share/${TOKEN}/preview.jpg`)
  })

  it('uses the absolute API base as is in development', () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'http://localhost:8000')
    const url = sharePreviewImageUrl(TOKEN, 'https://review.example.ai')
    expect(url).toBe(`http://localhost:8000/share/${TOKEN}/preview.jpg`)
  })

  it('keeps base-path deployments inside the mounted prefix', () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', '/api')
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/ff')
    const url = sharePreviewImageUrl(TOKEN, 'https://review.example.ai')
    expect(url).toBe(`https://review.example.ai/ff/api/share/${TOKEN}/preview.jpg`)
  })
})

// ─── resolveAppOriginFromHeaders ─────────────────────────────────────────────

describe('resolveAppOriginFromHeaders', () => {
  const getFrom = (h: Record<string, string>) => (n: string) => h[n] ?? null

  it('prefers an explicit NEXT_PUBLIC_APP_URL', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://review.example.ai/')
    expect(resolveAppOriginFromHeaders(getFrom({ host: 'other.example' }))).toBe(
      'https://review.example.ai',
    )
    vi.unstubAllEnvs()
  })

  it('uses forwarded host and proto when present', () => {
    const get = getFrom({
      'x-forwarded-host': 'review.example.ai',
      'x-forwarded-proto': 'https',
    })
    expect(resolveAppOriginFromHeaders(get)).toBe('https://review.example.ai')
  })

  it('takes the leftmost value of stacked forwarded headers', () => {
    const get = getFrom({
      'x-forwarded-host': 'outer.example.ai, inner:3000',
      'x-forwarded-proto': 'https,http',
    })
    expect(resolveAppOriginFromHeaders(get)).toBe('https://outer.example.ai')
  })

  it('falls back to the Host header and assumes https without a proto', () => {
    expect(resolveAppOriginFromHeaders(getFrom({ host: 'review.example.ai' }))).toBe(
      'https://review.example.ai',
    )
  })

  it('rejects malformed hosts and falls back to localhost', () => {
    expect(
      resolveAppOriginFromHeaders(getFrom({ 'x-forwarded-host': 'evil.com/path' })),
    ).toBe('http://localhost:3000')
    expect(resolveAppOriginFromHeaders(getFrom({ host: 'a b' }))).toBe('http://localhost:3000')
    expect(resolveAppOriginFromHeaders(getFrom({}))).toBe('http://localhost:3000')
  })
})

// ─── buildShareMetadata ──────────────────────────────────────────────────────

describe('buildShareMetadata', () => {
  const ORIGIN = 'https://review.example.ai'
  const API_IMAGE_URL = `https://review.example.ai/api/share/${TOKEN}/preview.jpg`
  const PUBLIC_SHARE = {
    ok: true as const,
    share: {
      title: 'Q3 rollout cut',
      description: 'Final review cut',
    },
  }
  const RESTRICTED = { ok: false as const }

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('publishes title, description and the API image endpoint for a public share', () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', '/api')
    const md = buildShareMetadata(TOKEN, PUBLIC_SHARE, ORIGIN, 'Acme Labs')
    expect(md.title).toBe('Q3 rollout cut')
    expect(md.description).toBe('Final review cut')
    expect(md.openGraph?.url).toBe(`https://review.example.ai/share/${TOKEN}`)
    expect(md.openGraph?.siteName).toBe('Acme Labs')
    expect((md.openGraph?.images as Array<{ url: string }>)[0].url).toBe(API_IMAGE_URL)
    expect((md.twitter as { card?: string }).card).toBe('summary_large_image')
    expect(md.twitter?.images).toEqual([API_IMAGE_URL])
    expect(md.robots).toEqual({ index: false, follow: false })
    expect(md.metadataBase?.toString()).toBe(`${ORIGIN}/`)
    // No storage/capability URL may surface in metadata.
    expect(JSON.stringify(md)).not.toContain('media.example.com/obj')
    expect(JSON.stringify(md)).not.toContain('X-Amz-Signature')
  })

  it('serves every image — generic included — from the same gated endpoint', () => {
    // The API streams the share thumbnail when one exists and the fallback
    // logo otherwise, so rich and generic cards share one URL.
    vi.stubEnv('NEXT_PUBLIC_API_URL', '/api')
    const mdRestricted = buildShareMetadata(TOKEN2, RESTRICTED, ORIGIN, 'Acme Labs')
    const mdNoImage = buildShareMetadata(
      TOKEN,
      { ok: true, share: { title: 'T', description: null } },
      ORIGIN,
      null,
    )
    expect((mdRestricted.openGraph?.images as Array<{ url: string }>)[0].url).toBe(
      `https://review.example.ai/api/share/${TOKEN2}/preview.jpg`,
    )
    expect(mdRestricted.openGraph?.title).toBe('Acme Labs')
    expect(mdRestricted.description).toBe(GENERIC_SHARE_DESCRIPTION)
    expect(mdNoImage.title).toBe('T')
    expect((mdNoImage.openGraph?.images as Array<{ url: string }>)[0].url).toBe(API_IMAGE_URL)
  })

  it('gives protected / unknown / errored shares the generic branded card only', () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', '/api')
    const md = buildShareMetadata(TOKEN, RESTRICTED, ORIGIN, 'Acme Labs')
    expect(md.title).toBe('Acme Labs')
    expect(md.description).toBe(GENERIC_SHARE_DESCRIPTION)
    expect((md.openGraph?.images as Array<{ url: string }>)[0].url).toBe(API_IMAGE_URL)
    expect(md.openGraph?.title).toBe('Acme Labs')
    expect((md.twitter as { card?: string }).card).toBe('summary_large_image')
    expect(md.robots).toEqual({ index: false, follow: false })
  })

  it('leaks nothing private into any field of the generic card', () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', '/api')
    const md = buildShareMetadata(TOKEN2, RESTRICTED, ORIGIN, null)
    const flat = JSON.stringify(md)
    expect(flat).not.toContain('PRIVATE')
    expect(flat).not.toContain('secret-asset')
    expect(flat).not.toContain('internal note')
    expect(flat).not.toContain('media.example.com')
    expect(flat).not.toContain('og-default')
  })

  it('uses the generic description when a public share has none', () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', '/api')
    const md = buildShareMetadata(
      TOKEN,
      { ok: true, share: { title: 'T', description: null } },
      ORIGIN,
      null,
    )
    expect(md.description).toBe(GENERIC_SHARE_DESCRIPTION)
    expect(md.openGraph?.description).toBe(GENERIC_SHARE_DESCRIPTION)
  })

  it('honours NEXT_PUBLIC_BASE_PATH on every URL it emits', () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', '/api')
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/ff')
    const md = buildShareMetadata(TOKEN, PUBLIC_SHARE, ORIGIN, null)
    expect(md.openGraph?.url).toBe(`${ORIGIN}/ff/share/${TOKEN}`)
    expect((md.openGraph?.images as Array<{ url: string }>)[0].url).toBe(
      `${ORIGIN}/ff/api/share/${TOKEN}/preview.jpg`,
    )
  })

  it('never emits a token-encoded traversal in URLs', () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', '/api')
    const md = buildShareMetadata('../evil', RESTRICTED, ORIGIN, null)
    expect(md.openGraph?.url).toBe(`${ORIGIN}/share/..%2Fevil`)
    expect((md.openGraph?.images as Array<{ url: string }>)[0].url).toBe(
      `${ORIGIN}/api/share/..%2Fevil/preview.jpg`,
    )
  })
})
