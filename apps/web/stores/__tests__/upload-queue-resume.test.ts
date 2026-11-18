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
import { useUploadStore, currentTabId, resumeClaimKey, __uploadQueueTesting as testing } from '../upload-store'
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
  // A resume's claim waits for another tab's write still on its way from another process
  // (RESUME_CLAIM_PREFIX). Here every store shares one storage object and sees each write at
  // once, and these cases are about other things: no waiting it out on every resume.
  testing.setClaimSettleMs(0)
  window.localStorage.clear()
  useUploadStore.setState({ files: [], versionsRevision: 0, panelOpen: false })
  signInAs('user-1')
  // A first sign-in fetches the account's upload history; no case here is about that.
  vi.mocked(api.get).mockClear()
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

    expect(api.get).toHaveBeenCalledWith('/upload/rv/parts', { pinSubject: 'user-1' })
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
    expect(api.get).toHaveBeenCalledWith('/upload/rv/parts', { pinSubject: 'user-1' })

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
   * the Resume click. Three files hold every place, so the Resume waits
   * `waitMs` for its turn. Times are given on this browser's clock:
   * `lastMoved` is when the server last saw the upload move (by default this
   * tab's own stop), and the server's clock reads `serverSkew` ms ahead of
   * this one, in both `last_activity_at` and `server_time`. `/parts` answers
   * `partsMs` after it is asked and reads its clock as it answers.
   */
  async function resumeAfterWaiting(opts: {
    stoppedAgo: number
    waitMs: number
    lastMoved?: (t: { clicked: number; turn: number; stoppedAt: number }) => number
    serverSkew?: number
    partsMs?: number
    noServerTime?: boolean
    serverTimeText?: string
    atTurn?: () => void
  }) {
    vi.useFakeTimers()
    const server = fakeServer(() => 'wait', 'hang')
    const skew = opts.serverSkew ?? 0
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
    const lastMoved = opts.lastMoved ? opts.lastMoved({ clicked, turn, stoppedAt }) : stoppedAt
    vi.mocked(api.get).mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => {
        const answer: Record<string, unknown> = resumable({
          last_activity_at: new Date(lastMoved + skew).toISOString(),
          server_time: new Date(Date.now() + skew).toISOString(),
        })
        if (opts.noServerTime) delete answer.server_time
        if (opts.serverTimeText !== undefined) answer.server_time = opts.serverTimeText
        resolve(answer)
      }, opts.partsMs ?? 0)
    }) as never)
    opts.atTurn?.()
    // A place frees up: the Resume's turn.
    server.initiates[0].reject(new ApiError(400, 'No'))
    await flush()
    await vi.advanceTimersByTimeAsync(opts.partsMs ?? 0)
    await flush()
    expect(api.get).toHaveBeenCalledWith('/upload/rv/parts', { pinSubject: 'user-1' })
    return server
  }

  const resumed = (server: ReturnType<typeof fakeServer>) => {
    expect(rowOf('r').status).toBe('uploading')
    expect(server.calls).toContain('presign ru')
  }
  const refused = (server: ReturnType<typeof fakeServer>) => {
    expect(rowOf('r').status).toBe('elsewhere')
    expect(server.calls).not.toContain('presign ru')
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
    resumed(await resumeAfterWaiting({ stoppedAgo: 10_000, waitMs: 40_000 }))
  })

  it('is refused when the server saw the upload move after the click: another device took it up meanwhile', async () => {
    refused(await resumeAfterWaiting({
      stoppedAgo: 10_000,
      waitMs: 40_000,
      lastMoved: ({ turn }) => turn - 2_000,
    }))
  })

  it('is refused when another tab of this browser is stamping the row at its turn', async () => {
    refused(await resumeAfterWaiting({
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
    }))
  })

  it('a Resume clicked after the grace had already passed is judged as before: refused while the server window runs', async () => {
    refused(await resumeAfterWaiting({ stoppedAgo: 35_000, waitMs: 20_000 }))
  })

  it('a stamp exactly at the click resumes', async () => {
    resumed(await resumeAfterWaiting({ stoppedAgo: 10_000, waitMs: 40_000, lastMoved: ({ clicked }) => clicked }))
  })

  it('a stamp one second after the click is refused', async () => {
    refused(await resumeAfterWaiting({ stoppedAgo: 10_000, waitMs: 40_000, lastMoved: ({ clicked }) => clicked + 1_000 }))
  })

  it('with this clock 60 s ahead of the server, another sender that presigned 10 s after the click is still refused', async () => {
    // Read as stamps, the sender's presign is 50 s before the click on this
    // clock, and would pass for this tab's own last part.
    refused(await resumeAfterWaiting({
      stoppedAgo: 10_000,
      waitMs: 40_000,
      serverSkew: -60_000,
      lastMoved: ({ clicked }) => clicked + 10_000,
    }))
  })

  it("with the server's clock 60 s ahead and nobody else sending, the tab's own Resume carries on", async () => {
    // Read as stamps, this tab's own last part is 50 s after the click.
    resumed(await resumeAfterWaiting({ stoppedAgo: 10_000, waitMs: 40_000, serverSkew: 60_000 }))
  })

  it('counts the whole /parts round trip: a server that read its clock as it answered does not hide a move after the click', async () => {
    // Asked 50 s after the click, answered 5 s later. Another sender moved it
    // 2 s after the click: 48 s before the server's answer, while the click
    // was 50 s before the request went out.
    refused(await resumeAfterWaiting({
      stoppedAgo: 10_000,
      waitMs: 50_000,
      partsMs: 5_000,
      lastMoved: ({ clicked }) => clicked + 2_000,
    }))
  })

  it('a server that sends no server_time leaves the decision as it was: refused after the grace', async () => {
    refused(await resumeAfterWaiting({ stoppedAgo: 10_000, waitMs: 40_000, noServerTime: true }))
  })

  it('a server_time that cannot be read is treated the same way', async () => {
    refused(await resumeAfterWaiting({ stoppedAgo: 10_000, waitMs: 40_000, serverTimeText: 'not a time' }))
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
    expect(api.get).toHaveBeenLastCalledWith('/upload/rv/parts', { pinSubject: 'user-1' })
  })
})

