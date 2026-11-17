import { describe, expect, it, vi } from 'vitest'
import { EMBED_PARENT_ORIGINS, parentOrigin, sendAutoreviewEvent, sendToParent } from '../embed-bridge'

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

  describe('autoreview hand-off', () => {
    it('posts round_sent with the request id to the parent origin', () => {
      const { win, postMessage } = framed(['https://gen.aditor.ai'])
      expect(sendAutoreviewEvent({ event: 'round_sent', request_id: 'r1', asset_id: 'a1' }, win)).toBe(true)
      expect(postMessage).toHaveBeenCalledWith({ type: 'autoreview', event: 'round_sent', request_id: 'r1', asset_id: 'a1' }, 'https://gen.aditor.ai')
    })
    it('posts approved', () => {
      const { win, postMessage } = framed(['https://web.telegram.org'])
      sendAutoreviewEvent({ event: 'approved', request_id: 'r1' }, win)
      expect(postMessage).toHaveBeenCalledWith({ type: 'autoreview', event: 'approved', request_id: 'r1' }, 'https://web.telegram.org')
    })
    it('without a known parent origin posts to each allowlisted origin, never "*"', () => {
      const { win, postMessage } = framed(undefined)
      sendAutoreviewEvent({ event: 'approved', request_id: 'r1' }, win)
      expect(postMessage).toHaveBeenCalledTimes(EMBED_PARENT_ORIGINS.length)
      expect(postMessage.mock.calls.map((c) => c[1])).toEqual(EMBED_PARENT_ORIGINS)
      expect(postMessage.mock.calls.some((c) => c[1] === '*')).toBe(false)
    })
    it('posts nothing for a foreign parent or without a request id', () => {
      const evil = framed(['https://evil.example'])
      expect(sendAutoreviewEvent({ event: 'approved', request_id: 'r1' }, evil.win)).toBe(false)
      const ok = framed(['https://gen.aditor.ai'])
      expect(sendAutoreviewEvent({ event: 'approved', request_id: '' }, ok.win)).toBe(false)
      expect(evil.postMessage).not.toHaveBeenCalled()
      expect(ok.postMessage).not.toHaveBeenCalled()
    })
  })
})
