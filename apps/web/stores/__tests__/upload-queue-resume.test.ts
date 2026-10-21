/**
 * Resume, as the queue gives it meaning (spec goal 11, "Queue position").
 *
 * A Resume goes next: ahead of every file not yet started, behind the ones
 * already running. Until its turn it asks the server nothing. At its turn,
 * back to back: `GET /parts`, the check that nobody else is sending it, the
 * heartbeat, the first presign. The check reads the row as every tab of this
 * browser last wrote it, so a second tab never resumes an upload the first is
 * still sending. Cancel on a resume that has not sent anything puts it back
 * to plain `interrupted` and aborts nothing: the parts on the server are the
 * work Resume exists to keep.
 *
 * The API is mocked but `ApiError` is the real one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  api: { post: vi.fn(), get: vi.fn(), patch: vi.fn() },
}))
vi.mock('swr', () => ({ mutate: vi.fn() }))

import { api, ApiError } from '@/lib/api'
import { useUploadStore, currentTabId, __uploadQueueTesting as testing } from '../upload-store'
import { signInAs, row } from '@/test/upload-session'
import { installXhrFake } from '@/test/xhr-fake'
import {
  MB, fakeServer, fileOf, small, drop, rowOf, files, stored, settle, flush, rehydrate, resumable,
} from '@/test/upload-queue-server'

/** An interrupted upload with everything a resume or a discard needs. */
const interrupted = (over: Parameters<typeof row>[0] = {}) =>
  row({
    id: 'r', status: 'interrupted', fileSize: MB,
    assetId: 'ra', versionId: 'rv', uploadId: 'ru', s3Key: 'rk',
    ...over,
  })

/** `GET /upload/{v}/parts` answers only when the test says so. */
function heldParts() {
  const answers: Array<(value: unknown) => void> = []
  vi.mocked(api.get).mockImplementation(() => new Promise((resolve) => answers.push(resolve)) as never)
  return { answer: (value: unknown) => answers.shift()!(value) }
}

beforeEach(() => {
  vi.clearAllMocks()
  testing.reset()
  window.localStorage.clear()
  useUploadStore.setState({ files: [], versionsRevision: 0, panelOpen: false })
  signInAs('user-1')
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  testing.reset()
})

