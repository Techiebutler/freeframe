import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { setTokens, signInAgain } from '@/lib/auth'
import { resetShareRequestState } from '@/lib/share-request'
import { useReviewStore } from '@/stores/review-store'
import { ShareReviewScreen } from '../share-review-screen'

vi.mock('@/components/review/image-viewer', () => ({ ImageViewer: () => null }))
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/auth')>(),
  signInAgain: vi.fn(),
}))

const guest = { name: 'Guest', email: 'guest@example.test' }
const storeGuest = () => localStorage.setItem('ff_guest_identity', JSON.stringify(guest))
const parentComment = {
  id: 'parent', asset_id: 'a1', version_id: 'v1', parent_id: null,
  author: { id: 'u1', name: 'Reviewer' }, body: 'Parent note',
  timecode_start: null, timecode_end: null, resolved: false, visibility: 'public',
  created_at: '2026-01-01T10:00:00Z', updated_at: '2026-01-01T10:00:00Z',
  replies: [], reactions: [], attachments: [],
}

const jwt = (secondsUntilExpiry: number) =>
  `header.${btoa(JSON.stringify({ sub: 'member', exp: Math.floor(Date.now() / 1000) + secondsUntilExpiry }))}.signature`

beforeEach(() => {
  resetShareRequestState()
  vi.clearAllMocks()
  useReviewStore.getState().reset()
  Element.prototype.scrollIntoView = vi.fn()
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

function startReview(status: number, comments: object[] = []) {
  const expired = jwt(-60)
  const fresh = jwt(600)
  setTokens(expired, 'refresh-token')

  const writes: Array<[string, string | null, object?]> = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const { pathname } = new URL(url)
    if (pathname === '/auth/refresh') {
      writes.push(['refresh', null])
      return Response.json({ access_token: fresh }, { status })
    }
    if (pathname === '/share/tok/comment' && init?.method === 'POST') {
      const bearer = new Headers(init.headers).get('Authorization')
      const payload = JSON.parse(String(init.body))
      writes.push(['comment', bearer, payload])
      return Response.json({ id: 'c1', body: payload.body, guest_name: payload.guest_name ?? null })
    }
    if (pathname === '/share/tok/stream/a1') {
      return Response.json({ name: 'Still', asset_type: 'image', version_id: 'v1' })
    }
    if (pathname.endsWith('/versions')) {
      return Response.json([{ id: 'v1', version_number: 1, processing_status: 'ready', created_at: '' }])
    }
    if (pathname === '/share/tok/comments') return Response.json(comments)
    return new Response(null, { status: 404 })
  }))

  render(<ShareReviewScreen token="tok" assetId="a1" assetName="Still"
    permission="comment" allowDownload={false} showVersions={false} />)
  return { writes, fresh }
}

async function submitDraft() {
  // The review screen loads the composer and other controls with dynamic imports.
  const input = await screen.findByPlaceholderText('Leave your comment...', {}, { timeout: 4000 })
  input.focus()
  fireEvent.change(input, { target: { value: 'Looks good' } })
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
  return input
}

it.each([
  { status: 200, error: null },
  { status: 401, error: 'Your sign-in has expired.' },
  { status: 503, error: "Couldn't reach the server. Try again." },
])('keeps the member identity when refresh returns $status', async ({ status, error }) => {
  storeGuest()
  const { writes, fresh } = startReview(status)
  const input = await submitDraft()

  if (status === 401) {
    const dialog = await screen.findByRole('dialog')
    expect(writes).toEqual([['refresh', null]])
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  }
  if (error) {
    await screen.findByText(error, { exact: false })
    expect(input).toHaveValue('Looks good')
    expect(writes).toEqual([['refresh', null]])
  } else {
    await waitFor(() => expect(input).toHaveValue(''))
    expect(writes).toEqual([['refresh', null], ['comment', `Bearer ${fresh}`, { asset_id: 'a1', version_id: 'v1', body: 'Looks good' }]])
  }
})

