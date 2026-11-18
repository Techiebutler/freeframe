import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { GuestCommentInput, identityFromHash, consumeHostIdentity, loadIdentity } from './guest-comment-input'

beforeEach(() => { localStorage.clear(); history.replaceState(null, '', '/share/tok?embed=1') })

describe('host identity from URL fragment', () => {
  it('parses and validates', () => {
    expect(identityFromHash('#reviewer_name=%20Ana%20B&reviewer_email=a%40b.co')).toEqual({ name: 'Ana B', email: 'a@b.co' })
    expect(identityFromHash('#reviewer_name=Ana&reviewer_email=nope')).toBeNull()
    expect(identityFromHash('#reviewer_email=a@b.co')).toBeNull()
  })
  it('ignores the query string', () => {
    history.replaceState(null, '', '/share/tok?reviewer_name=Ana&reviewer_email=a@b.co')
    expect(consumeHostIdentity()).toBeNull()
  })
  it('saves, wins over stored identity, and strips the fragment keeping path+query', () => {
    localStorage.setItem('freeframe_guest_identity', JSON.stringify({ name: 'Old', email: 'o@o.co' }))
    history.replaceState(null, '', '/share/tok?embed=1#reviewer_name=Ana&reviewer_email=a%40b.co')
    expect(consumeHostIdentity()).toEqual({ name: 'Ana', email: 'a@b.co' })
    expect(loadIdentity()).toEqual({ name: 'Ana', email: 'a@b.co' })
    expect(location.pathname + location.search + location.hash).toBe('/share/tok?embed=1')
  })
  it('GuestCommentInput does not show the gate when the host sent identity', () => {
    history.replaceState(null, '', '/share/tok#reviewer_name=Ana&reviewer_email=a%40b.co')
    render(<GuestCommentInput token="tok" />)
    expect(screen.queryByText('Who are you?')).toBeNull()
  })
})

describe('consumeHostIdentity with blocked storage', () => {
  it('a second caller still gets the identity after the fragment is stripped', () => {
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    window.history.replaceState(null, '', '/share/t?embed=1#reviewer_name=Alan%20Simon&reviewer_email=alan%40aditor.ai')
    expect(consumeHostIdentity()).toEqual({ name: 'Alan Simon', email: 'alan@aditor.ai' })
    expect(window.location.hash).toBe('')
    expect(consumeHostIdentity()).toEqual({ name: 'Alan Simon', email: 'alan@aditor.ai' })
    set.mockRestore()
  })
})
