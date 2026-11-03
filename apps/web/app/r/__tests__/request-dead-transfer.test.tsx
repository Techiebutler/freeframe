import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import RequestPage from '../[token]/page'
import { discardUpload, finishRequest, requestReview, uploadToRequest, viewRequest, type RequestAsset } from '@/lib/platform'

// Sandra's card, as the server tells it after the tab went away: the asset exists, its only version never completed.
vi.mock('@/lib/platform', async original => {
  const actual = await original<typeof import('@/lib/platform')>()
  return { ...actual, uploadToRequest: vi.fn(), discardUpload: vi.fn(), finishRequest: vi.fn(), requestReview: vi.fn(), viewRequest: vi.fn() }
})
vi.mock('@/components/review/video-player', () => ({ VideoPlayer: () => <div>Native player</div> }))

const dead: RequestAsset = { asset_id: 'hook1', name: 'Hook1', version: 1, version_id: 'v1', processing: 'uploading', comments: [], review_state: 'upload_incomplete', review_progress: null, versions: [{ id: 'v1', version_number: 1, processing: 'uploading' }] }
const reviewing: RequestAsset = { asset_id: 'hook1', name: 'Hook1', version: 1, version_id: 'v1', processing: 'processing', comments: [], review_state: 'reviewing' }
const clear: RequestAsset = { ...reviewing, processing: 'ready', review_state: 'clear', media_url: '/hook1.mp4' }
const view = { title: 'QoBbPcQZ', brand: 'Forward Health', brief_excerpt: null, review_share_token: 'share', expires_at: null, assets: [{ id: 'hook1', name: 'Hook1' }] }
const reviewOf = (...assets: RequestAsset[]) => ({ assets, gate: { status: 'reviewing' as const, open_must_fixes: 0 }, review_share_token: 'share' })

function mount() { render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}><RequestPage params={{ token: 'test' }} /></SWRConfig>) }
const chooseFiles = (...names: string[]) => fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: names.map(n => new File(['bytes'], n, { type: 'video/mp4' })) } })

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  vi.mocked(viewRequest).mockResolvedValue(view)
  vi.mocked(requestReview).mockResolvedValue(reviewOf(dead))
  vi.mocked(discardUpload).mockResolvedValue(undefined)
  vi.mocked(uploadToRequest).mockResolvedValue({ asset_id: 'hook1', version_number: 2 })
})
afterEach(cleanup)

it('says a dead transfer is a dead transfer, not a review', async () => {
  mount()
  expect(await screen.findByRole('heading', { name: 'Upload not finished' })).toBeVisible()
  expect(screen.getByText(/was not handed in/i)).toBeVisible()
  expect(screen.queryByText('Review in progress')).toBeNull()
  expect(screen.queryByText('Preparing video')).toBeNull()
  expect(screen.queryByRole('progressbar')).toBeNull()
})

it('lets the editor upload a dead file again as the same file', async () => {
  mount()
  fireEvent.click(await screen.findByRole('button', { name: 'Upload it again' }))
  chooseFiles('Hook1.mp4')
  await waitFor(() => expect(uploadToRequest).toHaveBeenCalledTimes(1))
  expect(vi.mocked(uploadToRequest).mock.calls[0][4]).toMatchObject({ assetId: 'hook1' })
})

it('lets the editor add the remaining files beside a dead one', async () => {
  mount()
  await screen.findByRole('heading', { name: 'Upload not finished' })
  fireEvent.click(screen.getByRole('button', { name: 'Add more files' }))
  chooseFiles('Hook2.mp4', 'Hook3.mp4', 'Hook4.mp4', 'Hook5.mp4')
  await waitFor(() => expect(uploadToRequest).toHaveBeenCalledTimes(4))
  for (const call of vi.mocked(uploadToRequest).mock.calls) expect(call[4]?.assetId).toBeUndefined()
})

it('removing the dead file brings back the empty start', async () => {
  mount()
  fireEvent.click(await screen.findByRole('button', { name: 'Remove this file' }))
  vi.mocked(viewRequest).mockResolvedValue({ ...view, assets: [] })
  vi.mocked(requestReview).mockResolvedValue(reviewOf())
  await waitFor(() => expect(discardUpload).toHaveBeenCalledWith('test', { asset_id: 'hook1', version_id: 'v1' }))
  expect(await screen.findByRole('button', { name: 'Drop your files to begin' })).toBeVisible()
})

it('adding files one at a time still works after a first file is in review', async () => {
  vi.mocked(requestReview).mockResolvedValue(reviewOf(reviewing))
  mount()
  await screen.findByText('Review in progress')
  fireEvent.click(screen.getByRole('button', { name: 'Add more files' }))
  chooseFiles('Hook2.mp4')
  await waitFor(() => expect(uploadToRequest).toHaveBeenCalledTimes(1))
  expect(vi.mocked(uploadToRequest).mock.calls[0][4]?.assetId).toBeUndefined()
})

it('a file can join the batch while the first one still waits for details', async () => {
  vi.mocked(viewRequest).mockResolvedValue({ ...view, assets: [] })
  vi.mocked(requestReview).mockResolvedValue(reviewOf())
  vi.mocked(uploadToRequest).mockImplementation((_t, _w, _f, _p, options) => { options?.onTransferred?.(); return new Promise(() => {}) })
  mount()
  await screen.findByRole('button', { name: 'Drop your files to begin' })
  chooseFiles('Hook1.mp4')
  await waitFor(() => expect(screen.getByText('Uploaded')).toBeVisible())
  chooseFiles('Hook2.mp4')
  await waitFor(() => expect(uploadToRequest).toHaveBeenCalledTimes(2))
})

it('says a transferred file is not handed in until the details are in', async () => {
  vi.mocked(viewRequest).mockResolvedValue({ ...view, assets: [] })
  vi.mocked(requestReview).mockResolvedValue(reviewOf())
  vi.mocked(uploadToRequest).mockImplementation((_t, _w, _f, _p, options) => { options?.onTransferred?.(); void options?.identity?.(); return new Promise(() => {}) })
  mount()
  await screen.findByRole('button', { name: 'Drop your files to begin' })
  chooseFiles('Hook1.mp4')
  expect(await screen.findByText(/Not handed in yet/)).toHaveTextContent('Submit my files')
})

it('does not close the request under an editor who opened the add-more screen', async () => {
  vi.mocked(requestReview).mockResolvedValue(reviewOf(reviewing))
  mount()
  await screen.findByText('Review in progress')
  fireEvent.click(screen.getByRole('button', { name: 'Add more files' }))
  await screen.findByRole('button', { name: /Drop more files/ })
  vi.mocked(requestReview).mockResolvedValue({ ...reviewOf(clear), gate: { status: 'clear', open_must_fixes: 0 } })
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(finishRequest).not.toHaveBeenCalled()
})