describe('a queued resume', () => {
  it('resume goes next, ahead of waiting new files', async () => {
    const server = fakeServer(() => 'wait')
    vi.mocked(api.get).mockImplementation(() => new Promise(() => {}) as never)
    useUploadStore.setState({ files: [interrupted({ fileSize: 50 * MB })] })

    drop([fileOf('a.mov'), fileOf('b.mov'), fileOf('c.mov')])
    await settle()
    useUploadStore.getState().resumeUpload('r', fileOf('clip.mp4'))
    await settle()
    // No server call until its turn.
    expect(api.get).not.toHaveBeenCalled()

    server.initiates[0].reject(new ApiError(400, 'No'))
    await settle()

    expect(api.get).toHaveBeenCalledWith('/upload/rv/parts')
    expect(rowOf('r')).toMatchObject({ status: 'starting', resuming: true })
    expect(server.names()).toEqual(['a.mov'])
  })

  it('a queued resume survives a write and a reload as interrupted', async () => {
    fakeServer(() => 'wait')
    useUploadStore.setState({ files: [interrupted()] })

    drop([small('s0.jpg'), small('s1.jpg'), small('s2.jpg')])
    await settle()
    useUploadStore.getState().resumeUpload('r', small('clip.mp4'))
    expect(rowOf('r').queuedResume).toBe(true)

    useUploadStore.getState().setPanelOpen(false)
    const saved = stored().find((f) => f.id === 'r')!
    expect(saved).toMatchObject({
      status: 'interrupted', assetId: 'ra', versionId: 'rv', uploadId: 'ru', s3Key: 'rk',
    })
    expect(saved).not.toHaveProperty('queuedResume')

    const [restored] = rehydrate([saved])
    expect(restored).toMatchObject({ status: 'interrupted', versionId: 'rv', uploadId: 'ru' })
    expect(restored.queuedResume).toBeUndefined()
  })

  it('cancel on a waiting queued resume returns it to interrupted with no request', async () => {
    const server = fakeServer(() => 'wait')
    useUploadStore.setState({ files: [interrupted()] })

    drop([small('s0.jpg'), small('s1.jpg'), small('s2.jpg')])
    await settle()
    useUploadStore.getState().resumeUpload('r', small('clip.mp4'))
    useUploadStore.getState().cancelUpload('r')

    expect(rowOf('r')).toMatchObject({ status: 'interrupted', versionId: 'rv', uploadId: 'ru' })
    expect(rowOf('r').queuedResume).toBeUndefined()

    // A place frees up: the row is no longer waiting for one.
    server.initiates[0].reject(new ApiError(400, 'No'))
    await settle()
    expect(api.get).not.toHaveBeenCalled()
    expect(server.others()).toEqual([])
  })

  it('cancel on the held resume passes the hold on and leaves the row resumable', async () => {
    vi.useFakeTimers()
    const server = fakeServer(() => 'wait')
    vi.mocked(api.get)
      .mockRejectedValueOnce(new ApiError(503, 'Storage is not answering', { code: 'storage_unavailable' }))
      .mockImplementation(() => new Promise(() => {}) as never)
    useUploadStore.setState({ files: [interrupted({ fileSize: 50 * MB })] })

    useUploadStore.getState().resumeUpload('r', fileOf('clip.mp4'))
    await flush()
    expect(rowOf('r')).toMatchObject({ status: 'interrupted', queuedResume: true, holdReason: 'storage' })
    drop([fileOf('a.mov')])
    await flush()
    expect(server.names()).toEqual([])

    useUploadStore.getState().cancelUpload('r')
    expect(rowOf('r').status).toBe('interrupted')
    expect(rowOf('r').queuedResume).toBeUndefined()
    expect(rowOf('r').holdReason).toBeUndefined()

    await vi.advanceTimersByTimeAsync(2_000)
    await flush()
    expect(server.names()).toEqual(['a.mov'])
    expect(api.get).toHaveBeenCalledTimes(1)
  })
})

