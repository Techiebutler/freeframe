import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dateInputValue, endOfDayISO } from '../utils'

// Node re-reads process.env.TZ on assignment, so each case runs in a real
// zone, DST included (New York is on EDT, UTC-4, on 2026-10-20).
const CASES = [
  { tz: 'America/New_York', offsetMinutes: 240, expiry: '2026-10-21T03:59:59.999Z' },
  { tz: 'Asia/Kolkata', offsetMinutes: -330, expiry: '2026-10-20T18:29:59.999Z' },
  { tz: 'UTC', offsetMinutes: 0, expiry: '2026-10-20T23:59:59.999Z' },
]

describe('share-link expiry from a picked date', () => {
  let savedTZ: string | undefined
  beforeEach(() => {
    savedTZ = process.env.TZ
  })
  afterEach(() => {
    if (savedTZ === undefined) delete process.env.TZ
    else process.env.TZ = savedTZ
  })

  for (const { tz, offsetMinutes, expiry } of CASES) {
    describe(tz, () => {
      beforeEach(() => {
        process.env.TZ = tz
        // Guard against a vacuous pass: the zone switch must really apply.
        expect(new Date(2026, 9, 20, 12).getTimezoneOffset()).toBe(offsetMinutes)
      })

      it('expires at the last millisecond of the picked day, local time', () => {
        expect(endOfDayISO('2026-10-20')).toBe(expiry)
        const local = new Date(endOfDayISO('2026-10-20'))
        expect([local.getFullYear(), local.getMonth(), local.getDate()]).toEqual([2026, 9, 20])
        expect([local.getHours(), local.getMinutes(), local.getSeconds()]).toEqual([23, 59, 59])
      })

      it('shows the picked day again when the stored expiry is read back', () => {
        expect(dateInputValue(endOfDayISO('2026-10-20'))).toBe('2026-10-20')
        // Month and year boundaries.
        expect(dateInputValue(endOfDayISO('2026-12-31'))).toBe('2026-12-31')
        expect(dateInputValue(endOfDayISO('2027-01-01'))).toBe('2027-01-01')
      })
    })
  }

  it('reads back nothing for an unset or unparseable expiry', () => {
    expect(dateInputValue(null)).toBe('')
    expect(dateInputValue(undefined)).toBe('')
    expect(dateInputValue('')).toBe('')
    expect(dateInputValue('not a date')).toBe('')
  })
})
