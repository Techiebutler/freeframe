/**
 * The Uploads panel as the upload queue shows it (spec goal 14, "Row lifecycle").
 *
 * A file that is dropped waits for its turn, and until then the panel is the one
 * place that says so: "Waiting to start" with no progress bar, "Waiting for
 * storage" on the row that is the hold's probe, "Waiting to resume" on a resume
 * that has not begun. Rows are listed the way they will start (the newest drop
 * first, and within a drop the first to start at the top). A refused row offers
 * Retry only while this tab still holds its `File`, and every failed row can be
 * dismissed.
 *
 * These run against the real store and a fake server, so what the panel shows
 * is what the queue actually did. The API is mocked but `ApiError` is the real
 * one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Leaving the Active tab switches on the panel's infinite scroll, which jsdom
// has no implementation for.
vi.stubGlobal(
  'IntersectionObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
)
import { render, screen, within, fireEvent, act } from '@testing-library/react'

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  api: { post: vi.fn(), get: vi.fn(), patch: vi.fn() },
}))
vi.mock('swr', () => ({ mutate: vi.fn() }))

import { api, ApiError } from '@/lib/api'
import { UploadsPanel } from '../uploads-panel'
import { useUploadStore, __uploadQueueTesting as testing } from '@/stores/upload-store'
import { signInAs, row } from '@/test/upload-session'
import {
  MB, fakeServer, fileOf, small, drop, rowOf, stored, settle, rehydrate, resumable,
} from '@/test/upload-queue-server'

/** Every row of the open panel, top to bottom. */
const panelRows = () => screen.queryAllByTestId('upload-row')
const nameOf = (r: HTMLElement) => (r.querySelector('button[title="Rename"], p.font-medium')?.textContent ?? '')
const names = () => panelRows().map(nameOf)
const rowNamed = (name: string) => {
  const found = panelRows().find((r) => nameOf(r) === name)
  if (!found) throw new Error(`no row named ${name}; rows: ${names().join(', ')}`)
  return found
}

