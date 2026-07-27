import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

const get = vi.fn()
vi.mock('@/lib/api', () => ({ api: { get: (...a: unknown[]) => get(...a) } }))

import { useStreamUrl } from '../use-stream-url'

beforeEach(() => get.mockReset())

describe('useStreamUrl', () => {
  it('fetches the version-scoped stream URL and prefixes relative HLS paths', async () => {
    get.mockResolvedValueOnce({ url: '/stream/hls/master.m3u8?token=t' })
    const { result } = renderHook(() => useStreamUrl('a1', 'v1'))
    await waitFor(() => expect(result.current.url).not.toBeNull())
    expect(get).toHaveBeenCalledWith('/assets/a1/stream?version_id=v1')
    expect(result.current.url).toBe(
      `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'}/stream/hls/master.m3u8?token=t`,
    )
  })

  it('passes through absolute URLs untouched', async () => {
    get.mockResolvedValueOnce({ url: 'https://cdn.example/x.m3u8' })
    const { result } = renderHook(() => useStreamUrl('a1', 'v1'))
    await waitFor(() => expect(result.current.url).toBe('https://cdn.example/x.m3u8'))
  })

  it('ignores a stale response after versionId changes (anti-race)', async () => {
    let resolveFirst!: (v: { url: string }) => void
    get.mockImplementationOnce(() => new Promise((res) => { resolveFirst = res }))
    get.mockResolvedValueOnce({ url: 'https://cdn.example/v2.m3u8' })

    const { result, rerender } = renderHook(
      ({ vid }: { vid: string }) => useStreamUrl('a1', vid),
      { initialProps: { vid: 'v1' } },
    )
    rerender({ vid: 'v2' })
    await waitFor(() => expect(result.current.url).toBe('https://cdn.example/v2.m3u8'))
    resolveFirst({ url: 'https://cdn.example/v1-STALE.m3u8' })
    await new Promise((r) => setTimeout(r, 10))
    expect(result.current.url).toBe('https://cdn.example/v2.m3u8')
  })

  it('sets error on failure and returns null url when ids missing', async () => {
    get.mockRejectedValueOnce(new Error('boom'))
    const { result } = renderHook(() => useStreamUrl('a1', 'v1'))
    await waitFor(() => expect(result.current.error).toBe(true))

    const none = renderHook(() => useStreamUrl(null, null))
    expect(none.result.current.url).toBeNull()
    expect(get).toHaveBeenCalledTimes(1)
  })
})
