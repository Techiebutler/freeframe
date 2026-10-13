import { describe, it, expect, beforeEach } from 'vitest'
import { hlsStartConfig, saveBandwidth, savedBandwidth } from '../hls-bandwidth'

const DAY = 24 * 60 * 60 * 1000

describe('hls bandwidth memory', () => {
  beforeEach(() => window.localStorage.clear())

  it('reads back a saved measurement', () => {
    saveBandwidth(12_000_000, 1_000)
    expect(savedBandwidth(1_000 + DAY)).toBe(12_000_000)
  })

  it('forgets a measurement older than a week', () => {
    saveBandwidth(12_000_000, 0)
    expect(savedBandwidth(8 * DAY)).toBeUndefined()
  })

  it('does not save an unusable estimate', () => {
    saveBandwidth(Number.NaN)
    saveBandwidth(0)
    expect(savedBandwidth()).toBeUndefined()
  })

  it('ignores a corrupt stored value', () => {
    window.localStorage.setItem('ff-hls-bandwidth', '{not json')
    expect(savedBandwidth()).toBeUndefined()
  })
})

describe('hlsStartConfig', () => {
  beforeEach(() => window.localStorage.clear())

  it('lets the first guess reach 20 Mbps and leaves the estimate to hls.js when nothing is saved', () => {
    const config = hlsStartConfig()
    expect(config.abrEwmaDefaultEstimateMax).toBe(20_000_000)
    // Must stay unset: hls.js only guesses from the first rendition while it is.
    expect('abrEwmaDefaultEstimate' in config).toBe(false)
  })

  it('starts from the last measured bandwidth', () => {
    saveBandwidth(30_000_000)
    expect(hlsStartConfig().abrEwmaDefaultEstimate).toBe(30_000_000)
  })
})