describe('a resume at its turn', () => {
  it('cancel during Resuming returns to interrupted with no abort', async () => {
    const server = fakeServer(() => 'wait')
    const parts = heldParts()
    useUploadStore.setState({ files: [interrupted({ fileSize: 50 * MB })] })

    useUploadStore.getState().resumeUpload('r', fileOf('clip.mp4'))
    await settle()
    expect(rowOf('r')).toMatchObject({ status: 'starting', resuming: true })
    const [q] = drop([fileOf('q.mov')])
    await settle()
    expect(server.names()).toEqual([])

    useUploadStore.getState().cancelUpload('r')
    expect(rowOf('r')).toMatchObject({ status: 'interrupted', versionId: 'rv', uploadId: 'ru', s3Key: 'rk' })
    expect(rowOf('r').resuming).toBeUndefined()

    parts.answer(resumable({ file_size_bytes: 50 * MB }))
    await settle()

    // Nothing sent, nothing thrown away.
    expect(server.others()).toEqual([])
    expect(rowOf('r').status).toBe('interrupted')
    expect(rowOf('r').error).toBeUndefined()
    expect(testing.hasAbortController('r')).toBe(false)
    // Its place goes to the file behind it.
    expect(testing.runningIds()).toEqual([q])
    expect(server.names()).toEqual(['q.mov'])
    expect(stored().find((f) => f.id === 'r')).toMatchObject({ status: 'interrupted', uploadId: 'ru' })
  })

  it('cancel during Resuming whose /parts then cannot get through leaves it plain interrupted and holds nothing', async () => {
    const server = fakeServer(() => 'wait')
    let failParts!: (err: unknown) => void
    vi.mocked(api.get).mockImplementation(() => new Promise((_, reject) => {
      failParts = reject
    }) as never)
    useUploadStore.setState({ files: [interrupted({ fileSize: 50 * MB })] })

    useUploadStore.getState().resumeUpload('r', fileOf('clip.mp4'))
    await settle()
    useUploadStore.getState().cancelUpload('r')

    failParts(new ApiError(503, 'Storage is not answering', { code: 'storage_unavailable' }))
    await settle()

    expect(rowOf('r').status).toBe('interrupted')
    expect(rowOf('r').error).toBeUndefined()
    expect(rowOf('r').queuedResume).toBeUndefined()
    expect(rowOf('r').holdReason).toBeUndefined()
    // The cancelled resume did not become the probe: a new file starts.
    drop([fileOf('a.mov')])
    await settle()
    expect(server.names()).toEqual(['a.mov'])
  })

  it('a resume of an assembled upload sends no presign and does not wait for a slot', async () => {
    const server = fakeServer(() => 'answer', 'hang')
    const parts = heldParts()
    useUploadStore.setState({ files: [interrupted()] })

    useUploadStore.getState().resumeUpload('r', small('clip.mp4'))
    await settle()
    expect(api.get).toHaveBeenCalledWith('/upload/rv/parts')

    // A file that starts meanwhile takes every part slot and keeps them.
    drop([fileOf('b.mov', 80 * MB)])
    await settle()
    expect(server.inFlight).toHaveLength(5)

    parts.answer(resumable({ state: 'assembled' }))
    await settle()

    expect(server.calls).not.toContain('presign ru')
    expect(server.calls).toContain('complete ru')
    expect(rowOf('r').status).toBe('processing')
  })

  it('a resume whose parts are all held sends no presign and does not wait for a slot', async () => {
    const server = fakeServer(() => 'answer', 'hang')
    const parts = heldParts()
    useUploadStore.setState({ files: [interrupted()] })

    useUploadStore.getState().resumeUpload('r', small('clip.mp4'))
    await settle()
    drop([fileOf('b.mov', 80 * MB)])
    await settle()
    expect(server.inFlight).toHaveLength(5)

    parts.answer(resumable({ held_part_numbers: [1] }))
    await settle()

    expect(server.calls).not.toContain('presign ru')
    expect(server.calls).toContain('complete ru')
    expect(rowOf('r').status).toBe('processing')
  })

  it("a Resuming row whose /parts answers 503 becomes the hold's probe; after a reload it is still in localStorage['ff-uploads'] as interrupted with its ids", async () => {
    vi.useFakeTimers()
    const server = fakeServer(() => 'wait')
    vi.mocked(api.get)
      .mockRejectedValueOnce(new ApiError(503, 'Storage is not answering', { code: 'storage_unavailable', retryAfter: 5 }))
      .mockImplementation(() => new Promise(() => {}) as never)
    useUploadStore.setState({ files: [interrupted({ fileSize: 50 * MB })] })

    useUploadStore.getState().resumeUpload('r', fileOf('clip.mp4'))
    await flush()
    expect(rowOf('r')).toMatchObject({ status: 'interrupted', queuedResume: true, holdReason: 'storage' })

    // It holds the queue.
    drop([small('s.jpg')])
    await flush()
    expect(server.names()).toEqual([])

    useUploadStore.getState().setPanelOpen(true)
    const saved = stored().find((f) => f.id === 'r')!
    expect(saved).toMatchObject({
      status: 'interrupted', assetId: 'ra', versionId: 'rv', uploadId: 'ru', s3Key: 'rk',
    })
    expect(saved).not.toHaveProperty('queuedResume')
    expect(saved).not.toHaveProperty('holdReason')
    const [restored] = rehydrate([saved])
    expect(restored).toMatchObject({ status: 'interrupted', versionId: 'rv', uploadId: 'ru', s3Key: 'rk' })

    // And it is the probe: it alone tries again, after the wait the server asked for.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(api.get).toHaveBeenCalledTimes(2)
    expect(server.names()).toEqual([])
  })
})

