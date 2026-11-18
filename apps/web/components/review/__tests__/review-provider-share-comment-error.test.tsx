import React from 'react'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useReviewStore } from '@/stores/review-store'
import { ReviewProvider, useReview } from '../review-provider'

// A failed share-link comment or reply has to say why (#439): the inline reply
// box shows the thrown Error's message, so addComment must carry the server's
// `detail` instead of a fixed string.

type Reply = { ok: boolean; status: number; json: () => Promise<unknown> }

function respond(status: number, body: unknown): Reply {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => (body === undefined ? Promise.reject(new SyntaxError('no body')) : Promise.resolve(body)),
  }
}

let postReply: Reply

beforeEach(() => {
  useReviewStore.getState().reset()
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && url.includes('/share/tok/comment')) return postReply
    // Mount-time reads (stream, versions, comments): not under test.
    return respond(404, {})
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function renderShareProvider() {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <ReviewProvider assetId="a1" shareToken="tok">{children}</ReviewProvider>
  )
  return renderHook(() => useReview(), { wrapper })
}

async function postAndCatch() {
  const { result } = renderShareProvider()
  await waitFor(() => expect(result.current.isLoading).toBe(false))
  return result.current.addComment({ body: 'a reply', parent_id: 'p1' }).then(
    () => { throw new Error('addComment resolved') },
    (e: unknown) => e as Error,
  )
}

describe('ReviewProvider addComment on a share link', () => {
  it("throws the server's detail, so a failed reply can say why", async () => {
    postReply = respond(400, { detail: 'Parent comment not found on this asset' })
    const err = await postAndCatch()
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('Parent comment not found on this asset')
  })

  it('falls back when the error body is not JSON', async () => {
    postReply = respond(502, undefined)
    const err = await postAndCatch()
    expect(err.message).toBe('Failed to post comment')
  })

  it("falls back when detail is not a string (a 422's list)", async () => {
    postReply = respond(422, { detail: [{ loc: ['body', 'body'], msg: 'field required' }] })
    const err = await postAndCatch()
    expect(err.message).toBe('Failed to post comment')
  })
})
