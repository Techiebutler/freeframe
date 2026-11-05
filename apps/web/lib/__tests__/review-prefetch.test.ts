import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(async (url: string) => (url.endsWith('/versions') ? [] : { url })) } }))
import { api } from '@/lib/api'
import { prefetchReviews, take } from '../review-prefetch'

describe('review prefetch', () => {
  it('hands a warmed-up request over once, then loads fresh', async () => {
    prefetchReviews(['a1'])
    const calls = vi.mocked(api.get).mock.calls.length
    const load = vi.fn(async () => ({ fresh: true }))
    expect(await take('/assets/a1', load)).toEqual({ url: '/assets/a1' })
    expect(load).not.toHaveBeenCalled()
    expect(vi.mocked(api.get).mock.calls.length).toBe(calls)
    expect(await take('/assets/a1', load)).toEqual({ fresh: true })
  })
})

describe('video warm-up', () => {
  it('walks master -> variant -> first segment when the API URL is relative (/api)', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', '/api')
    vi.mocked(api.get).mockImplementation(async (url: string) =>
      url.endsWith('/versions') ? [{ id: 'v1', version_number: 1, processing_status: 'ready' }] as never
        : url.includes('/stream') ? { url: '/stream/hls/master.m3u8?token=T' } as never : {} as never)
    const seen: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      seen.push(u)
      const body = u.includes('master') ? '#EXTM3U\n0/playlist.m3u8?token=T' : u.includes('playlist') ? '#EXTM3U\nhttps://r2.example/seg_000.ts' : ''
      return new Response(body)
    }))
    prefetchReviews(['b2'])
    await vi.waitFor(() => expect(seen).toContain('https://r2.example/seg_000.ts'))
    expect(seen.some(u => u.endsWith('/api/stream/hls/0/playlist.m3u8?token=T'))).toBe(true)
    vi.unstubAllGlobals(); vi.unstubAllEnvs()
  })
})
