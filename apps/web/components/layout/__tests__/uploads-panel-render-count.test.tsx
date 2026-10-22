/**
 * The Uploads panel under load (spec goal 14, "Rows re-render only on their
 * own data").
 *
 * A transfer reports its progress many times a second, and each report is one
 * write to the upload store. When every row and the panel itself subscribed to
 * the whole store, each of those writes re-rendered every row on screen, so a
 * drop of a few thousand files made the panel, and the page under it, crawl.
 * Now a row reads its own row by id and is memoised, and the panel reads only
 * the ids, counts and labels it lists, so a progress write re-renders the one
 * row it changed.
 *
 * Renders are counted through `ConfirmDialog`, which every row renders exactly
 * once (its Discard confirmation, closed). The mock is a plain function, so it
 * runs every time the row that owns it renders, and its title names the row.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.stubGlobal(
  'IntersectionObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
)
import { Profiler } from 'react'
import { render, screen, act, cleanup } from '@testing-library/react'

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  api: { post: vi.fn(), get: vi.fn(), patch: vi.fn() },
}))
vi.mock('swr', () => ({ mutate: vi.fn() }))

const dialogRenders = vi.fn()
vi.mock('@/components/ui/confirm-dialog', () => ({
  ConfirmDialog: (props: { title: string }) => {
    dialogRenders(props.title)
    return null
  },
}))

// The panel's own renders, counted by the one `cn` call only it makes: the
// classes of its container. Every test checks the mount made exactly one, so a
// change to those classes fails loudly here rather than counting nothing.
const PANEL_CLASSES = 'fixed left-safe top-0 z-50 h-dvh w-[380px]'
const panelRenders = vi.fn()
vi.mock('@/lib/utils', async (orig) => {
  const actual = await orig<typeof import('@/lib/utils')>()
  return {
    ...actual,
    cn: (...inputs: Parameters<typeof actual.cn>) => {
      if (inputs[0] === PANEL_CLASSES) panelRenders()
      return actual.cn(...inputs)
    },
  }
})

const sseRenders = vi.fn()
vi.mock('@/hooks/use-sse', () => ({
  useSSE: (projectId: string) => {
    sseRenders(projectId)
    return { connected: true }
  },
}))

import { api } from '@/lib/api'
import { UploadsPanel, UploadItem } from '../uploads-panel'
import { UploadSSEBridge } from '../upload-sse-bridge'
import { useUploadStore, __uploadQueueTesting as testing, type UploadFile } from '@/stores/upload-store'
import { signInAs, row } from '@/test/upload-session'

/** `Discard <fileName>?`, the title the row's dialog is rendered with. */
const titleOf = (fileName: string) => `Discard ${fileName}?`

/** One write to one row, the way the store's own progress reports write it. */
function patch(id: string, change: Partial<UploadFile>) {
  useUploadStore.setState((s) => ({
    files: s.files.map((f) => (f.id === id ? { ...f, ...change } : f)),
  }))
}

function rows(n: number, make: (i: number) => Partial<UploadFile>): UploadFile[] {
  return Array.from({ length: n }, (_, i) =>
    row({
      id: `row-${i}`,
      fileName: `file-${i}.mp4`,
      assetName: `file-${i}`,
      dropSeq: 1,
      queueSeq: i,
      ...make(i),
    }),
  )
}

/** Called once for every commit anywhere in the panel, the panel itself included. */
const panelCommits = vi.fn()

function openPanelWith(files: UploadFile[]) {
  useUploadStore.setState({ files, panelOpen: true, historyLoaded: true, historyHasMore: false })
  const view = render(
    <Profiler id="panel" onRender={panelCommits}>
      <UploadsPanel />
    </Profiler>,
  )
  expect(panelRenders).toHaveBeenCalledTimes(1)
  panelRenders.mockClear()
  return view
}

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
  cleanup()
  testing.reset()
})

