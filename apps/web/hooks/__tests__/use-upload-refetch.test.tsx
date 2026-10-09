/**
 * The project page refetches its grid when an upload changes status, and only then.
 * It used to watch the whole `files` array, so every progress write (up to ~100 an
 * upload, plus every transcode progress event) fired two GETs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useUploadStore, type UploadFile, type UploadStatus } from '@/stores/upload-store'
import { useRefetchOnUploadStatus } from '../use-upload-refetch'

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
    useUploadStore.setState({ files: [] })
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

    patch('up', { progress: 100, status: 'processing' })
    expect(refetch).toHaveBeenCalledTimes(1)

    act(() => {
      useUploadStore.setState((s) => ({ files: [...s.files, row('new', 'pending')] }))
    })
    expect(refetch).toHaveBeenCalledTimes(2)
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

    act(() => {
      useUploadStore.setState((s) => ({
        files: s.files.map((f) => (f.id === 'a' ? row('b', 'processing') : f)),
      }))
    })

    expect(refetch).toHaveBeenCalledTimes(1)
  })
})
