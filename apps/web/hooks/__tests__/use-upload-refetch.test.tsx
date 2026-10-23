/**
 * The project page refetches its grid when an upload changes status, and only then.
 * It used to watch the whole `files` array, so every progress write (up to ~100 an
 * upload, plus every transcode progress event) fired two GETs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useUploadStore, type UploadFile, type UploadStatus } from '@/stores/upload-store'
import { GRID_REFETCH_GAP_MS, useRefetchOnUploadStatus } from '../use-upload-refetch'

function row(id: string, status: UploadStatus, projectId = 'p'): UploadFile {
  return {
    id, fileName: `${id}.mp4`, fileSize: 1, fileType: 'video/mp4',
    projectId, assetName: id, progress: 0, processingProgress: 0,
    status, createdAt: 0,
  }
}

function patch(id: string, change: Partial<UploadFile>) {
  act(() => {
    useUploadStore.setState((s) => ({
      files: s.files.map((f) => (f.id === id ? { ...f, ...change } : f)),
    }))
  })
}

describe('useRefetchOnUploadStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useUploadStore.setState({ files: [] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not refetch on progress writes', () => {
    useUploadStore.setState({ files: [row('done', 'complete'), row('up', 'uploading')] })
    const refetch = vi.fn()
    renderHook(() => useRefetchOnUploadStatus('p', refetch))
    refetch.mockClear()

    for (let percent = 1; percent <= 95; percent++) patch('up', { progress: percent, heartbeatAt: percent })
    patch('up', { progress: 100, status: 'processing' })
    refetch.mockClear()
    for (let percent = 1; percent <= 99; percent++) patch('up', { processingProgress: percent })

    expect(refetch).not.toHaveBeenCalled()
  })

  it('does not re-render the caller on progress writes', () => {
    useUploadStore.setState({ files: [row('done', 'complete'), row('up', 'uploading')] })
    let renders = 0
    renderHook(() => {
      renders += 1
      useRefetchOnUploadStatus('p', () => {})
    })
    const before = renders

    for (let percent = 1; percent <= 95; percent++) patch('up', { progress: percent })

    expect(renders).toBe(before)
  })

  it('does not re-render the caller when uploads change status either', () => {
    // APP-BUG-4 (e2e Q2): the caller is the project page, so a re-render of it re-renders the
    // whole asset grid. With every status move of every upload re-rendering it, a 300-file drop
    // kept the main thread busy for most of the run (React work in about 10 s of a 15 s profile,
    // and tasks of up to 270 ms).
    useUploadStore.setState({ files: [row('done', 'complete'), ...Array.from({ length: 20 }, (_, i) => row(`f${i}`, 'queued'))] })
    let renders = 0
    const refetch = vi.fn()
    renderHook(() => {
      renders += 1
      useRefetchOnUploadStatus('p', refetch)
    })
    const before = renders

    for (let i = 0; i < 20; i++) {
      patch(`f${i}`, { status: 'starting' })
      patch(`f${i}`, { status: 'uploading', assetId: `a${i}` })
      patch(`f${i}`, { status: 'processing', progress: 100 })
      patch(`f${i}`, { status: 'complete' })
      act(() => { vi.advanceTimersByTime(GRID_REFETCH_GAP_MS) })
    }

    expect(renders).toBe(before)
    // And it still refetched for them.
    expect(refetch.mock.calls.length).toBeGreaterThanOrEqual(20)
  })

  it('refetches when an upload in this project finishes', () => {
    useUploadStore.setState({ files: [row('up', 'uploading')] })
    const refetch = vi.fn()
    renderHook(() => useRefetchOnUploadStatus('p', refetch))
    expect(refetch).not.toHaveBeenCalled()

    patch('up', { progress: 100, status: 'complete' })

    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it('refetches on any status change while one of its uploads is complete', () => {
    useUploadStore.setState({ files: [row('done', 'complete'), row('up', 'uploading')] })
    const refetch = vi.fn()
    renderHook(() => useRefetchOnUploadStatus('p', refetch))
    refetch.mockClear()

    act(() => { vi.advanceTimersByTime(GRID_REFETCH_GAP_MS) })
    patch('up', { progress: 100, status: 'processing' })
    expect(refetch).toHaveBeenCalledTimes(1)

    act(() => { vi.advanceTimersByTime(GRID_REFETCH_GAP_MS) })
    act(() => {
      useUploadStore.setState((s) => ({ files: [...s.files, { ...row('new', 'uploading'), assetId: 'a-new' }] }))
    })
    expect(refetch).toHaveBeenCalledTimes(2)
  })

  it('a 300-file drop refetches at most once per gap, and once more after the last change', () => {
    // Q2 (e2e/SCENARIOS.md), APP-BUG-3: each file passes through three states the grid can see
    // (uploading with an asset, processing, complete), and each move refetched at once, two GETs
    // each. 300 files of 200 KB, done in about 25 s, sent over 2 000 reads and spent the account's
    // 600-a-minute read limit inside the drop; every read after that, the grid's included, was
    // refused with 429 until the minute ran out.
    useUploadStore.setState({ files: [] })
    const refetch = vi.fn()
    renderHook(() => useRefetchOnUploadStatus('p', refetch))

    const ids = Array.from({ length: 300 }, (_, i) => `f${i}`)
    act(() => {
      useUploadStore.setState({ files: ids.map((id) => row(id, 'queued')) })
    })
    // Three at a time, about 250 ms a file: 25 s in all.
    for (const id of ids) {
      patch(id, { status: 'uploading', assetId: `a-${id}` })
      act(() => { vi.advanceTimersByTime(40) })
      patch(id, { status: 'processing', progress: 100 })
      act(() => { vi.advanceTimersByTime(40) })
      patch(id, { status: 'complete' })
      act(() => { vi.advanceTimersByTime(3) })
    }
    const elapsed = 300 * 83
    const during = refetch.mock.calls.length
    expect(during).toBeLessThanOrEqual(Math.ceil(elapsed / GRID_REFETCH_GAP_MS) + 1)

    // The last change is not left behind: one more refetch once the gap has passed, and no other.
    act(() => { vi.advanceTimersByTime(GRID_REFETCH_GAP_MS) })
    expect(refetch.mock.calls.length).toBe(during + 1)
    act(() => { vi.advanceTimersByTime(10 * GRID_REFETCH_GAP_MS) })
    expect(refetch.mock.calls.length).toBe(during + 1)
  })

  it('the first change after a quiet spell refetches at once', () => {
    useUploadStore.setState({ files: [row('up', 'uploading')] })
    const refetch = vi.fn()
    renderHook(() => useRefetchOnUploadStatus('p', refetch))

    act(() => { vi.advanceTimersByTime(60_000) })
    patch('up', { progress: 100, status: 'complete' })

    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it('a refetch still due when the page goes away is not made', () => {
    useUploadStore.setState({ files: [row('a', 'uploading'), row('b', 'uploading')] })
    const refetch = vi.fn()
    const { unmount } = renderHook(() => useRefetchOnUploadStatus('p', refetch))
    patch('a', { status: 'complete' })
    patch('b', { status: 'complete' })
    expect(refetch).toHaveBeenCalledTimes(1)

    unmount()
    act(() => { vi.advanceTimersByTime(GRID_REFETCH_GAP_MS) })

    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it('a 10-file queue moving from queued to starting triggers no refetch', () => {
    // Nothing exists on the server for a file until its initiate answers, so a
    // drop waiting and starting changes nothing the grid could show.
    useUploadStore.setState({ files: [row('done', 'complete')] })
    const refetch = vi.fn()
    renderHook(() => useRefetchOnUploadStatus('p', refetch))
    refetch.mockClear()
    // Past the gap the mount's refetch opened, so the next change refetches at once.
    act(() => { vi.advanceTimersByTime(GRID_REFETCH_GAP_MS) })

    const queued = Array.from({ length: 10 }, (_, i) => row(`q${i}`, 'queued'))
    act(() => {
      useUploadStore.setState((s) => ({ files: [...queued, ...s.files] }))
    })
    for (const f of queued) patch(f.id, { status: 'starting' })
    // Still starting once the initiate has answered with its ids: the row turns
    // `uploading` in the same write, and that is the one that counts.
    patch('q0', { versionId: 'v0', uploadId: 'u0' })

    expect(refetch).not.toHaveBeenCalled()

    patch('q0', { status: 'uploading', assetId: 'a0' })
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it("ignores other projects' uploads", () => {
    useUploadStore.setState({ files: [row('done', 'complete'), row('other', 'uploading', 'q')] })
    const refetch = vi.fn()
    renderHook(() => useRefetchOnUploadStatus('p', refetch))
    refetch.mockClear()

    patch('other', { status: 'complete' })

    expect(refetch).not.toHaveBeenCalled()
  })

  it("does not count another project's finished upload as this one's", () => {
    useUploadStore.setState({ files: [row('done', 'complete', 'q'), row('up', 'uploading')] })
    const refetch = vi.fn()
    renderHook(() => useRefetchOnUploadStatus('p', refetch))

    patch('up', { progress: 100, status: 'processing' })

    expect(refetch).not.toHaveBeenCalled()
  })

  it('refetches when one row gives way to another in the same status', () => {
    useUploadStore.setState({ files: [row('done', 'complete'), row('a', 'processing')] })
    const refetch = vi.fn()
    renderHook(() => useRefetchOnUploadStatus('p', refetch))
    refetch.mockClear()
    // Past the gap the mount's refetch opened, so the next change refetches at once.
    act(() => { vi.advanceTimersByTime(GRID_REFETCH_GAP_MS) })

    act(() => {
      useUploadStore.setState((s) => ({
        files: s.files.map((f) => (f.id === 'a' ? row('b', 'processing') : f)),
      }))
    })

    expect(refetch).toHaveBeenCalledTimes(1)
  })
})
