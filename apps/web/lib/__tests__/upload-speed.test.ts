import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createSpeedMeter, type UploadRate } from '../upload-speed'

const MB = 1024 * 1024

/** Feeds `bytesPerSecond` in 100 ms steps for `seconds`, from `start` bytes. */
function feed(sample: (n: number) => void, start: number, bytesPerSecond: number, seconds: number) {
  let sent = start
  for (let i = 0; i < seconds * 10; i++) {
    vi.advanceTimersByTime(100)
    sent += bytesPerSecond / 10
    sample(sent)
  }
  return sent
}

describe('createSpeedMeter', () => {
  let published: Array<UploadRate | null>
  const last = () => published[published.length - 1]

  beforeEach(() => {
    vi.useFakeTimers()
    published = []
  })
  afterEach(() => vi.useRealTimers())

  it('reports a steady transfer and the time it leaves', () => {
    const meter = createSpeedMeter(100 * MB, (r) => published.push(r))
    meter.sample(0)
    feed(meter.sample, 0, 10 * MB, 4)

    expect(last()!.bytesPerSecond).toBeGreaterThan(9.5 * MB)
    expect(last()!.bytesPerSecond).toBeLessThan(10.5 * MB)
    // 60 MB to go at 10 MB/s.
    expect(last()!.secondsLeft).toBeGreaterThan(5.5)
    expect(last()!.secondsLeft).toBeLessThan(6.5)
    meter.stop()
  })

  it('publishes nothing before a second of data', () => {
    const meter = createSpeedMeter(100 * MB, (r) => published.push(r))
    meter.sample(0)
    vi.advanceTimersByTime(500)
    meter.sample(5 * MB)

    expect(published.every((r) => r === null)).toBe(true)
    meter.stop()
  })

  it('does not count what a resume already holds as speed', () => {
    const meter = createSpeedMeter(100 * MB, (r) => published.push(r))
    meter.sample(80 * MB) // the parts storage held before this transfer
    feed(meter.sample, 80 * MB, 2 * MB, 3)

    expect(last()!.bytesPerSecond).toBeLessThan(2.5 * MB)
    meter.stop()
  })

  it('takes a failed part giving its bytes back as a re-send, not negative progress', () => {
    const meter = createSpeedMeter(100 * MB, (r) => published.push(r))
    meter.sample(0)
    let sent = feed(meter.sample, 0, 4 * MB, 2)
    sent -= 4 * MB // the part failed and gave its bytes back
    meter.sample(sent)
    feed(meter.sample, sent, 4 * MB, 2)

    expect(published.filter(Boolean).every((r) => r!.bytesPerSecond >= 0)).toBe(true)
    expect(last()!.bytesPerSecond).toBeGreaterThan(3.5 * MB)
    expect(last()!.bytesPerSecond).toBeLessThan(4.5 * MB)
    meter.stop()
  })

  it('falls to zero when the transfer stalls, with no time-left estimate', () => {
    const meter = createSpeedMeter(100 * MB, (r) => published.push(r))
    meter.sample(0)
    feed(meter.sample, 0, 10 * MB, 2)
    vi.advanceTimersByTime(8_000)

    expect(last()).toEqual({ bytesPerSecond: 0, secondsLeft: null })
    meter.stop()
  })

  it('withdraws the figure and stops publishing when stopped', () => {
    const meter = createSpeedMeter(100 * MB, (r) => published.push(r))
    meter.sample(0)
    feed(meter.sample, 0, 10 * MB, 2)
    meter.stop()
    const count = published.length

    expect(last()).toBeNull()
    vi.advanceTimersByTime(5_000)
    meter.sample(50 * MB)
    meter.stop()
    expect(published).toHaveLength(count)
  })
})
