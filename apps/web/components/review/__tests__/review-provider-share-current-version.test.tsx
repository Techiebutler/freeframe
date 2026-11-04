import React from 'react'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useReviewStore } from '@/stores/review-store'
import { ReviewProvider, useReview } from '../review-provider'

// A share link showing all versions lists them newest first, but streams the
// current one first, which an editor may have set to an older version. The
// player has to open on what was streamed, not on the top of the list.

function respond(body: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) }
}

beforeEach(() => {
  useReviewStore.getState().reset()
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/share/tok/stream/a1')) {
      return respond({ url: 'https://x/v1.m3u8', asset_type: 'video', name: 'Demo', version_id: 'v-1' })
    }
    if (url.includes('/share/tok/assets/a1/versions')) {
      return respond([
        { id: 'v-2', version_number: 2, processing_status: 'ready', created_at: '' },
        { id: 'v-1', version_number: 1, processing_status: 'ready', created_at: '' },
      ])
    }
    return respond([])
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ReviewProvider on a share link', () => {
  it('opens on the version the link streamed first, not the newest listed', async () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <ReviewProvider assetId="a1" shareToken="tok">{children}</ReviewProvider>
    )
    const { result } = renderHook(() => useReview(), { wrapper })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    await waitFor(() => expect(result.current.versions).toHaveLength(2))

    expect(useReviewStore.getState().currentVersion?.id).toBe('v-1')
  })
})
