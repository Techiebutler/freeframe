import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import RequestPage from '../[token]/page'
import { finishRequest, requestReview, uploadToRequest, viewRequest, type RequestAsset } from '@/lib/platform'

// The editor who waits for Hook1 to pass before adding Hook2: the request closed itself in between.
vi.mock('@/lib/platform', async original => {
  const actual = await original<typeof import('@/lib/platform')>()
  return { ...actual, uploadToRequest: vi.fn(), finishRequest: vi.fn(), requestReview: vi.fn(), viewRequest: vi.fn() }
})
vi.mock('@/components/review/video-player', () => ({ VideoPlayer: () => <div>Native player</div> }))

const hook1: RequestAsset = { asset_id: 'hook1', name: 'Hook1', version: 1, version_id: 'v1', processing: 'ready', media_url: '/hook1.mp4', comments: [], review_state: 'clear' }
const hook2: RequestAsset = { asset_id: 'hook2', name: 'Hook2', version: 1, version_id: 'v2', processing: 'processing', comments: [], review_state: 'reviewing' }
const baseView = { title: 'Card', brand: 'Forward Health', brief_excerpt: null, review_share_token: 'share', expires_at: null }
const closed = { ...baseView, completed_at: '2026-11-03T06:00:00Z', assets: [{ id: 'hook1', name: 'Hook1' }] }
const reopened = { ...baseView, completed_at: null, assets: [{ id: 'hook1', name: 'Hook1' }, { id: 'hook2', name: 'Hook2' }] }
const reviewOf = (assets: RequestAsset[], status: 'reviewing' | 'clear', completed_at: string | null = null) => ({ assets, gate: { status, open_must_fixes: 0 }, review_share_token: 'share', completed_at })

function mount() { render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}><RequestPage params={{ token: 'test' }} /></SWRConfig>) }
const chooseFiles = (...names: string[]) => fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: names.map(n => new File(['bytes'], n, { type: 'video/mp4' })) } })
const addButton = () => screen.findByRole('button', { name: 'Add more files' })

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.setItem('aditor-request-who', JSON.stringify({ name: 'Sandra', email: 'sandra@example.com' }))
  vi.mocked(viewRequest).mockResolvedValue(closed)
  vi.mocked(requestReview).mockResolvedValue(reviewOf([hook1], 'clear', closed.completed_at))
  vi.mocked(finishRequest).mockResolvedValue({ completed_at: '2026-11-03T07:00:00Z' })
})
afterEach(() => { cleanup(); localStorage.clear() })

it('offers a way to add files on a completed request', async () => {
  mount()
  expect(await screen.findByText('Your ads were submitted')).toBeVisible()
  expect(await addButton()).toBeVisible()
  expect(document.querySelector('input[type=file]')).toBeNull()
})

it('add more files opens the drop zone, says what happens to the finished files, and Back returns', async () => {
  mount()
  fireEvent.click(await addButton())
  expect(document.querySelector('input[type=file]')).not.toBeNull()
  expect(screen.getByText(/Files already handed in keep their result/)).toBeVisible()
  expect(screen.queryByText('Your ads were submitted')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /Back/ }))
  expect(await screen.findByText('Your ads were submitted')).toBeVisible()
})

it('a new file leaves the finished page for the normal review, and finish runs again when everything passes', async () => {
  mount()
  fireEvent.click(await addButton())
  vi.mocked(uploadToRequest).mockImplementation(async () => {
    // The server cleared completed_at when the file landed.
    vi.mocked(viewRequest).mockResolvedValue(reopened)
    vi.mocked(requestReview).mockResolvedValue(reviewOf([hook1, hook2], 'reviewing'))
    return { asset_id: 'hook2', version_number: 1 }
  })
  chooseFiles('Hook2.mp4')
  expect(await screen.findByRole('heading', { name: 'Review in progress' })).toBeVisible()
  expect(screen.queryByText('Your ads were submitted')).toBeNull()
  expect(finishRequest).not.toHaveBeenCalled()

  vi.mocked(requestReview).mockResolvedValue(reviewOf([hook1, { ...hook2, processing: 'ready', media_url: '/hook2.mp4', review_state: 'clear' }], 'clear'))
  fireEvent.click(screen.getByRole('button', { name: 'Refresh video' }))
  await waitFor(() => expect(finishRequest).toHaveBeenCalledTimes(1))
  expect(await screen.findByText('Your ads were submitted')).toBeVisible()
})

it('a page whose own finish closed the request can reopen and finish again', async () => {
  vi.mocked(viewRequest).mockResolvedValue({ ...baseView, completed_at: null, assets: [{ id: 'hook1', name: 'Hook1' }] })
  vi.mocked(requestReview).mockResolvedValue(reviewOf([hook1], 'clear'))
  mount()
  expect(await screen.findByText('Your ads were submitted')).toBeVisible()
  expect(finishRequest).toHaveBeenCalledTimes(1)
  fireEvent.click(await addButton())
  vi.mocked(uploadToRequest).mockImplementation(async () => {
    vi.mocked(viewRequest).mockResolvedValue(reopened)
    vi.mocked(requestReview).mockResolvedValue(reviewOf([hook1, hook2], 'reviewing'))
    return { asset_id: 'hook2', version_number: 1 }
  })
  chooseFiles('Hook2.mp4')
  expect(await screen.findByRole('heading', { name: 'Review in progress' })).toBeVisible()
  expect(screen.queryByText('Your ads were submitted')).toBeNull()
})

it('a failed file stays on screen to retry instead of falling back to the finished page', async () => {
  mount()
  fireEvent.click(await addButton())
  vi.mocked(uploadToRequest).mockRejectedValue(new Error('Upload stopped. Try again.'))
  chooseFiles('Hook2.mp4')
  expect(await screen.findByText(/Upload stopped/)).toBeVisible()
  expect(screen.queryByText('Your ads were submitted')).toBeNull()
  expect(screen.getByRole('button', { name: /try again/i })).toBeVisible()
})

it('a review that cannot be re-read after the reopen never shows the file as finished', async () => {
  mount()
  fireEvent.click(await addButton())
  vi.mocked(uploadToRequest).mockImplementation(async () => {
    vi.mocked(viewRequest).mockResolvedValue(reopened)
    vi.mocked(requestReview).mockRejectedValue(new Error('offline'))
    return { asset_id: 'hook2', version_number: 1 }
  })
  chooseFiles('Hook2.mp4')
  await waitFor(() => expect(screen.queryByText('Your ads were submitted')).toBeNull())
  await waitFor(() => expect(vi.mocked(uploadToRequest)).toHaveBeenCalled())
  await new Promise(r => setTimeout(r, 50))
  expect(screen.queryByText('Your ads were submitted')).toBeNull()
  expect(finishRequest).not.toHaveBeenCalled()
})
