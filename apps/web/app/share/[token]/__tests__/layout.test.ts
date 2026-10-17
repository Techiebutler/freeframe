/**
 * Integration tests for the share-page metadata boundary: the server layout's
 * generateMetadata is driven end-to-end with a mocked API, mocked branding and
 * mocked request headers, asserting the exact tags a crawler sees in the first
 * HTML byte — and that restricted states leak nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ReactNode } from 'react'

vi.hoisted(() => {
  process.env.API_INTERNAL_URL = 'http://api.test:8000'
  process.env.NEXT_PUBLIC_API_URL = '/api'
})

vi.mock('next/headers', () => ({
  headers: () => testRequestHeaders,
}))

vi.mock('@/lib/branding-server', () => ({
  getServerBranding: async () => testBranding,
}))

import { generateMetadata, default as ShareTokenLayout } from '../layout'

const TOKEN = '00000000-0000-4000-8000-00000000000a'

let testRequestHeaders: Headers
let testBranding: { org_name: string } | null
let fetchMock: ReturnType<typeof vi.fn>

const apiOk = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
})

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
  testRequestHeaders = new Headers({
    'x-forwarded-host': 'review.example.ai',
    'x-forwarded-proto': 'https',
  })
  testBranding = { org_name: 'Acme Labs' }
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('share/[token] generateMetadata', () => {
  it('serves the share title and the API image endpoint for a public share, without JS', async () => {
    fetchMock.mockResolvedValue(
      apiOk({
        title: 'Q3 rollout cut',
        description: 'Final review cut',
        has_image: true,
      }),
    )
    const md = await generateMetadata({ params: { token: TOKEN } })
    expect(md.title).toBe('Q3 rollout cut')
    expect(md.openGraph?.title).toBe('Q3 rollout cut')
    expect(md.openGraph?.url).toBe(`https://review.example.ai/share/${TOKEN}`)
    expect((md.openGraph?.images as Array<{ url: string }>)[0].url).toBe(
      `https://review.example.ai/api/share/${TOKEN}/preview.jpg`,
    )
    expect((md.twitter as { card?: string }).card).toBe('summary_large_image')
    // Exactly one fetch here: branding-server is mocked in this suite, so the
    // only real network call is the preview endpoint itself.
    expect(fetchMock.mock.calls).toHaveLength(1)
    expect(fetchMock.mock.calls[0][0]).toBe(
      `http://api.test:8000/share/${TOKEN}/preview`,
    )
  })

  it.each([
    { name: '404 gated/missing/gone link', status: 404 },
    { name: '403 revoked', status: 403 },
    { name: '410 expired', status: 410 },
    { name: '429 rate-limited', status: 429 },
    { name: '500 broken api', status: 500 },
    { name: 'malformed 200 without title', body: { has_image: true } },
    { name: 'malformed non-object 200', body: 'garbage' },
  ])('leaks nothing for the $name case', async (row) => {
    // Non-200s go through the real !res.ok branch; 200s wrap the body as-is.
    const mock =
      row.status !== undefined
        ? { ok: false, status: row.status, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => row.body }
    fetchMock.mockResolvedValue(mock)
    const md = await generateMetadata({ params: { token: TOKEN } })
    expect(md.title).toBe('Acme Labs')
    expect(md.openGraph?.title).toBe('Acme Labs')
    const flat = JSON.stringify(md)
    expect(flat).not.toContain('PRIVATE TITLE')
    expect(flat).not.toContain('media.test')
    expect(flat).not.toContain('og-default')
    expect((md.openGraph?.images as Array<{ url: string }>)[0].url).toBe(
      `https://review.example.ai/api/share/${TOKEN}/preview.jpg`,
    )
  })

  it('falls back to the plain brand name when the API is unreachable', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    const md = await generateMetadata({ params: { token: TOKEN } })
    expect(md.title).toBe('Acme Labs')
    expect(md.description).toBe(
      'Collaborative media review and approval platform',
    )
  })

  it('falls back to "FreeFrame" when instance branding is absent', async () => {
    testBranding = null
    fetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) })
    const md = await generateMetadata({ params: { token: TOKEN } })
    expect(md.title).toBe('FreeFrame')
  })

  it('derives the absolute origin from forwarded request headers', async () => {
    testRequestHeaders = new Headers({
      host: 'internal:3000',
      'x-forwarded-host': 'review.example.ai',
      'x-forwarded-proto': 'https',
    })
    fetchMock.mockResolvedValue(apiOk({ title: 'T' }))
    const md = await generateMetadata({ params: { token: TOKEN } })
    expect(md.metadataBase?.toString()).toBe('https://review.example.ai/')
    expect(md.openGraph?.url).toBe(`https://review.example.ai/share/${TOKEN}`)
  })

  it('renders no wrapper of its own', () => {
    const child = 'the-interactive-page' as unknown as ReactNode
    expect(ShareTokenLayout({ children: child })).toBe(child)
  })
})
