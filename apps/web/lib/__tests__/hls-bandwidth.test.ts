import { describe, it, expect, beforeEach, vi } from 'vitest'
import { hlsStartConfig, saveBandwidth, savedBandwidth } from '../hls-bandwidth'

const HOUR = 60 * 60 * 1000
const KEY = 'ff-hls-bandwidth'

describe('hls bandwidth memory', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    window.localStorage.clear()
  })

  it('reads back a saved measurement', () => {
    saveBandwidth(12_000_000, 1_000)
    expect(savedBandwidth(1_000 + HOUR)).toBe(12_000_000)
  })

  it('forgets a measurement older than a day', () => {
    saveBandwidth(12_000_000, 0)
    expect(savedBandwidth(23 * HOUR)).toBe(12_000_000)
    expect(savedBandwidth(25 * HOUR)).toBeUndefined()
  })

  it('caps a very fast measurement at 20 Mbps', () => {
    saveBandwidth(500_000_000, 0)
    expect(savedBandwidth(HOUR)).toBe(20_000_000)
  })

  it('caps an uncapped value already in storage too', () => {
    window.localStorage.setItem(KEY, JSON.stringify({ bps: 500_000_000, at: 0 }))
    expect(savedBandwidth(HOUR)).toBe(20_000_000)
  })

  it('ignores a measurement stamped in the future', () => {
    window.localStorage.setItem(KEY, JSON.stringify({ bps: 12_000_000, at: 10 * HOUR }))
    expect(savedBandwidth(0)).toBeUndefined()
  })

  it('does not store an unusable estimate, or let one replace a good one', () => {
    saveBandwidth(Number.NaN)
    saveBandwidth(0)
    // Checked in storage, not through savedBandwidth, which rejects these on
    // read as well and so would hide a missing save-side check.
    expect(window.localStorage.getItem(KEY)).toBeNull()

    saveBandwidth(8_000_000, 0)
    saveBandwidth(-1, 1)
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toEqual({ bps: 8_000_000, at: 0 })
  })

  it('does not throw when storage refuses the write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })
    expect(() => saveBandwidth(12_000_000)).not.toThrow()
  })

  it('ignores a corrupt stored value', () => {
    window.localStorage.setItem(KEY, '{not json')
    expect(savedBandwidth()).toBeUndefined()
  })
})

describe('hlsStartConfig', () => {
  beforeEach(() => window.localStorage.clear())

  it('changes nothing for a first-time viewer', () => {
    // No estimate (so hls.js guesses from the first rendition) and no raised
    // cap: a higher cap made the first segment load at the top rung.
    expect(hlsStartConfig()).toEqual({})
  })

  it('starts from the last measured bandwidth', () => {
    saveBandwidth(15_000_000)
    expect(hlsStartConfig()).toEqual({ abrEwmaDefaultEstimate: 15_000_000 })
  })
})
