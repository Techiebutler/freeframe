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
