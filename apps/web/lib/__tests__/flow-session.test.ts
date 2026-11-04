import { beforeEach, describe, expect, it } from 'vitest'
import { doneLine, markApproved, markFeedback, resetSession, sentLine, sessionSummary, unmarkApproved } from '../flow-session'

beforeEach(() => resetSession())
describe('flow session', () => {
  it('counts approved files and files with feedback once each', () => {
    markApproved('s', 'a'); markApproved('s', 'a'); markApproved('s', 'b'); markFeedback('s', 'c'); markFeedback('s', 'c')
    expect(sessionSummary('s')).toEqual({ approved: 2, feedback: 1 })
  })
  it('undo takes an approval back out', () => {
    markApproved('s', 'a'); unmarkApproved('s', 'a')
    expect(sessionSummary('s').approved).toBe(0)
  })
  it('keeps contexts apart', () => {
    markApproved('one', 'a')
    expect(sessionSummary('two')).toEqual({ approved: 0, feedback: 0 })
  })
  it('words the closing lines', () => {
    expect(doneLine({ approved: 7, feedback: 3 })).toBe('All done · 7 approved, 3 with feedback')
    expect(doneLine({ approved: 1, feedback: 0 })).toBe('All done · 1 approved')
    expect(doneLine({ approved: 0, feedback: 2 })).toBe('All done · 2 with feedback')
    expect(doneLine({ approved: 0, feedback: 0 })).toBe('All done')
    expect(sentLine(3, true)).toBe('3 notes with the agent · it replies with the next version')
    expect(sentLine(1, false)).toBe('1 note sent')
  })
})