/**
 * `GET /upload/{v}/parts` as the server answers it (`list_held_parts`): it
 * records the request as activity when nothing has moved for 5 minutes, and
 * reports the activity it held before, with its clock as it answers. The
 * first `held` answers wait for `release`; the rest answer at once.
 */
function stampingParts(lastActivity: number | null, held = 0) {
  let last = lastActivity
  const waiting: Array<() => void> = []
  let calls = 0
  vi.mocked(api.get).mockImplementation(((path: string) => {
    if (!path.endsWith('/parts')) return Promise.resolve([])
    calls += 1
    const now = Date.now()
    const previous = last
    if (previous === null || now - previous >= 5 * 60_000) last = now
    const answer = resumable({
      file_size_bytes: 50 * MB,
      last_activity_at: previous === null ? null : new Date(previous).toISOString(),
      server_time: new Date(now).toISOString(),
    })
    if (calls > held) return Promise.resolve(answer)
    return new Promise((resolve) => waiting.push(() => resolve(answer)))
  }) as never)
  return {
    release: () => waiting.shift()!(),
    calls: () => calls,
    /** Another device presigns a part: activity the server records. */
    movedElsewhere: () => { last = Date.now() },
  }
}

describe("this tab's own /parts stamp", () => {
  it('Resume, Cancel while it asks /parts, Resume again: the stamp its own /parts made is not read as another sender', async () => {
    fakeServer(() => 'answer', 'hang')
    const parts = stampingParts(Date.now() - 10 * 60_000, 1)
    useUploadStore.setState({ files: [interrupted({ fileSize: 50 * MB })] })

    useUploadStore.getState().resumeUpload('r', fileOf('clip.mp4'))
    await settle()
    expect(rowOf('r')).toMatchObject({ status: 'starting', resuming: true })
    useUploadStore.getState().cancelUpload('r')
    parts.release()
    await settle()
    expect(rowOf('r').status).toBe('interrupted')

    useUploadStore.getState().resumeUpload('r', fileOf('clip.mp4'))
    await settle()

    expect(parts.calls()).toBe(2)
    expect(rowOf('r').status).toBe('uploading')
  })

  it('Resume, Cancel while it asks /parts, then Discard: not refused', async () => {
    const parts = stampingParts(Date.now() - 10 * 60_000, 1)
    useUploadStore.setState({ files: [interrupted({ fileSize: 50 * MB })] })
    useUploadStore.getState().resumeUpload('r', fileOf('clip.mp4'))
    await settle()
    useUploadStore.getState().cancelUpload('r')
    parts.release()
    await settle()

    const said = await useUploadStore.getState().discardUpload('r')

    expect(said).toBeNull()
    expect(api.post).toHaveBeenCalledWith('/upload/abort', expect.objectContaining({ version_id: 'rv', discard: true }), { pinSubject: 'user-1' })
    expect(files().find((f) => f.id === 'r')).toBeUndefined()
  })

  it("the adoption check's /parts stamp does not refuse a Discard right after it", async () => {
    stampingParts(Date.now() - 10 * 60_000)
    useUploadStore.setState({ files: [interrupted({ ownerId: undefined, ownerTab: undefined })] })
    await testing.adoptOwnerlessRows()
    expect(rowOf('r').ownerId).toBe('user-1')

    const said = await useUploadStore.getState().discardUpload('r')

    expect(said).toBeNull()
    expect(api.post).toHaveBeenCalledWith('/upload/abort', expect.objectContaining({ version_id: 'rv', discard: true }), { pinSubject: 'user-1' })
  })

  it('a stamp made after this tab\'s own is another sender\'s', async () => {
    const parts = stampingParts(Date.now() - 10 * 60_000)
    useUploadStore.setState({ files: [interrupted({ ownerId: undefined, ownerTab: undefined })] })
    await testing.adoptOwnerlessRows()
    await new Promise((r) => setTimeout(r, 5))
    parts.movedElsewhere()

    const said = await useUploadStore.getState().discardUpload('r')

    expect(said).toBe('Still uploading in another tab or on another device')
    expect(rowOf('r').status).toBe('elsewhere')
    expect(api.post).not.toHaveBeenCalled()
  })

  it('an answer that recorded nothing does not excuse the activity it reported', async () => {
    // Another device moved it a minute ago, so no /parts here records anything.
    stampingParts(Date.now() - 60_000)
    useUploadStore.setState({ files: [interrupted({ ownerId: undefined, ownerTab: undefined })] })
    await testing.adoptOwnerlessRows()

    const said = await useUploadStore.getState().discardUpload('r')

    expect(said).toBe('Still uploading in another tab or on another device')
    expect(api.post).not.toHaveBeenCalled()
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
    // One storage object: each tab sees the other's claim at once (see the top of this file).
    tab.__uploadQueueTesting.setClaimSettleMs(0)
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
      api: tabApi,
      testing: tab.__uploadQueueTesting,
      tabId: tab.currentTabId(),
      status: (id = 'r') => tab.useUploadStore.getState().files.find((f) => f.id === id)?.status,
    }
  }

  /**
   * `GET /parts` for every tab answers only when the test says so, per version, and
   * every waiting caller gets the same answer at the same moment.
   */
  function heldPartsByVersion(...tabs: Array<{ api: typeof api }>) {
    const gates = new Map<string, { promise: Promise<unknown>; open: (v: unknown) => void }>()
    const gate = (version: string) => {
      let g = gates.get(version)
      if (!g) {
        let open!: (v: unknown) => void
        const promise = new Promise((resolve) => { open = resolve })
        g = { promise, open }
        gates.set(version, g)
      }
      return g
    }
    for (const t of tabs) {
      vi.mocked(t.api.get).mockImplementation(((path: string) => {
        const version = /^\/upload\/([^/]+)\/parts$/.exec(path)?.[1]
        return version ? gate(version).promise : new Promise(() => {})
      }) as never)
    }
    return {
      answer: (version: string, over: Record<string, unknown> = {}) =>
        gate(version).open(resumable({ version_id: version, ...over })),
    }
  }

  /** Every key and value in localStorage now, as it really is (not as a lagging tab sees it). */
  const realGetItem = Storage.prototype.getItem
  function snapshotStorage(): Map<string, string> {
    const view = new Map<string, string>()
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i)!
      view.set(key, realGetItem.call(window.localStorage, key)!)
    }
    return view
  }

  /** Whether a claim naming `tabId` is in storage, under whatever key claims are kept. */
  function claimWrittenBy(tabId: string): boolean {
    return Array.from(snapshotStorage()).some(([key, value]) => key.includes('claim') && value.includes(tabId))
  }

  it('claims two tabs make on two different rows at nearly the same moment both stand', async () => {
    // Each tab resumes its own row. A write reaches the other tab's process a
    // moment later, so the second tab writes its claim from a view of storage
    // that has not seen the first tab's yet. A claim on one row must not undo a
    // claim on another: the first tab would show Elsewhere with nobody sending.
    window.localStorage.setItem('ff-uploads', JSON.stringify({
      state: {
        files: [
          interrupted(),
          interrupted({ id: 'r2', assetId: 'ra2', versionId: 'rv2', uploadId: 'ru2', s3Key: 'rk2' }),
        ],
      },
      version: 0,
    }))
    const one = await openTab()
    const two = await openTab()
    one.testing.setClaimSettleMs(300)
    two.testing.setClaimSettleMs(300)
    const parts = heldPartsByVersion(one, two)

    // Reads of localStorage made while `lagging` is set see it as it was then.
    let lagging: Map<string, string> | null = null
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      if (lagging && this === window.localStorage) return lagging.get(key) ?? null
      return realGetItem.call(this, key)
    })

    one.store.getState().resumeUpload('r', small('clip.mp4'))
    two.store.getState().resumeUpload('r2', small('other.mp4'))
    await settle()

    const beforeOne = snapshotStorage()
    parts.answer('rv', { upload_id: 'ru', s3_key: 'rk', asset_id: 'ra' })
    await vi.waitFor(() => expect(claimWrittenBy(one.tabId)).toBe(true))

    // Tab one is settling. Tab two takes its row up without having seen tab one's claim.
    lagging = beforeOne
    parts.answer('rv2', { upload_id: 'ru2', s3_key: 'rk2', asset_id: 'ra2', original_filename: 'other.mp4' })
    await vi.waitFor(() => expect(claimWrittenBy(two.tabId)).toBe(true))
    lagging = null

    await vi.waitFor(() => {
      expect(one.status('r')).not.toBe('starting')
      expect(two.status('r2')).not.toBe('starting')
    }, { timeout: 3_000 })
    expect(one.status('r')).toBe('uploading')
    expect(two.status('r2')).toBe('uploading')

    one.store.getState().cancelUpload('r')
    two.store.getState().cancelUpload('r2')
    await settle()
  })

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

  it('a claim it cannot read is replaced, and the next tab to resume at once stands aside', async () => {
    // A claim value that is not one (cut short, or written by something else)
    // must not turn the claim off for that row: the tab writes its own over
    // it, and the other tab, looking at the same moment, finds it.
    window.localStorage.setItem('ff-uploads', JSON.stringify({ state: { files: [interrupted()] }, version: 0 }))
    window.localStorage.setItem(resumeClaimKey('rv'), '{"tab":"some-tab","nonce":')
    const one = await openTab()
    const two = await openTab()
    one.testing.setClaimSettleMs(200)
    two.testing.setClaimSettleMs(200)
    const parts = heldPartsByVersion(one, two)

    one.store.getState().resumeUpload('r', small('clip.mp4'))
    two.store.getState().resumeUpload('r', small('clip.mp4'))
    await settle()
    // Both answers land together: each tab looks before either has stamped the row.
    parts.answer('rv')

    await vi.waitFor(() => {
      expect(one.status()).not.toBe('starting')
      expect(two.status()).not.toBe('starting')
    }, { timeout: 3_000 })
    expect(one.status()).toBe('uploading')
    expect(two.status()).toBe('elsewhere')
    expect(presigns).toBe(1)
    expect(JSON.parse(window.localStorage.getItem(resumeClaimKey('rv'))!)).toMatchObject({ tab: one.tabId })

    one.store.getState().cancelUpload('r')
    await settle()
  })

  it("a live row in one tab and the history row for the same upload in another, resumed at once: only one sends", async () => {
    // The two rows have different ids (history rows are keyed on the asset)
    // but name one version, one multipart upload. The claim is on the upload.
    window.localStorage.setItem('ff-uploads', JSON.stringify({
      state: {
        files: [
          interrupted(),
          interrupted({ id: 'history-ra', fromHistory: true, uploadId: undefined, s3Key: undefined }),
        ],
      },
      version: 0,
    }))
    const one = await openTab()
    const two = await openTab()
    one.testing.setClaimSettleMs(200)
    two.testing.setClaimSettleMs(200)
    const parts = heldPartsByVersion(one, two)

    one.store.getState().resumeUpload('r', small('clip.mp4'))
    two.store.getState().resumeUpload('history-ra', small('clip.mp4'))
    await settle()
    // Both answers land together: each tab looks before either has stamped its row.
    parts.answer('rv')

    await vi.waitFor(() => {
      expect(one.status('r')).not.toBe('starting')
      expect(two.status('history-ra')).not.toBe('starting')
    }, { timeout: 3_000 })
    expect(presigns).toBe(1)
    expect([one.status('r'), two.status('history-ra')].sort()).toEqual(['elsewhere', 'uploading'])
    expect(JSON.parse(window.localStorage.getItem(resumeClaimKey('rv'))!)).toHaveProperty('tab')

    one.store.getState().cancelUpload('r')
    two.store.getState().cancelUpload('history-ra')
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
