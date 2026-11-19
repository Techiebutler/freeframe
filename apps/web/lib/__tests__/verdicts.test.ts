import { describe, it, expect } from 'vitest'
import { verdictTone, verdictCountToneLabel, VERDICT_LABEL } from '../verdicts'
import type { Verdict, VerdictValue } from '@/types'

function verdict(status: VerdictValue, id: string = status): Verdict {
  return {
    id,
    version_id: 'v1',
    status,
    note: null,
    created_at: '2026-11-18T10:00:00Z',
    updated_at: '2026-11-18T10:00:00Z',
    who: { kind: 'team', name: 'Priya', avatar_url: null, avatar_color: null, is_guest: false },
    via_link_title: null,
    is_mine: false,
  }
}

describe('verdictTone', () => {
  it('is rejected when anyone rejected, however many approved', () => {
    expect(verdictTone({ approved: 3, rejected: 1 })).toBe('rejected')
  })

  it('is changes when someone asked for changes and nobody rejected', () => {
    expect(verdictTone({ approved: 2, changes_requested: 1 })).toBe('changes')
  })

  it('is approved when only approvals are in', () => {
    expect(verdictTone({ approved: 1 })).toBe('approved')
  })

  it('is null with no verdicts', () => {
    expect(verdictTone({ approved: 0, changes_requested: 0, rejected: 0 })).toBeNull()
    expect(verdictTone({})).toBeNull()
    expect(verdictTone([])).toBeNull()
  })

  it('applies the same rule to a list of verdicts', () => {
    expect(verdictTone([verdict('approved', 'a'), verdict('rejected', 'b')])).toBe('rejected')
    expect(verdictTone([verdict('approved', 'a'), verdict('changes_requested', 'b')])).toBe('changes')
    expect(verdictTone([verdict('approved', 'a'), verdict('approved', 'b')])).toBe('approved')
  })
})

describe('VERDICT_LABEL', () => {
  it('names each verdict for people', () => {
    expect(VERDICT_LABEL).toEqual({
      approved: 'Approved',
      changes_requested: 'Changes needed',
      rejected: 'Rejected',
    })
  })
})

describe('verdictCountToneLabel', () => {
  it('names the count and the tone, in the words a verdict reads as', () => {
    expect(verdictCountToneLabel(1, 'rejected')).toBe('1 verdict, rejected')
    expect(verdictCountToneLabel(3, 'changes')).toBe('3 verdicts, changes needed')
    expect(verdictCountToneLabel(2, 'approved')).toBe('2 verdicts, approved')
  })

  it('takes its words from VERDICT_LABEL, not a copy of them', () => {
    expect(verdictCountToneLabel(1, 'changes')).toContain(VERDICT_LABEL.changes_requested.toLowerCase())
    expect(verdictCountToneLabel(1, 'approved')).toContain(VERDICT_LABEL.approved.toLowerCase())
    expect(verdictCountToneLabel(1, 'rejected')).toContain(VERDICT_LABEL.rejected.toLowerCase())
  })
})
