import { describe, expect, it } from 'vitest'
import {
  permissionForApprovals,
  permissionForComments,
  permissionFrom,
  togglesFrom,
} from '../share-permission'

// A share link has one permission, `view`, `comment` or `approve`, and the link
// settings show it as two switches. Approving is a kind of commenting, so the
// switches are not independent: approvals on means comments on.

describe('permissionFrom', () => {
  it('writes view when neither is on', () => {
    expect(permissionFrom({ comments: false, approvals: false })).toBe('view')
  })

  it('writes comment when only comments is on', () => {
    expect(permissionFrom({ comments: true, approvals: false })).toBe('comment')
  })

  it('writes approve when both are on', () => {
    expect(permissionFrom({ comments: true, approvals: true })).toBe('approve')
  })

  it('writes approve when approvals is on alone, since approvals implies comments', () => {
    expect(permissionFrom({ comments: false, approvals: true })).toBe('approve')
  })
})

describe('togglesFrom', () => {
  it('reads view as both off', () => {
    expect(togglesFrom('view')).toEqual({ comments: false, approvals: false })
  })

  it('reads comment as comments on and approvals off', () => {
    expect(togglesFrom('comment')).toEqual({ comments: true, approvals: false })
  })

  it('reads approve as both on, so approvals can never show on over comments off', () => {
    expect(togglesFrom('approve')).toEqual({ comments: true, approvals: true })
  })

  it('is the inverse of permissionFrom for every permission', () => {
    for (const p of ['view', 'comment', 'approve'] as const) {
      expect(permissionFrom(togglesFrom(p))).toBe(p)
    }
  })
})

describe('the switches', () => {
  it('turning comments off writes view, whatever the link allowed before', () => {
    expect(permissionForComments(false)).toBe('view')
  })

  it('turning comments on writes comment only, never approve', () => {
    expect(permissionForComments(true)).toBe('comment')
  })

  it('turning approvals on writes approve', () => {
    expect(permissionForApprovals(true)).toBe('approve')
  })

  it('turning approvals off keeps comments and writes comment', () => {
    expect(permissionForApprovals(false)).toBe('comment')
  })
})
