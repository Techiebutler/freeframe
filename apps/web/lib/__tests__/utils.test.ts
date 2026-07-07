import { describe, it, expect } from 'vitest'
import {
  formatTime,
  formatTimecode,
  formatBytes,
  formatRelativeTime,
  truncate,
  cn,
  storageMeterState,
  gbToBytes,
  bytesToGb,
} from '../utils'

describe('formatTime', () => {
  it('formats 0 seconds', () => {
    expect(formatTime(0)).toBe('0:00')
  })

  it('formats 83 seconds as 1:23', () => {
    expect(formatTime(83)).toBe('1:23')
  })

  it('formats 3723 seconds as 1:02:03', () => {
    expect(formatTime(3723)).toBe('1:02:03')
  })

  it('formats 59 seconds', () => {
    expect(formatTime(59)).toBe('0:59')
  })

  it('formats 3600 seconds as 1:00:00', () => {
    expect(formatTime(3600)).toBe('1:00:00')
  })
})

describe('formatTimecode', () => {
  it('formats 0 seconds as 00:00:00:00', () => {
    expect(formatTimecode(0)).toBe('00:00:00:00')
  })

  it('formats 83.5 seconds at 24fps', () => {
    // 83.5 * 24 = 2004 frames total
    // 2004 % 24 = 12 frames
    // 2004 / 24 = 83 seconds total
    // 83 % 60 = 23 seconds
    // 83 / 60 = 1 minute
    expect(formatTimecode(83.5, 24)).toBe('00:01:23:12')
  })

  it('formats with custom fps', () => {
    expect(formatTimecode(1, 30)).toBe('00:00:01:00')
  })
})

describe('formatBytes', () => {
  it('returns "0 B" for 0 bytes', () => {
    expect(formatBytes(0)).toBe('0 B')
  })

  it('formats bytes', () => {
    expect(formatBytes(500)).toBe('500 B')
  })

  it('formats KB', () => {
    expect(formatBytes(1024)).toBe('1 KB')
  })

  it('formats MB', () => {
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB')
  })

  it('formats GB', () => {
    expect(formatBytes(1610612736)).toBe('1.5 GB')
  })
})

describe('formatRelativeTime', () => {
  it('returns "just now" for recent timestamps (within 60s)', () => {
    const recent = new Date(Date.now() - 30000).toISOString()
    expect(formatRelativeTime(recent)).toBe('just now')
  })

  it('returns minutes ago', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    expect(formatRelativeTime(fiveMinAgo)).toBe('5 minutes ago')
  })

  it('returns singular "minute ago"', () => {
    const oneMinAgo = new Date(Date.now() - 65 * 1000).toISOString()
    expect(formatRelativeTime(oneMinAgo)).toBe('1 minute ago')
  })

  it('returns hours ago', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    expect(formatRelativeTime(twoHoursAgo)).toBe('2 hours ago')
  })

  it('returns days ago', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
    expect(formatRelativeTime(threeDaysAgo)).toBe('3 days ago')
  })
})

describe('truncate', () => {
  it('returns short string unchanged', () => {
    expect(truncate('hello', 10)).toBe('hello')
  })

  it('truncates long string with ellipsis', () => {
    expect(truncate('hello world', 5)).toBe('hello...')
  })

  it('returns string unchanged when equal to length', () => {
    expect(truncate('hello', 5)).toBe('hello')
  })
})

describe('cn', () => {
  it('merges class names', () => {
    const result = cn('foo', 'bar')
    expect(result).toContain('foo')
    expect(result).toContain('bar')
  })

  it('handles conditional classes', () => {
    const result = cn('base', false && 'conditional')
    expect(result).toContain('base')
    expect(result).not.toContain('conditional')
  })

  it('merges conflicting tailwind classes (last wins)', () => {
    const result = cn('text-red-500', 'text-blue-500')
    expect(result).toBe('text-blue-500')
  })
})

describe('storageMeterState', () => {
  it('is unlimited when limit is 0', () => {
    expect(storageMeterState(500, 0)).toEqual({ unlimited: true, pct: 0, level: 'ok' })
  })
  it('is unlimited when limit is negative', () => {
    expect(storageMeterState(500, -1).unlimited).toBe(true)
  })
  it('computes pct and ok level under 80%', () => {
    expect(storageMeterState(500, 1000)).toEqual({ unlimited: false, pct: 50, level: 'ok' })
  })
  it('warns at 80%', () => {
    expect(storageMeterState(800, 1000).level).toBe('warn')
  })
  it('is critical at 90%', () => {
    expect(storageMeterState(900, 1000).level).toBe('critical')
  })
  it('clamps pct to 100 when over limit', () => {
    const s = storageMeterState(2000, 1000)
    expect(s.pct).toBe(100)
    expect(s.level).toBe('critical')
  })
})

describe('GB conversion', () => {
  it('gbToBytes rounds to whole bytes', () => {
    expect(gbToBytes(10)).toBe(10 * 1024 ** 3)
  })
  it('bytesToGb is the inverse', () => {
    expect(bytesToGb(10 * 1024 ** 3)).toBe(10)
  })
})
