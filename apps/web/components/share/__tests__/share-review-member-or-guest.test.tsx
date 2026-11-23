import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { setTokens } from '@/lib/auth'
import { useReviewStore } from '@/stores/review-store'
import { ShareReviewScreen } from '../share-review-screen'

vi.mock('@/components/review/image-viewer', () => ({ ImageViewer: () => null }))

const jwt = (secondsUntilExpiry: number) =>
  `header.${btoa(JSON.stringify({ sub: 'member', exp: Math.floor(Date.now() / 1000) + secondsUntilExpiry }))}.signature`

beforeEach(() => {
  useReviewStore.getState().reset()
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: true, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, dispatchEvent: () => false,
  }))
})

afterEach(() => {
  localStorage.clear()
  document.cookie = 'ff_access_token=; path=/; max-age=0'
  document.cookie = 'ff_refresh_token=; path=/; max-age=0'
  vi.unstubAllGlobals()
})

it.each([
  { status: 200, error: null },
  { status: 401, error: 'Your sign-in has expired.' },
  { status: 503, error: "Couldn't reach the server. Try again." },
])('keeps the member identity when refresh returns $status', async ({ status, error }) => {
  const expired = jwt(-60)
  const fresh = jwt(600)
  setTokens(expired, 'refresh-token')
  localStorage.setItem('ff_guest_identity', JSON.stringify({ name: 'Guest', email: 'guest@example.test' }))

  const writes: Array<[string, string | null]> = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const { pathname } = new URL(url)
    if (pathname === '/auth/refresh') {
      writes.push(['refresh', null])
      return Response.json({ access_token: fresh }, { status })
    }
    if (pathname === '/share/tok/comment' && init?.method === 'POST') {
      const bearer = new Headers(init.headers).get('Authorization')
      writes.push(['comment', bearer])
      // The share endpoint accepts a guest identity if the bearer is expired.
      return Response.json({ id: 'c1', body: 'Looks good', guest_name: bearer === `Bearer ${fresh}` ? null : 'Guest' })
    }
    if (pathname === '/share/tok/stream/a1') {
      return Response.json({ name: 'Still', asset_type: 'image', version_id: 'v1' })
    }
    if (pathname.endsWith('/versions')) {
      return Response.json([{ id: 'v1', version_number: 1, processing_status: 'ready', created_at: '' }])
    }
    if (pathname === '/share/tok/comments') return Response.json([])
    return new Response(null, { status: 404 })
  }))

  render(<ShareReviewScreen token="tok" assetId="a1" assetName="Still"
    permission="comment" allowDownload={false} showVersions={false} />)
  const input = await screen.findByPlaceholderText('Leave your comment...')
  fireEvent.change(input, { target: { value: 'Looks good' } })
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })

  if (error) {
    await screen.findByText(error, { exact: false })
    expect(input).toHaveValue('Looks good')
    expect(writes).toEqual([['refresh', null]])
  } else {
    await waitFor(() => expect(input).toHaveValue(''))
    expect(writes).toEqual([['refresh', null], ['comment', `Bearer ${fresh}`]])
  }
})