describe('a resume that waits its turn', () => {
  /**
   * This tab was sending the upload until it stopped `stoppedAgo` ms before
   * the Resume click, and the server last saw it move then too: its own final
   * part. Three files hold every place, so the Resume waits `waitMs` for its
   * turn. `serverActivity` is what `/parts` reports as the last movement, when
   * it should differ from the tab's own stop.
   */
  async function resumeAfterWaiting(opts: {
    stoppedAgo: number
    waitMs: number
    serverActivity?: (turn: number) => number
    atTurn?: () => void
  }) {
    vi.useFakeTimers()
    const server = fakeServer(() => 'wait', 'hang')
    const clicked = Date.now()
    const stoppedAt = clicked - opts.stoppedAgo
    useUploadStore.setState({
      files: [interrupted({ ownerTab: currentTabId(), heartbeatAt: stoppedAt })],
    })
    drop([small('s0.jpg'), small('s1.jpg'), small('s2.jpg')])
    await flush()
    useUploadStore.getState().resumeUpload('r', small('clip.mp4'))
    await flush()
    expect(api.get).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(opts.waitMs)
    const turn = Date.now()
    const lastMoved = opts.serverActivity ? opts.serverActivity(turn) : stoppedAt
    vi.mocked(api.get).mockImplementation(
      () => Promise.resolve(resumable({ last_activity_at: new Date(lastMoved).toISOString() })) as never,
    )
    opts.atTurn?.()
    // A place frees up: the Resume's turn.
    server.initiates[0].reject(new ApiError(400, 'No'))
    await flush()
    expect(api.get).toHaveBeenCalledWith('/upload/rv/parts')
    return server
  }

  afterEach(() => {
    // Stop any transfer the test left running, so its heartbeat does not outlive it.
    if (useUploadStore.getState().files.some((f) => f.id === 'r' && f.status === 'uploading')) {
      useUploadStore.getState().cancelUpload('r')
    }
  })

  it('a Resume clicked just after this tab stopped still resumes when its turn comes after the grace', async () => {
    // Clicked 10 s after the stop, started 50 s after it: past the two
    // heartbeats a stopped upload stays this tab's own, inside the server's
    // live window. Nobody but this tab ever touched it.
    const server = await resumeAfterWaiting({ stoppedAgo: 10_000, waitMs: 40_000 })

    expect(rowOf('r').status).toBe('uploading')
    expect(server.calls).toContain('presign ru')
  })

  it('is refused when the server saw the upload move after the click: another device took it up meanwhile', async () => {
    const server = await resumeAfterWaiting({
      stoppedAgo: 10_000,
      waitMs: 40_000,
      serverActivity: (turn) => turn - 2_000,
    })

    expect(rowOf('r').status).toBe('elsewhere')
    expect(server.calls).not.toContain('presign ru')
  })

  it('is refused when another tab of this browser is stamping the row at its turn', async () => {
    const server = await resumeAfterWaiting({
      stoppedAgo: 10_000,
      waitMs: 40_000,
      atTurn: () => {
        // Another tab has just taken it up: stamped, but no byte moved yet,
        // so the server's last movement is still this tab's own.
        const saved = JSON.parse(window.localStorage.getItem('ff-uploads')!)
        saved.state.files = saved.state.files.map((f: { id: string }) => (
          f.id === 'r' ? { ...f, ownerTab: 'tab-other', heartbeatAt: Date.now() } : f
        ))
        window.localStorage.setItem('ff-uploads', JSON.stringify(saved))
      },
    })

    expect(rowOf('r').status).toBe('elsewhere')
    expect(server.calls).not.toContain('presign ru')
  })

  it('a Resume clicked after the grace had already passed is judged as before: refused while the server window runs', async () => {
    const server = await resumeAfterWaiting({ stoppedAgo: 35_000, waitMs: 20_000 })

    expect(rowOf('r').status).toBe('elsewhere')
    expect(server.calls).not.toContain('presign ru')
  })
})

describe('a resume and a discard', () => {
  it('a resume is refused while a Discard of the row is in flight', async () => {
    const server = fakeServer(() => 'wait')
    const parts = heldParts()
    useUploadStore.setState({ files: [interrupted()] })

    const discarding = useUploadStore.getState().discardUpload('r')
    useUploadStore.getState().resumeUpload('r', small('clip.mp4'))
    expect(rowOf('r').queuedResume).toBeUndefined()
    await settle()
    expect(api.get).toHaveBeenCalledTimes(1) // Discard's own

    parts.answer(resumable())
    expect(await discarding).toBeNull()
    expect(server.others()).toEqual(['abort ru'])
    expect(files().some((f) => f.id === 'r')).toBe(false)
  })

  it('a Discard that failed leaves the row resumable again', async () => {
    fakeServer(() => 'wait')
    vi.mocked(api.get).mockRejectedValueOnce(new ApiError(500, 'Server error'))
      .mockImplementation(() => new Promise(() => {}) as never)
    useUploadStore.setState({ files: [interrupted()] })

    expect(await useUploadStore.getState().discardUpload('r')).toBe('Server error')

    useUploadStore.getState().resumeUpload('r', small('clip.mp4'))
    await settle()
    expect(api.get).toHaveBeenCalledTimes(2)
    expect(api.get).toHaveBeenLastCalledWith('/upload/rv/parts')
  })
})