it('signs in again with the current share path and sends no comment', async () => {
  const { writes } = startReview(401)
  const previousUrl = window.location.href
  window.history.replaceState(null, '', '/share/tok?asset=a1')
  try {
    const input = await submitDraft()
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('link', { name: 'Sign in' }))
    expect(signInAgain).toHaveBeenCalledWith('/share/tok?asset=a1')
    expect(writes).toEqual([['refresh', null]])
    expect(input).toHaveValue('Looks good')
  } finally {
    window.history.replaceState(null, '', previousUrl)
  }
})

it.each([false, true])('continues as guest on a comment link (stored guest: %s)', async (stored) => {
  if (stored) storeGuest()
  const { writes } = startReview(401)
  const input = await submitDraft()
  const dialog = await screen.findByRole('dialog')
  expect(writes).toEqual([['refresh', null]])
  fireEvent.click(within(dialog).getByRole('button', { name: 'Continue as guest' }))
  if (!stored) {
    expect(await screen.findByText('Enter your name and email to comment on this shared asset.')).toBeInTheDocument()
    expect(writes).toEqual([['refresh', null]])
    fireEvent.change(screen.getByPlaceholderText('Your name'), { target: { value: guest.name } })
    fireEvent.change(screen.getByPlaceholderText('Email address'), { target: { value: guest.email } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  }
  await waitFor(() => expect(input).toHaveValue(''))
  expect(screen.queryByPlaceholderText('Your name')).toBeNull()
  expect(writes).toEqual([['refresh', null], ['comment', null, {
    asset_id: 'a1', version_id: 'v1', body: 'Looks good', guest_name: guest.name, guest_email: guest.email,
  }]])
})

it('keeps a second Enter out of the composer while the sign-in prompt is open', async () => {
  storeGuest()
  const { writes } = startReview(401)
  const input = await submitDraft()
  const dialog = await screen.findByRole('dialog', { name: 'Your sign-in has expired.' })
  const cancel = within(dialog).getByRole('button', { name: 'Cancel' })
  const focused = document.activeElement ?? document.body

  // Dispatch the keydown without activating the focused button, then choose the guest action.
  await act(async () => { fireEvent.keyDown(focused, { key: 'Enter' }) })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Continue as guest' }))

  await waitFor(() => expect(input).toHaveValue(''))
  expect(screen.queryByText('Your sign-in has expired.', { exact: false })).not.toBeInTheDocument()
  expect(focused).toBe(cancel)
  expect(writes).toEqual([['refresh', null], ['comment', null, {
    asset_id: 'a1', version_id: 'v1', body: 'Looks good', guest_name: guest.name, guest_email: guest.email,
  }]])
})

it('keeps a typed inline reply when Escape is pressed in the sign-in prompt', async () => {
  const user = userEvent.setup()
  startReview(401, [parentComment])
  await user.click(await screen.findByRole('button', { name: 'Reply' }))
  const input = screen.getByPlaceholderText('Leave your reply here...')
  await user.type(input, 'A reply{Enter}')
  const dialog = await screen.findByRole('dialog', { name: 'Your sign-in has expired.' })
  const cancel = within(dialog).getByRole('button', { name: 'Cancel' })

  await user.keyboard('{Escape}')

  expect(screen.getByPlaceholderText('Leave your reply here...')).toHaveValue('A reply')
  expect(cancel).toHaveFocus()
})

it('keeps an inline reply and its error when the guest identity prompt is cancelled', async () => {
  const { writes } = startReview(401, [parentComment])
  fireEvent.click(await screen.findByRole('button', { name: 'Reply' }))
  const input = screen.getByPlaceholderText('Leave your reply here...')
  fireEvent.change(input, { target: { value: 'A reply' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  const dialog = await screen.findByRole('dialog', { name: 'Your sign-in has expired.' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Continue as guest' }))
  const identity = await screen.findByRole('dialog', { name: 'Leave a comment' })
  fireEvent.click(within(identity).getByRole('button', { name: 'Cancel' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('Your sign-in has expired.')
  expect(input).toHaveValue('A reply')
  expect(writes).toEqual([['refresh', null]])

  fireEvent.keyDown(input, { key: 'Enter' })
  expect(await screen.findByRole('dialog', { name: 'Your sign-in has expired.' })).toBeInTheDocument()
  expect(writes).toEqual([['refresh', null]])
})
