import { describe, it, expect } from 'vitest'
import { pickReviewLevel, pickPlaybackSource } from '../hls-review'

// Portrait ad ladder as the transcoder writes it (see hls master): 1080p box, 720p box, 540p short side, 360p box.
const ladder = [
  { width: 608, height: 1080, bitrate: 1_128_000 },
  { width: 406, height: 720, bitrate: 703_872 },
  { width: 540, height: 960, bitrate: 1_067_088 },
  { width: 204, height: 360, bitrate: 386_528 },
]

describe('pickReviewLevel', () => {
  it('starts on the 540p rung, not the top rung', () => {
    expect(pickReviewLevel(ladder)).toBe(2)
  })
  it('recognises a landscape 540p rung', () => {
    expect(pickReviewLevel([{ width: 1920, height: 1080, bitrate: 6e6 }, { width: 960, height: 540, bitrate: 1.9e6 }])).toBe(1)
  })
  it('without a 540p rung takes the best rung under ~2 Mbit/s', () => {
    expect(pickReviewLevel([{ width: 1080, height: 1920, bitrate: 8e6 }, { width: 720, height: 1280, bitrate: 2.2e6 }, { width: 360, height: 640, bitrate: 6e5 }])).toBe(1)
  })
  it('when every rung is heavy takes the lightest', () => {
    expect(pickReviewLevel([{ width: 1080, height: 1920, bitrate: 8e6 }, { width: 720, height: 1280, bitrate: 4e6 }])).toBe(1)
  })
  it('-1 for an empty manifest', () => {
    expect(pickReviewLevel([])).toBe(-1)
  })
})

describe('pickPlaybackSource', () => {
  it('plays the proxy MP4 first', () => {
    expect(pickPlaybackSource('/stream/hls/master.m3u8?token=x', 'https://r2/review_540.mp4')).toEqual({ kind: 'proxy', url: 'https://r2/review_540.mp4' })
  })
  it('falls back to the HLS ladder when the version has no proxy', () => {
    expect(pickPlaybackSource('/stream/hls/master.m3u8?token=x', null).kind).toBe('hls')
  })
  it('falls back to the original file while nothing is transcoded yet', () => {
    expect(pickPlaybackSource('https://r2/raw/original.mp4', undefined)).toEqual({ kind: 'original', url: 'https://r2/raw/original.mp4' })
  })
})
