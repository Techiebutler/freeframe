import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import RequestPage from '../[token]/page'
import { finishRequest, requestReview, uploadToRequest, viewRequest, type RequestAsset } from '@/lib/platform'

// The real uploadToRequest runs against a stubbed network: the bug lives between the page and it.
vi.mock('@/lib/platform', async original => {
  const actual = await original<typeof import('@/lib/platform')>()
  return { ...actual, uploadToRequest: vi.fn(actual.uploadToRequest), finishRequest: vi.fn(), requestReview: vi.fn(), viewRequest: vi.fn() }
})
vi.mock('@/components/review/video-player', () => ({ VideoPlayer: () => <div>Native player</div> }))

const clear: RequestAsset = { asset_id: 'first', name: 'H1.mp4', version: 1, version_id: 'v1', processing: 'ready', media_url: '/h1.mp4', comments: [], review_state: 'clear' }
const files = (...names: string[]) => names.map(name => new File(['bytes'], name, { type: 'video/mp4' }))
const emptyView = { title: 'Launch', brand: 'Northline', brief_excerpt: null, review_share_token: 'share', expires_at: null, assets: [] }

let held: Map<string, () => void>
let completes: { key: string; name?: string; email?: string }[]

/** Each file's s3 key is its filename, so a test can hold or read one file's traffic by name. */
function stubNetwork({ hold = false }: { hold?: boolean } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, opts: RequestInit) => {
    const body = opts.body && typeof opts.body === 'string' ? JSON.parse(opts.body) : {}
    if (url.endsWith('/initiate')) return Response.json({ upload_id: 'u', s3_key: body.original_filename, asset_id: `asset-${body.original_filename}`, version_id: 'v', version_number: 1 })
    if (url.endsWith('/presign-part')) return Response.json({ presigned_url: `https://upload.test/${body.s3_key}` })
    if (url.startsWith('https://upload.test/')) {
      if (hold) await new Promise<void>(resolve => held.set(url.replace('https://upload.test/', ''), resolve))
      return new Response('', { headers: { ETag: 'etag' } })
    }
    if (url.endsWith('/complete')) { completes.push({ key: body.s3_key, name: body.name, email: body.email }); return Response.json({ status: 'processing' }) }
    return Response.json({})
  }))
}
function mount() { render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}><RequestPage params={{ token: 'test' }} /></SWRConfig>) }
const drop = async (...names: string[]) => {
  await screen.findByRole('button', { name: 'Drop your files to begin' })
  fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: files(...names) } })
}
const card = (name: string) => screen.getByText(name).closest('[role="status"]') as HTMLElement
const giveDetails = () => {
  fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Nico' } })
  fireEvent.change(screen.getByLabelText('Your email'), { target: { value: 'nico@example.test' } })
  fireEvent.click(screen.getByRole('button', { name: 'Submit my files' }))
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  held = new Map(); completes = []
  vi.mocked(viewRequest).mockResolvedValue(emptyView)
  vi.mocked(requestReview).mockResolvedValue({ assets: [], gate: { status: 'reviewing', open_must_fixes: 0 }, review_share_token: 'share' })
  vi.mocked(finishRequest).mockResolvedValue({ completed_at: '2026-11-02T06:00:00Z' })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('keeps the whole batch uploading while the editor has not given their details yet', async () => {
  stubNetwork()
  mount()
  await drop('H2.mp4', 'H3.mp4', 'H4.mp4', 'H5.mp4')
  for (const name of ['H2.mp4', 'H3.mp4', 'H4.mp4', 'H5.mp4']) {
    await waitFor(() => expect(within(card(name)).getByText('Uploaded')).toBeVisible())
  }
  expect(screen.queryByText(/Uploading/)).toBeNull()
  expect(screen.queryByRole('progressbar')).toBeNull()
  expect(completes).toEqual([])
})

it('never loses a transferred file: details given later submit every waiting file, then nothing is waiting', async () => {
  stubNetwork()
  mount()
  await drop('H2.mp4', 'H3.mp4', 'H4.mp4')
  await waitFor(() => expect(screen.getAllByText('Uploaded')).toHaveLength(3))
  expect(screen.getAllByText(/waiting for your details/i).length).toBeGreaterThan(0)
  giveDetails()
  await waitFor(() => expect(completes.map(c => c.key).sort()).toEqual(['H2.mp4', 'H3.mp4', 'H4.mp4']))
  expect(completes.every(c => c.name === 'Nico' && c.email === 'nico@example.test')).toBe(true)
})

it('transfers at most two files at once and starts the next as soon as one has its bytes up', async () => {
  stubNetwork({ hold: true })
  mount()
  await drop('H2.mp4', 'H3.mp4', 'H4.mp4')
  await waitFor(() => expect(Array.from(held.keys()).sort()).toEqual(['H2.mp4', 'H3.mp4']))
  expect(within(card('H4.mp4')).getByText('Waiting to upload')).toBeVisible()
  expect(within(card('H2.mp4')).getByText('Uploading…')).toBeVisible()
  await act(async () => { held.get('H3.mp4')!() })
  // H3 still has no details, and that must not hold H4 back.
  await waitFor(() => expect(held.has('H4.mp4')).toBe(true))
  expect(within(card('H3.mp4')).getByText('Uploaded')).toBeVisible()
  expect(within(card('H2.mp4')).getByText('Uploading…')).toBeVisible()
  await act(async () => { held.get('H2.mp4')!(); held.get('H4.mp4')!() })
})

it('with saved details a file reports Submitted while the rest of its batch continues', async () => {
  localStorage.setItem('aditor-request-who', JSON.stringify({ name: 'Nico', email: 'nico@example.test' }))
  stubNetwork({ hold: true })
  mount()
  await drop('H2.mp4', 'H3.mp4', 'H4.mp4')
  await waitFor(() => expect(held.has('H2.mp4')).toBe(true))
  await act(async () => { held.get('H2.mp4')!() })
  await waitFor(() => expect(within(card('H2.mp4')).getByText('Submitted')).toBeVisible())
  expect(completes.map(c => c.key)).toEqual(['H2.mp4'])
  await waitFor(() => expect(held.has('H4.mp4')).toBe(true))
  await act(async () => { held.get('H3.mp4')!(); held.get('H4.mp4')!() })
})

it('does not close the request while a file of the batch still waits for its details', async () => {
  vi.mocked(uploadToRequest).mockImplementationOnce(async (_token, _who, _file, _progress, options) => {
    vi.mocked(viewRequest).mockResolvedValue({ ...emptyView, assets: [{ id: 'first', name: 'H1.mp4' }] })
    vi.mocked(requestReview).mockResolvedValue({ assets: [clear], gate: { status: 'clear', open_must_fixes: 0 }, review_share_token: 'share' })
    options?.onTransferred?.()
    return { asset_id: 'first', version_number: 1 }
  })
  stubNetwork()
  mount()
  await drop('H1.mp4', 'H2.mp4')
  await waitFor(() => expect(within(card('H2.mp4')).getByText('Uploaded')).toBeVisible())
  await waitFor(() => expect(requestReview).toHaveBeenCalled())
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
  expect(finishRequest).not.toHaveBeenCalled()
  expect(screen.queryByText('Your ads were submitted')).toBeNull()
  giveDetails()
  await waitFor(() => expect(finishRequest).toHaveBeenCalledTimes(1))
})

it('keeps every uploaded file when the server refuses the details, and submits them with corrected ones', async () => {
  stubNetwork()
  vi.mocked(fetch).mockImplementation((original => async (url: RequestInfo | URL, opts?: RequestInit) => {
    if (String(url).endsWith('/complete') && JSON.parse(String(opts?.body)).email === 'nico@bad.example') return Response.json({ detail: [] }, { status: 422 })
    return original(url, opts)
  })(vi.mocked(fetch).getMockImplementation()!))
  mount()
  await drop('H2.mp4', 'H3.mp4')
  await waitFor(() => expect(screen.getAllByText('Uploaded')).toHaveLength(2))
  fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Nico' } })
  fireEvent.change(screen.getByLabelText('Your email'), { target: { value: 'nico@bad.example' } })
  fireEvent.click(screen.getByRole('button', { name: 'Submit my files' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Your files are still uploaded')
  expect(screen.getAllByText('Uploaded')).toHaveLength(2)
  expect(screen.queryByText('Try again')).toBeNull()
  giveDetails()
  await waitFor(() => expect(completes.map(c => c.key).sort()).toEqual(['H2.mp4', 'H3.mp4']))
  expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/abort'))).toEqual([])
})

it('warns before the tab closes while files still wait for upload or details', async () => {
  stubNetwork()
  mount()
  await drop('H2.mp4')
  await waitFor(() => expect(within(card('H2.mp4')).getByText('Uploaded')).toBeVisible())
  const leaving = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(leaving)
  expect(leaving.defaultPrevented).toBe(true)
})
