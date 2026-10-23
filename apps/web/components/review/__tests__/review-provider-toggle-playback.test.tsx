import React from 'react'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useReviewStore } from '@/stores/review-store'
import { ReviewProvider, useReview } from '../review-provider'

// The mobile comment sheet toggles a video through the player that registered
// here (#412). Switching from a video asset to an audio one unmounts that
// player, and its registration has to go with it, but only its own: a new
// player that registered before the old one's cleanup ran must stay.

beforeEach(() => {
  useReviewStore.getState().reset()
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function renderProvider() {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <ReviewProvider assetId="a1" shareToken="tok">{children}</ReviewProvider>
  )
  return renderHook(() => useReview(), { wrapper })
}

describe('ReviewProvider togglePlayback', () => {
  it('calls the registered toggle, and nothing once it is unregistered', () => {
    const { result } = renderProvider()
    const toggle = vi.fn()

    let unregister = () => {}
    act(() => { unregister = result.current.registerTogglePlayHandler(toggle) })
    act(() => result.current.togglePlayback())
    expect(toggle).toHaveBeenCalledTimes(1)

    act(() => unregister())
    act(() => result.current.togglePlayback())
    expect(toggle).toHaveBeenCalledTimes(1)
  })

  it("leaves a newer player's toggle in place when an older one unregisters", () => {
    const { result } = renderProvider()
    const older = vi.fn()
    const newer = vi.fn()

    let unregisterOlder = () => {}
    act(() => { unregisterOlder = result.current.registerTogglePlayHandler(older) })
    act(() => { result.current.registerTogglePlayHandler(newer) })
    act(() => unregisterOlder())
    act(() => result.current.togglePlayback())

    expect(newer).toHaveBeenCalledTimes(1)
    expect(older).not.toHaveBeenCalled()
  })
})
