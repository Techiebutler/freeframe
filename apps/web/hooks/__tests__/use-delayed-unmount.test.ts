import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDelayedUnmount } from '../use-delayed-unmount'

describe('useDelayedUnmount', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('stays mounted through the close animation, then unmounts', () => {
    const { result, rerender } = renderHook(({ open }) => useDelayedUnmount(open, 150), {
      initialProps: { open: true },
    })
    expect(result.current.mounted).toBe(true)
    expect(result.current.state).toBe('open')

    // Close: mounted must persist while state flips to 'closed'.
    rerender({ open: false })
    expect(result.current.mounted).toBe(true)
    expect(result.current.state).toBe('closed')

    // After the duration, it unmounts.
    act(() => vi.advanceTimersByTime(150))
    expect(result.current.mounted).toBe(false)
  })
})