/** Opens the panel on a tab. It opens on Active, as it does for the user. */
function openPanel(tab: 'Active' | 'All' | 'Failed' = 'Active') {
  useUploadStore.setState({ panelOpen: true, historyLoaded: true, historyHasMore: false })
  const view = render(<UploadsPanel />)
  if (tab !== 'Active') fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${tab}`) }))
  return view
}

/** The date headings of the open panel, top to bottom. */
const headings = () => screen.queryAllByTestId('upload-group').map((h) => h.textContent)

const cancelAllQueued = () => screen.queryByRole('button', { name: 'Cancel all queued' })
const resumeButton = () => screen.queryByTitle(/^Resume/)
const retryButton = (scope: HTMLElement | Document = document) => within(scope as HTMLElement).queryByTitle('Retry')
const dismissButton = (scope: HTMLElement) => within(scope).queryByTitle('Dismiss')
const KEPT_DISMISS = 'Dismiss (the partial upload stays on the server until it is cleaned up)'

beforeEach(() => {
  vi.clearAllMocks()
  testing.reset()
  window.localStorage.clear()
  useUploadStore.setState({
    files: [], versionsRevision: 0, panelOpen: false, historyLoaded: true, historyHasMore: false,
  })
  vi.mocked(api.get).mockResolvedValue([] as never)
  signInAs('user-1')
})

afterEach(() => {
  vi.useRealTimers()
  testing.reset()
})

// ---------------------------------------------------------------- what a row says

describe('what a queued row says', () => {
  it('queued rows show Waiting to start and no progress bar', async () => {
    const server = fakeServer(() => 'wait', 'hang')
    const [a] = drop([fileOf('a.mov'), fileOf('b.mov')])
    await settle()
    openPanel()

    // b has not had its turn: nothing on the server, nothing to measure.
    const b = rowNamed('b')
    expect(within(b).getByText('Waiting to start')).toBeInTheDocument()
    expect(within(b).getByText('Queued')).toBeInTheDocument()
    expect(within(b).queryByRole('progressbar')).toBeNull()
    // a is starting, which is not sending either.
    expect(within(rowNamed('a')).getByText('Starting…')).toBeInTheDocument()
    expect(within(rowNamed('a')).queryByRole('progressbar')).toBeNull()

    // And the bar is there once bytes are going (the query would find it).
    await act(async () => {
      server.initiates[0].resolve()
      await settle()
    })
    expect(rowOf(a).status).toBe('uploading')
    expect(within(rowNamed('a')).getByRole('progressbar')).toBeInTheDocument()
    expect(within(rowNamed('b')).getByText('Waiting to start')).toBeInTheDocument()
    expect(within(rowNamed('b')).queryByRole('progressbar')).toBeNull()
  })

  it('the probe row shows Waiting for storage', async () => {
    fakeServer((_, i) => (
      i === 0
        ? new ApiError(503, 'Storage is not answering', { code: 'storage_unavailable', retryAfter: 5 })
        : 'wait'
    ))
    drop([fileOf('a.mov'), fileOf('b.mov')])
    await settle()
    openPanel()

    // a's initiate was answered with a hold: it is the probe, and it is the one
    // row that says why. b is simply waiting behind it.
    expect(within(rowNamed('a')).getByText('Waiting for storage')).toBeInTheDocument()
    expect(within(rowNamed('a')).queryByText('Waiting to start')).toBeNull()
    expect(within(rowNamed('b')).getByText('Waiting to start')).toBeInTheDocument()
  })

  it('the probe row shows Waiting for connection when the request never arrived', async () => {
    fakeServer((_, i) => (i === 0 ? new TypeError('Failed to fetch') : 'wait'))
    drop([fileOf('a.mov'), fileOf('b.mov')])
    await settle()
    openPanel()

    expect(within(rowNamed('a')).getByText('Waiting for connection')).toBeInTheDocument()
    expect(within(rowNamed('b')).getByText('Waiting to start')).toBeInTheDocument()
  })

  const waiting: Array<{
    name: string
    patch: Partial<import('@/stores/upload-store').UploadFile>
    status: string
    text: string
    detail: string
  }> = [
    { name: 'queued', patch: { status: 'queued' }, status: 'queued', text: 'Waiting to start', detail: 'waiting-to-start' },
    { name: 'the probe, storage', patch: { status: 'queued', holdReason: 'storage' }, status: 'queued', text: 'Waiting for storage', detail: 'waiting-for-storage' },
    { name: 'the probe, connection', patch: { status: 'queued', holdReason: 'connection' }, status: 'queued', text: 'Waiting for connection', detail: 'waiting-for-connection' },
    { name: 'a queued resume', patch: { status: 'interrupted', queuedResume: true }, status: 'interrupted', text: 'Waiting to resume', detail: 'waiting-to-resume' },
    { name: 'the probe, a resume', patch: { status: 'interrupted', queuedResume: true, holdReason: 'storage' }, status: 'interrupted', text: 'Waiting for storage', detail: 'waiting-for-storage' },
    { name: 'initiating', patch: { status: 'starting' }, status: 'starting', text: 'Starting…', detail: 'starting' },
    { name: 'resuming', patch: { status: 'starting', resuming: true }, status: 'starting', text: 'Resuming…', detail: 'resuming' },
  ]

  it.each(waiting)('$name reads "$text" and carries data-status and data-detail', ({ patch, status, text, detail }) => {
    useUploadStore.setState({ files: [row({ id: 'x', versionId: 'v', ...patch })] })
    openPanel('All')

    const r = screen.getByTestId('upload-row')
    expect(r).toHaveAttribute('data-status', status)
    expect(r).toHaveAttribute('data-detail', detail)
    expect(within(r).getByText(text)).toBeInTheDocument()
    expect(within(r).queryByRole('progressbar')).toBeNull()
    // The existing classes the e2e fixtures still select on stay.
    expect(r.className).toContain('group')
    expect(r.className).toContain('items-start')
  })

  it('a row that is moving carries its own detail kind', () => {
    useUploadStore.setState({
      files: [
        row({ id: 'u', assetName: 'u', status: 'uploading', progress: 40, versionId: 'v1' }),
        row({ id: 'f', assetName: 'f', status: 'uploading', progress: 95, finalizing: true, versionId: 'v2' }),
        row({ id: 'p', assetName: 'p', status: 'processing', processingProgress: 10, versionId: 'v3' }),
        row({ id: 'e', assetName: 'e', status: 'elsewhere', versionId: 'v4' }),
        row({ id: 'i', assetName: 'i', status: 'interrupted', versionId: 'v5' }),
        row({ id: 'x', assetName: 'x', status: 'failed', error: 'No', failedBeforeStart: true }),
        row({ id: 'c', assetName: 'c', status: 'complete', versionId: 'v6' }),
      ],
    })
    openPanel('All')

    const kinds = Object.fromEntries(
      panelRows().map((r) => [nameOf(r), `${r.getAttribute('data-status')}/${r.getAttribute('data-detail')}`]),
    )
    expect(kinds).toEqual({
      u: 'uploading/uploading',
      f: 'uploading/finalizing',
      p: 'processing/processing',
      e: 'elsewhere/elsewhere',
      i: 'interrupted/interrupted',
      x: 'failed/failed',
      c: 'complete/complete',
    })
  })
})

// ---------------------------------------------------------------- order

describe('the panel header', () => {
  const header = () => screen.getByRole('heading', { name: /^Uploads/ })

  it('counts the files running apart from the ones waiting: "3 active · 2 queued"', async () => {
    fakeServer(() => 'wait')
    drop([small('a.jpg'), small('b.jpg'), small('c.jpg'), small('d.jpg'), small('e.jpg')])
    await settle()
    openPanel()

    expect(header()).toHaveTextContent(/^Uploads3 active · 2 queued$/)
  })

  it('says only "N active" with nothing queued, and only "N queued" with nothing running', async () => {
    const server = fakeServer(() => 'wait')
    drop([small('a.jpg'), small('b.jpg')])
    await settle()
    const { unmount } = openPanel()
    expect(header()).toHaveTextContent(/^Uploads2 active$/)
    unmount()

    useUploadStore.setState({ files: [row({ id: 'r', status: 'interrupted', queuedResume: true, versionId: 'rv' })] })
    openPanel()
    expect(header()).toHaveTextContent(/^Uploads1 queued$/)
    expect(server.names()).toEqual(['a.jpg', 'b.jpg'])
  })
})

describe('the order of the rows', () => {
  it('rows of one drop list in start order', async () => {
    fakeServer(() => 'wait')
    drop([fileOf('a.mov'), fileOf('b.mov'), fileOf('c.mov')])
    await settle()
    openPanel()

    // Newest first is how the store keeps them (c, b, a); the panel lists the
    // one that starts first at the top.
    expect(names()).toEqual(['a', 'b', 'c'])
  })

  it('two drops list newest drop first', async () => {
    fakeServer(() => 'wait')
    drop([fileOf('a.mov'), fileOf('b.mov')])
    drop([fileOf('c.mov'), fileOf('d.mov')])
    await settle()
    openPanel()

    expect(names()).toEqual(['c', 'd', 'a', 'b'])
  })

  it('a row resumed after a drop is a newer drop and lists first', async () => {
    fakeServer(() => 'wait')
    useUploadStore.setState({
      files: [row({ id: 'r', assetName: 'r', status: 'interrupted', assetId: 'ra', versionId: 'rv', uploadId: 'ru', s3Key: 'rk', fileSize: 50 * MB })],
    })
    drop([fileOf('a.mov'), fileOf('b.mov')])
    await settle()
    // a is starting, b waits: the resume goes behind a and ahead of b in the
    // queue, and is a drop of its own, so it lists first.
    act(() => useUploadStore.getState().resumeUpload('r', fileOf('clip.mp4', 50 * MB)))
    openPanel('All')

    expect(names()).toEqual(['r', 'a', 'b'])
  })

  it('rows saved by an earlier page load list after a new drop', async () => {
    fakeServer(() => 'wait')
    // Sequence numbers are handed out per page load. Saved with the row they
    // would outrank this load's first drop, which starts again from 1.
    const saved = rehydrate([
      row({ id: 'old', assetName: 'old', status: 'interrupted', assetId: 'oa', versionId: 'ov', uploadId: 'ou', dropSeq: 90, queueSeq: 90 }),
    ])
    expect(saved[0].dropSeq).toBeUndefined()
    expect(saved[0].queueSeq).toBeUndefined()
    useUploadStore.setState({ files: saved })

    drop([fileOf('a.mov'), fileOf('b.mov')])
    await settle()
    openPanel('All')

    expect(names()).toEqual(['a', 'b', 'old'])
    // What is written for the next load carries no sequence number either.
    expect(stored().every((f) => f.dropSeq === undefined && f.queueSeq === undefined)).toBe(true)
  })

  it('history rows follow the queue, newest first', () => {
    useUploadStore.setState({
      files: [
        row({ id: 'h1', assetName: 'h1', status: 'complete', createdAt: 1000, fromHistory: true }),
        row({ id: 'h2', assetName: 'h2', status: 'complete', createdAt: 2000, fromHistory: true }),
        row({ id: 'q', assetName: 'q', status: 'queued', createdAt: 500, dropSeq: 1, queueSeq: 1 }),
      ],
    })
    openPanel('All')

    expect(names()).toEqual(['q', 'h2', 'h1'])
  })
})

describe('the date headings follow the order of the list', () => {
  const DAY = 86_400_000
  const oldLabel = (at: number) => new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

  it('an old row resumed now lists under Today, ahead of a drop made before it', async () => {
    fakeServer(() => 'wait')
    const old = Date.now() - 3 * DAY
    useUploadStore.setState({
      files: [
        row({
          id: 'r', assetName: 'r', status: 'interrupted', createdAt: old,
          assetId: 'ra', versionId: 'rv', uploadId: 'ru', s3Key: 'rk', fileSize: 50 * MB,
        }),
        row({ id: 'h', assetName: 'h', status: 'complete', createdAt: old, fromHistory: true }),
      ],
    })
    // a is starting and b waits; the resume is a drop of its own, so it lists
    // first -- although the row is three days old.
    drop([fileOf('a.mov'), fileOf('b.mov')])
    await settle()
    act(() => useUploadStore.getState().resumeUpload('r', fileOf('clip.mp4', 50 * MB)))
    openPanel('All')

    expect(names()).toEqual(['r', 'a', 'b', 'h'])
    // One Today heading above everything that was queued or started this load,
    // and the older day below it: never the old date above the newest drop.
    expect(headings()).toEqual(['Today', oldLabel(old)])
    // And each row sits under the heading of its own group.
    const groups = screen.getAllByTestId('upload-group').map((h) => h.parentElement!.parentElement!)
    expect(within(groups[0]).getAllByTestId('upload-row').map(nameOf)).toEqual(['r', 'a', 'b'])
    expect(within(groups[1]).getAllByTestId('upload-row').map(nameOf)).toEqual(['h'])
  })

  it('rows that are not part of the queue keep their own days, newest first', () => {
    const now = Date.now()
    useUploadStore.setState({
      files: [
        row({ id: 'old', assetName: 'old', status: 'complete', createdAt: now - 5 * DAY, fromHistory: true }),
        row({ id: 'yesterday', assetName: 'yesterday', status: 'complete', createdAt: now - DAY, fromHistory: true }),
        row({ id: 'today', assetName: 'today', status: 'complete', createdAt: now, fromHistory: true }),
        row({ id: 'q', assetName: 'q', status: 'queued', createdAt: now, dropSeq: 1, queueSeq: 1 }),
      ],
    })
    openPanel('All')

    expect(names()).toEqual(['q', 'today', 'yesterday', 'old'])
    expect(headings()).toEqual(['Today', 'Yesterday', oldLabel(now - 5 * DAY)])
  })
})

// ---------------------------------------------------------------- Cancel all queued

describe('Cancel all queued', () => {
  it('Cancel all queued appears only while something is queued', async () => {
    fakeServer(() => 'wait')
    openPanel()
    expect(cancelAllQueued()).toBeNull()

    // One file starting alone: it has had its turn, so nothing is waiting.
    let a!: string
    await act(async () => {
      ;[a] = drop([fileOf('a.mov')])
      await settle()
    })
    expect(cancelAllQueued()).toBeNull()

    // A second one waits behind it.
    await act(async () => {
      drop([fileOf('b.mov')])
      await settle()
    })
    expect(cancelAllQueued()).toBeInTheDocument()

    // It gives up the waiting row and leaves the one that has started alone.
    fireEvent.click(cancelAllQueued()!)
    expect(names()).toEqual(['a'])
    expect(rowOf(a).status).toBe('starting')
    expect(cancelAllQueued()).toBeNull()
  })

  it('is also offered for a resume waiting for its turn, and not for rows nobody waits on', () => {
    useUploadStore.setState({
      files: [
        row({ id: 'u', assetName: 'u', status: 'uploading', versionId: 'v1' }),
        row({ id: 'i', assetName: 'i', status: 'interrupted', versionId: 'v2' }),
        row({ id: 'r', assetName: 'r', status: 'starting', resuming: true, versionId: 'v3' }),
      ],
    })
    openPanel('All')
    expect(cancelAllQueued()).toBeNull()

    act(() => {
      useUploadStore.setState((s) => ({
        files: s.files.map((f) => (f.id === 'i' ? { ...f, queuedResume: true as const } : f)),
      }))
    })
    expect(cancelAllQueued()).toBeInTheDocument()
  })

  it('is offered on every tab, since the waiting rows are on Active', async () => {
    fakeServer(() => 'wait')
    drop([fileOf('a.mov'), fileOf('b.mov')])
    await settle()
    openPanel('Failed')

    expect(cancelAllQueued()).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------- a queued resume

describe('a resume waiting for its turn', () => {
  const queuedResume = () => row({
    id: 'r', assetName: 'r', status: 'interrupted', queuedResume: true,
    assetId: 'ra', versionId: 'rv', uploadId: 'ru', s3Key: 'rk',
  })

  it('shows Queued and Waiting to resume with Cancel, and offers neither Resume nor Discard', () => {
    useUploadStore.setState({ files: [queuedResume()] })
    openPanel()

    // It is on its way, so it is on Active rather than among the stopped ones.
    const r = rowNamed('r')
    expect(within(r).getByText('Queued')).toBeInTheDocument()
    expect(within(r).getByText('Waiting to resume')).toBeInTheDocument()
    expect(within(r).getByTitle('Cancel upload')).toBeInTheDocument()
    expect(resumeButton()).toBeNull()
    expect(within(r).queryByTitle('Discard this upload and free the space it is holding')).toBeNull()
    expect(dismissButton(r)).toBeNull()
  })

  it('is on the Active tab and not the Failed one, and counted as active', () => {
    useUploadStore.setState({ files: [queuedResume()] })
    openPanel()

    expect(screen.getByRole('button', { name: /^Active/ })).toHaveTextContent('Active1')
    fireEvent.click(screen.getByRole('button', { name: /^Failed/ }))
    expect(panelRows()).toHaveLength(0)
  })

  it('Cancel puts it back to Interrupted with Resume offered, and aborts nothing', () => {
    useUploadStore.setState({ files: [queuedResume()] })
    fakeServer()
    openPanel()

    fireEvent.click(within(rowNamed('r')).getByTitle('Cancel upload'))

    // It is stopped again, so it leaves Active for the tab of stopped uploads.
    expect(panelRows()).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: /^Failed/ }))
    const r = rowNamed('r')
    expect(r).toHaveAttribute('data-status', 'interrupted')
    expect(within(r).getByText(/^Transfer stopped/)).toBeInTheDocument()
    expect(resumeButton()).toBeInTheDocument()
    expect(api.post).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------- Resume is gated

describe('Resume', () => {
  /** An interrupted upload with everything a resume needs. */
  const interrupted = () => row({
    id: 'r', assetName: 'r', status: 'interrupted', fileSize: 50 * MB,
    assetId: 'ra', versionId: 'rv', uploadId: 'ru', s3Key: 'rk',
  })

  it('is offered on an interrupted row nothing is working on', () => {
    useUploadStore.setState({ files: [interrupted()] })
    openPanel('Failed')

    expect(resumeButton()).toBeInTheDocument()
    expect(screen.getByTitle('Discard this upload and free the space it is holding')).toBeInTheDocument()
  })

  it('is withheld while a cancelled resume still asks the server, and comes back after the answer', async () => {
    fakeServer(() => 'wait')
    const answers: Array<(v: unknown) => void> = []
    vi.mocked(api.get).mockImplementation(() => new Promise((res) => answers.push(res)) as never)
    useUploadStore.setState({ files: [interrupted()] })
    openPanel('All')

    act(() => useUploadStore.getState().resumeUpload('r', fileOf('clip.mp4', 50 * MB)))
    await settle()
    expect(within(rowNamed('r')).getByText('Resuming…')).toBeInTheDocument()

    // Cancelled: back to Interrupted at once, but its run holds its place until
    // `/parts` answers, and a Resume now would be refused.
    fireEvent.click(within(rowNamed('r')).getByTitle('Cancel upload'))
    expect(rowNamed('r')).toHaveAttribute('data-status', 'interrupted')
    expect(resumeButton()).toBeNull()
    expect(screen.getByTitle('Discard this upload and free the space it is holding')).toBeInTheDocument()

    // The answer ends the run. Nothing else in the store changes, and the
    // button still has to come back.
    await act(async () => {
      answers.shift()!(resumable({ file_size_bytes: 50 * MB }))
      await settle()
    })
    expect(resumeButton()).toBeInTheDocument()
  })

  it('is withheld while a Discard of the row is out, and comes back when that fails', async () => {
    fakeServer()
    let failParts!: (err: unknown) => void
    vi.mocked(api.get).mockImplementation(() => new Promise((_, reject) => {
      failParts = reject
    }) as never)
    useUploadStore.setState({ files: [interrupted()] })
    openPanel('Failed')
    expect(resumeButton()).toBeInTheDocument()

    let discarded!: Promise<string | null>
    await act(async () => {
      discarded = useUploadStore.getState().discardUpload('r')
      await settle()
    })
    expect(resumeButton()).toBeNull()

    await act(async () => {
      failParts(new ApiError(503, 'Storage is not answering'))
      await discarded
    })
    expect(resumeButton()).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------- keyboard

describe('the actions of a row', () => {
  it('show on keyboard focus as well as on hover', () => {
    useUploadStore.setState({
      files: [row({ id: 'x', assetName: 'x', status: 'failed', failedBeforeStart: true, error: 'No' })],
    })
    openPanel('All')

    // Hidden until the row is hovered, which a keyboard user never does: the
    // buttons are tab stops, and one that is focused must not stay invisible.
    // jsdom applies no CSS, so what can be pinned is the classes.
    const actions = within(rowNamed('x')).getByTitle('Dismiss').parentElement!
    expect(actions.className).toContain('group-hover:opacity-100')
    expect(actions.className).toContain('focus-within:opacity-100')
  })
})

// ---------------------------------------------------------------- Retry and Dismiss

describe('a row that failed before it started', () => {
  /** A drop whose first file the server refuses, and the row that leaves. */
  async function refusedRow() {
    const server = fakeServer((_, i) => (i === 0 ? new ApiError(400, 'This file is too large.') : 'wait'))
    const [id] = drop([fileOf('big.mov')])
    await settle()
    expect(rowOf(id)).toMatchObject({ status: 'failed', failedBeforeStart: true, retryable: true })
    return { id, server }
  }

  it('a refused row offers Retry and Dismiss; an unreadable one only Dismiss', async () => {
    const { id, server } = await refusedRow()
    openPanel('All')

    const refused = rowNamed('big')
    expect(within(refused).getByText('This file is too large.')).toBeInTheDocument()
    expect(retryButton(refused)).toBeInTheDocument()
    expect(dismissButton(refused)).toBeInTheDocument()

    // A file this tab cannot read again (spec goal 5) is refused with no Retry.
    act(() => {
      useUploadStore.setState((s) => ({
        files: s.files.map((f) => (f.id === id ? { ...f, retryable: false } : f)),
      }))
    })
    expect(retryButton(rowNamed('big'))).toBeNull()
    expect(dismissButton(rowNamed('big'))).toBeInTheDocument()

    // And Retry does what it says: back in the queue, and its turn is at once.
    act(() => {
      useUploadStore.setState((s) => ({
        files: s.files.map((f) => (f.id === id ? { ...f, retryable: true } : f)),
      }))
    })
    fireEvent.click(retryButton(rowNamed('big'))!)
    await settle()
    expect(server.names()).toEqual(['big.mov', 'big.mov'])
    expect(rowNamed('big')).toHaveAttribute('data-status', 'starting')
  })

  it('a refused row restored from storage offers only Dismiss', async () => {
    const { id } = await refusedRow()

    // A reload: the `File` is gone, and the row comes back from what was saved.
    const saved = stored()
    expect(saved.find((f) => f.id === id)).toMatchObject({ status: 'failed', failedBeforeStart: true })
    testing.reset()
    useUploadStore.setState({ files: rehydrate(saved) })
    openPanel('All')

    const restored = rowNamed('big')
    expect(within(restored).getByText('This file is too large.')).toBeInTheDocument()
    expect(retryButton(restored)).toBeNull()
    expect(dismissButton(restored)).toBeInTheDocument()

    fireEvent.click(dismissButton(restored)!)
    expect(panelRows()).toHaveLength(0)
  })

  it('Dismiss removes a failed row whatever the reason it failed', () => {
    useUploadStore.setState({
      files: [
        row({ id: 'm', assetName: 'm', status: 'failed', failedBeforeStart: true, error: 'Storage refused the upload. Ask your admin to check the storage settings.' }),
        row({ id: 'g', assetName: 'g', status: 'failed', error: 'This file is no longer available.', versionId: 'v' }),
      ],
    })
    openPanel('Failed')

    for (const name of ['m', 'g']) expect(dismissButton(rowNamed(name))).toBeInTheDocument()
    fireEvent.click(dismissButton(rowNamed('m'))!)
    fireEvent.click(dismissButton(rowNamed('g'))!)
    expect(panelRows()).toHaveLength(0)
  })

  it('a row kept after a failed Discard offers Dismiss as well as Discard', async () => {
    // `/parts` says the version is gone, and the abort that would clean up
    // after it fails: the row is kept, saying so.
    vi.mocked(api.get).mockRejectedValue(new ApiError(404, 'Not found'))
    vi.mocked(api.post).mockRejectedValue(new ApiError(500, 'Storage is down'))
    useUploadStore.setState({
      files: [row({
        id: 'r', assetName: 'r', status: 'interrupted', fileSize: 50 * MB,
        assetId: 'ra', versionId: 'rv', uploadId: 'ru', s3Key: 'rk',
      })],
    })
    openPanel('Failed')
    expect(dismissButton(rowNamed('r'))).toBeNull()

    await act(async () => {
      expect(await useUploadStore.getState().discardUpload('r')).toBe('Storage is down')
    })

    const kept = rowNamed('r')
    expect(within(kept).getByText('Storage is down')).toBeInTheDocument()
    expect(screen.getByTitle('Discard this upload and free the space it is holding')).toBeInTheDocument()
    // Unlike the Dismiss of a failed row, this one leaves something behind, and
    // says so: the parts the server holds stay until it cleans them up.
    const dismiss = within(kept).getByTitle(KEPT_DISMISS)
    expect(dismiss).toHaveAttribute('aria-label', KEPT_DISMISS)
    expect(dismissButton(kept)).toBeNull()

    // It only takes the row off the list: no request of any kind.
    vi.mocked(api.get).mockClear()
    vi.mocked(api.post).mockClear()
    fireEvent.click(dismiss)
    expect(panelRows()).toHaveLength(0)
    expect(api.get).not.toHaveBeenCalled()
    expect(api.post).not.toHaveBeenCalled()
    expect(api.patch).not.toHaveBeenCalled()
  })
})
