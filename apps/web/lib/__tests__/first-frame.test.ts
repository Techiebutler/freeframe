import { describe, it, expect } from 'vitest'
import { frameInitial, frameReducer, withFirstFrameHint } from '../first-frame'

describe('first-frame state', () => {
  it('covers the video (poster shown) until the source has a decoded frame', () => {
    let s = frameReducer(frameInitial, { type: 'source', key: 'a.mp4' })
    expect(s.covered).toBe(true)
    s = frameReducer(s, { type: 'frame', key: 'a.mp4' })
    expect(s.covered).toBe(false)
  })

  it('switching source covers again and keeps the layer until the new frame is decoded', () => {
    let s = frameReducer(frameInitial, { type: 'source', key: 'hook1.mp4' })
    s = frameReducer(s, { type: 'frame', key: 'hook1.mp4' })
    s = frameReducer(s, { type: 'source', key: 'hook2.mp4' })
    expect(s.covered).toBe(true)
  })

  it('a late frame of the superseded source does not uncover the new one', () => {
    let s = frameReducer(frameInitial, { type: 'source', key: 'hook1.mp4' })
    s = frameReducer(s, { type: 'source', key: 'hook2.mp4' })
    s = frameReducer(s, { type: 'frame', key: 'hook1.mp4' })
    expect(s.covered).toBe(true)
    s = frameReducer(s, { type: 'frame', key: 'hook2.mp4' })
    expect(s.covered).toBe(false)
  })

  it('the same source again changes nothing', () => {
    const s = frameReducer(frameInitial, { type: 'source', key: 'a' })
    expect(frameReducer(s, { type: 'source', key: 'a' })).toBe(s)
  })
})

describe('withFirstFrameHint', () => {
  it('asks a progressive file for its first frame, leaves HLS and fragments alone', () => {
    expect(withFirstFrameHint('https://r2/review_540.mp4')).toBe('https://r2/review_540.mp4#t=0.001')
    expect(withFirstFrameHint('/stream/master.m3u8?token=x')).toBe('/stream/master.m3u8?token=x')
    expect(withFirstFrameHint('https://r2/a.mp4#t=5')).toBe('https://r2/a.mp4#t=5')
  })
})
