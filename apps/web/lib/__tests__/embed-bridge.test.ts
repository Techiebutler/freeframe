import { describe, expect, it, vi } from 'vitest'
import { parentOrigin, sendToParent } from '../embed-bridge'

const framed = (ancestors: string[] | undefined, referrer = '') => {
  const postMessage = vi.fn()
  const win = { parent: { postMessage }, location: { ancestorOrigins: ancestors }, document: { referrer } } as unknown as Window
  return { win, postMessage }
}

describe('embed bridge', () => {
  it('posts to an allowlisted parent, addressed to that origin', () => {
    const { win, postMessage } = framed(['https://gen.aditor.ai'])
    expect(sendToParent({ type: 'ar:play' }, win)).toBe(true)
    expect(postMessage).toHaveBeenCalledWith({ type: 'ar:play' }, 'https://gen.aditor.ai')
  })
  it('allows the customer portal', () => {
    const { win, postMessage } = framed(['https://app.aditor.ai'])
    sendToParent({ type: 'ar:comment', t: 3.2 }, win)
    expect(postMessage).toHaveBeenCalledWith({ type: 'ar:comment', t: 3.2 }, 'https://app.aditor.ai')
  })
  it('sends nothing to any other origin', () => {
    const { win, postMessage } = framed(['https://evil.example'])
    expect(sendToParent({ type: 'ar:approved' }, win)).toBe(false)
    expect(postMessage).not.toHaveBeenCalled()
  })
  it('falls back to the referrer when ancestorOrigins is missing (Firefox)', () => {
    expect(parentOrigin(undefined, 'https://gen.aditor.ai/desk?x=1')).toBe('https://gen.aditor.ai')
    expect(parentOrigin(undefined, 'https://gen.aditor.ai.evil.example/')).toBeNull()
    expect(parentOrigin(undefined, '')).toBeNull()
  })
  it('does nothing when not framed', () => {
    const postMessage = vi.fn()
    const win = { location: {}, document: { referrer: '' } } as unknown as Window
    ;(win as { parent: unknown }).parent = win
    expect(sendToParent({ type: 'ar:ended' }, win)).toBe(false)
    expect(postMessage).not.toHaveBeenCalled()
  })
})