describe('two tabs of one browser', () => {
  /**
   * A second copy of the store, as another tab of this browser runs it: its
   * own module graph, its own tab id, and the same jsdom localStorage. Parts
   * hang, so a tab that resumes is still sending afterwards. Presigns are
   * counted, not attributed: whether the module graphs share one mocked `api`
   * is vitest's business, and which tab sent shows on the rows.
   */
  let presigns = 0
  async function openTab(sessionTabId?: string) {
    window.sessionStorage.removeItem('ff-upload-tab')
    if (sessionTabId) window.sessionStorage.setItem('ff-upload-tab', sessionTabId)
    vi.resetModules()
    const { api: tabApi } = await import('@/lib/api')
    const tab = await import('@/stores/upload-store')
    // The server has not seen the upload move: only this browser's storage knows.
    vi.mocked(tabApi.get).mockImplementation(() => Promise.resolve(resumable()) as never)
    vi.mocked(tabApi.post).mockImplementation(((path: string, body?: { upload_id?: string; part_number?: number }) => {
      if (path === '/upload/presign-part') {
        presigns += 1
        return Promise.resolve({ presigned_url: `https://s3.test/${body?.upload_id}/${body?.part_number}` })
      }
      return Promise.resolve({})
    }) as never)
    return {
      store: tab.useUploadStore,
      tabId: tab.currentTabId(),
      status: () => tab.useUploadStore.getState().files.find((f) => f.id === 'r')?.status,
    }
  }

  beforeEach(() => {
    presigns = 0
    // The tabs' duplicate-id handshake is not under test here.
    vi.stubGlobal('BroadcastChannel', class {
      onmessage: unknown = null
      postMessage() {}
      close() {}
    })
    installXhrFake(() => new Promise(() => {}))
  })

  it('two stores sharing localStorage resume the same row and only one presigns', async () => {
    window.localStorage.setItem('ff-uploads', JSON.stringify({ state: { files: [interrupted()] }, version: 0 }))

    const first = await openTab()
    const second = await openTab()
    expect(first.tabId).not.toBe(second.tabId)
    expect(first.status()).toBe('interrupted')
    expect(second.status()).toBe('interrupted')

    first.store.getState().resumeUpload('r', small('clip.mp4'))
    await settle()
    expect(presigns).toBe(1)
    expect(first.status()).toBe('uploading')

    second.store.getState().resumeUpload('r', small('clip.mp4'))
    await settle()
    expect(presigns).toBe(1)
    expect(second.status()).toBe('elsewhere')
    expect(first.status()).toBe('uploading')

    // Stop the first tab's transfer, so its heartbeat does not outlive the test.
    first.store.getState().cancelUpload('r')
    await settle()
  })

  it('a tab that sent the row before does not take it back from the tab sending it now', async () => {
    // Tab one sent this upload until it broke ten minutes ago, so the row
    // still names tab one. Tab two has resumed it since.
    window.localStorage.setItem('ff-uploads', JSON.stringify({
      state: { files: [interrupted({ ownerTab: 'tab-one', heartbeatAt: Date.now() - 10 * 60_000 })] },
      version: 0,
    }))
    const one = await openTab('tab-one')
    const two = await openTab()
    expect(one.tabId).toBe('tab-one')

    two.store.getState().resumeUpload('r', small('clip.mp4'))
    await settle()
    expect(presigns).toBe(1)

    // Tab one's own writes must not put its stale copy back over tab two's
    // stamp, or its turn would find nobody else sending.
    one.store.getState().resumeUpload('r', small('clip.mp4'))
    await settle()
    expect(presigns).toBe(1)
    expect(one.status()).toBe('elsewhere')
    expect(two.status()).toBe('uploading')

    two.store.getState().cancelUpload('r')
    await settle()
  })
})
