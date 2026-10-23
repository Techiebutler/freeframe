import React from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useReviewStore } from '@/stores/review-store'

// A compare URL names its right pane (`right=`), and the right pane is the
// store's current version. On a fresh load the provider used to pick the
// newest ready version whatever the URL said, so a reloaded or shared compare
// link restored a different pair than the one it was copied from (#299).

const versions = [
  { id: 'v-1', version_number: 1, processing_status: 'ready' },
  { id: 'v-2', version_number: 2, processing_status: 'ready' },
  { id: 'v-3', version_number: 3, processing_status: 'ready' },
  { id: 'v-4', version_number: 4, processing_status: 'processing' },
]

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn(async (url: string) => {
      if (url === '/assets/a1') return { id: 'a1', name: 'Demo', asset_type: 'video', latest_version: null }
      if (url === '/assets/a1/versions') return versions.map((v) => ({ ...v }))
      return []
    }),
    post: vi.fn(),
  },
}))

import { ReviewProvider, useReview } from '../review-provider'

beforeEach(() => {
  useReviewStore.getState().reset()
})

async function loadedVersionWith(initialVersionId?: string | null) {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <ReviewProvider assetId="a1" initialVersionId={initialVersionId}>{children}</ReviewProvider>
  )
  const { result } = renderHook(() => useReview(), { wrapper })
  await waitFor(() => expect(result.current.isLoading).toBe(false))
  return useReviewStore.getState().currentVersion?.id
}

describe('ReviewProvider initial version', () => {
  it('opens on the ready version the URL names, not the newest', async () => {
    expect(await loadedVersionWith('v-2')).toBe('v-2')
  })

  it('opens on the newest ready version when none is named', async () => {
    expect(await loadedVersionWith(null)).toBe('v-3')
  })

  it('falls back to the newest ready version for an unknown id', async () => {
    expect(await loadedVersionWith('v-gone')).toBe('v-3')
  })

  it('falls back to the newest ready version when the named one is not ready', async () => {
    expect(await loadedVersionWith('v-4')).toBe('v-3')
  })
})