describe('Uploads panel render cost', () => {
  it('a progress write on one row re-renders only that row', () => {
    openPanelWith(rows(50, () => ({ status: 'uploading', progress: 10 })))
    expect(screen.getAllByTestId('upload-row')).toHaveLength(50)
    expect(dialogRenders).toHaveBeenCalledTimes(50)

    dialogRenders.mockClear()
    act(() => patch('row-7', { progress: 42, heartbeatAt: Date.now() }))

    expect(dialogRenders).toHaveBeenCalledTimes(1)
    expect(dialogRenders).toHaveBeenCalledWith(titleOf('file-7.mp4'))
    // The panel lists the same rows in the same order, so it has nothing to redo.
    expect(panelRenders).not.toHaveBeenCalled()
    // And the one row it did re-render shows the write.
    const bars = screen.getAllByRole('progressbar', { name: 'Upload progress' })
    expect(bars[7]).toHaveAttribute('aria-valuenow', '42')
    expect(bars[6]).toHaveAttribute('aria-valuenow', '10')
  })

  it('a write that changes no row re-renders nothing, the panel included', () => {
    openPanelWith(rows(50, () => ({ status: 'uploading', progress: 10 })))
    dialogRenders.mockClear()
    panelCommits.mockClear()

    act(() => useUploadStore.setState((s) => ({ versionsRevision: s.versionsRevision + 1 })))

    expect(dialogRenders).not.toHaveBeenCalled()
    expect(panelCommits).not.toHaveBeenCalled()
  })

  it('a row of another account is neither listed nor counted, and its writes re-render nothing', () => {
    openPanelWith([
      ...rows(3, () => ({ status: 'uploading', progress: 10 })),
      row({ id: 'theirs', fileName: 'theirs.mp4', assetName: 'theirs', status: 'uploading', ownerId: 'user-2' }),
    ])
    expect(screen.getAllByTestId('upload-row')).toHaveLength(3)
    expect(screen.queryByText('theirs')).toBeNull()
    expect(screen.getByText('3 active')).toBeInTheDocument()
    dialogRenders.mockClear()
    panelCommits.mockClear()

    act(() => patch('theirs', { progress: 50 }))

    expect(dialogRenders).not.toHaveBeenCalled()
    expect(panelCommits).not.toHaveBeenCalled()
  })

  it('a row that leaves the list unmounts cleanly and the rest stay put', () => {
    openPanelWith(rows(5, () => ({ status: 'uploading', progress: 10 })))
    dialogRenders.mockClear()

    act(() => useUploadStore.setState((s) => ({ files: s.files.filter((f) => f.id !== 'row-2') })))

    expect(screen.getAllByTestId('upload-row')).toHaveLength(4)
    expect(screen.queryByText('file-2')).toBeNull()
    // The panel lists one row fewer; the rows still listed have nothing new.
    expect(panelRenders).toHaveBeenCalledTimes(1)
    expect(dialogRenders).not.toHaveBeenCalled()
  })

  it('a row id the store no longer has draws nothing rather than throwing', () => {
    useUploadStore.setState({ files: rows(1, () => ({ status: 'uploading' })) })
    const { container } = render(<UploadItem fileId="row-0" />)
    expect(screen.getByTestId('upload-row')).toBeInTheDocument()

    // Gone from the store while still mounted on its own, with no panel to unlist it.
    act(() => useUploadStore.setState({ files: [] }))

    expect(container).toBeEmptyDOMElement()
  })

  it('2,000 queued rows render and one progress write costs under 16 ms', () => {
    // One upload under way at the top of the drop, and 1,999 waiting their turn.
    openPanelWith(rows(2000, (i) => (i === 0 ? { status: 'uploading', progress: 0 } : { status: 'queued' })))
    expect(screen.getAllByTestId('upload-row')).toHaveLength(2000)

    // The measured unit is one progress report: the store write and the React
    // commit that follows it. A few, and the median, so one GC pause in jsdom
    // does not decide the result.
    const samples: number[] = []
    for (let p = 1; p <= 9; p++) {
      const t0 = performance.now()
      act(() => patch('row-0', { progress: p, heartbeatAt: Date.now() }))
      samples.push(performance.now() - t0)
    }
    samples.sort((a, b) => a - b)
    const median = samples[Math.floor(samples.length / 2)]
    if (process.env.UPLOAD_PERF_LOG) {
      process.stderr.write(`\nprogress write median ${median.toFixed(2)} ms; samples ${samples.map((s) => s.toFixed(2)).join(' ')}\n`)
    }

    expect(screen.getAllByRole('progressbar', { name: 'Upload progress' })[0]).toHaveAttribute('aria-valuenow', '9')
    expect(median).toBeLessThan(16)
  })
})

describe('SSE bridge render cost', () => {
  it('a processing progress write does not re-render the bridge or its listeners', () => {
    useUploadStore.setState({
      files: [
        row({ id: 'a', status: 'processing', projectId: 'project-1', assetId: 'asset-a' }),
        row({ id: 'b', status: 'processing', projectId: 'project-1', assetId: 'asset-b' }),
        row({ id: 'c', status: 'processing', projectId: 'project-2', assetId: 'asset-c' }),
        row({ id: 'd', status: 'processing', projectId: 'project-3', assetId: 'asset-d', ownerId: 'user-2' }),
      ],
    })
    const commits = vi.fn()
    render(
      <Profiler id="bridge" onRender={commits}>
        <UploadSSEBridge />
      </Profiler>,
    )
    // One listener per project with a processing row, the signed-in account's only.
    expect(sseRenders.mock.calls.map(([pid]) => pid)).toEqual(['project-1', 'project-2'])
    sseRenders.mockClear()
    commits.mockClear()

    act(() => useUploadStore.getState().updateProcessingProgress('asset-a', 40))
    expect(useUploadStore.getState().files.find((f) => f.id === 'a')?.processingProgress).toBe(40)

    expect(sseRenders).not.toHaveBeenCalled()
    expect(commits).not.toHaveBeenCalled()

    // A row finishing changes the set: project-2 has nothing processing left.
    act(() => useUploadStore.getState().markProcessingComplete('asset-c'))
    expect(sseRenders.mock.calls.map(([pid]) => pid)).toEqual(['project-1'])
  })
})
