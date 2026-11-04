import { describe, expect, it } from 'vitest'
import { videoTimeAt, type TimelinePoint } from '../rec-timeline'

const p = (rec_ms: number, video_t: number, playing: boolean, rate = 1): TimelinePoint => ({ rec_ms, video_t, playing, rate })

describe('videoTimeAt', () => {
  it('plays at rate 1 from the start', () => {
    expect(videoTimeAt([p(0, 10, true)], 2500)).toBeCloseTo(12.5)
  })
  it('holds the video time while paused (drawing pauses the video, recording goes on)', () => {
    const tl = [p(0, 10, true), p(2000, 12, false)]
    expect(videoTimeAt(tl, 1000)).toBeCloseTo(11)
    expect(videoTimeAt(tl, 2000)).toBeCloseTo(12)
    expect(videoTimeAt(tl, 9000)).toBeCloseTo(12)
  })
  it('resumes after a pause', () => {
    const tl = [p(0, 10, true), p(2000, 12, false), p(5000, 12, true)]
    expect(videoTimeAt(tl, 6000)).toBeCloseTo(13)
  })
  it('jumps on a seek mid-recording', () => {
    const tl = [p(0, 10, true), p(1000, 40, true)] // user seeked to 40s at 1s
    expect(videoTimeAt(tl, 500)).toBeCloseTo(10.5)
    expect(videoTimeAt(tl, 3000)).toBeCloseTo(42)
  })
  it('scales by playback rate', () => {
    expect(videoTimeAt([p(0, 0, true, 1.5)], 2000)).toBeCloseTo(3)
    const tl = [p(0, 0, true, 1), p(1000, 1, true, 2)]
    expect(videoTimeAt(tl, 2000)).toBeCloseTo(3)
  })
  it('falls back to 0 with no points and clamps negative offsets to the first point', () => {
    expect(videoTimeAt([], 1000)).toBe(0)
    expect(videoTimeAt([p(500, 7, false)], 0)).toBe(7)
  })
  it('rounds to milliseconds', () => {
    expect(videoTimeAt([p(0, 1, true, 1)], 333.3333)).toBe(1.333)
  })
})
