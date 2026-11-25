/**
 * A 404 that the API did not send (#665).
 *
 * While the API restarts, whatever stands in front of it answers: Traefik with
 * no route says `404 page not found` as plain text, and the web app, when the
 * request lands there, says 404 as an HTML page. Read as the API's answer, it
 * ended uploads for good, dropped rows that could be resumed, and let Discard
 * report success for an upload the server still held.
 *
 * The API's own 404 is JSON with a `detail`, and stays final.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@/lib/api', async (orig) => {
  const real = await orig<typeof import('@/lib/api')>()
  return {
    ...real,
    api: { ...real.api, post: vi.fn(real.api.post), get: vi.fn(real.api.get), patch: vi.fn(real.api.patch) },
  }
})
vi.mock('swr', () => ({ mutate: vi.fn() }))

import { api, ApiError } from '@/lib/api'
import { classifyInitiateError } from '@/lib/upload-initiate-outcome'
import { useUploadStore, __uploadQueueTesting as testing, type UploadFile } from '../upload-store'
import { signInAs, row } from '@/test/upload-session'
import { fakeServer, fileOf, small, drop, rowOf, settle, flush, MB } from '@/test/upload-queue-server'

const X = 'user-x'

const plainText = () => new Response('404 page not found\n', { status: 404, headers: { 'Content-Type': 'text/plain' } })
const htmlPage = () => new Response('<!DOCTYPE html><p>404</p>', { status: 404, headers: { 'Content-Type': 'text/html' } })
const jsonNoDetail = () => new Response('{"message":"no Route matched"}', { status: 404, headers: { 'Content-Type': 'application/json' } })
const fromApi = () => new Response('{"detail":"Project not found"}', { status: 404, headers: { 'Content-Type': 'application/json' } })

/** What `api` throws for a response, through the real client. */
async function thrown(response: Response): Promise<ApiError> {
  const real = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
  try {
    await real.api.get('/x')
  } catch (err) {
    return err as ApiError
  } finally {
    vi.unstubAllGlobals()
  }
  throw new Error('expected the call to reject')
}

const NOT_ANSWERING = 'The server is not answering right now. Try again in a moment.'

/** The error a proxy's 404 becomes, for the tests that mock `api` itself. */
const proxied = () => new ApiError(404, NOT_ANSWERING, { apiMissing: true })

const interrupted = (over: Partial<UploadFile> = {}): UploadFile =>
  row({
    id: 'r', status: 'interrupted', ownerId: X, assetId: 'a1', versionId: 'v1', uploadId: 'u1', s3Key: 'k1',
    fileName: 'clip.mp4', fileSize: 50 * MB, ...over,
  })

beforeEach(() => {
  vi.resetAllMocks()
  window.localStorage.clear()
  testing.reset()
  useUploadStore.setState({ files: [] })
  signInAs(X)
})
afterEach(() => vi.useRealTimers())

describe('telling a proxy 404 from the API 404', () => {
  it.each([
    ['plain text', plainText],
    ['an HTML page', htmlPage],
    ['JSON without a detail', jsonNoDetail],
    ['JSON null', () => new Response('null', { status: 404 })],
    ['an empty body', () => new Response('', { status: 404 })],
  ])('%s is not from the API', async (_, response) => {
    expect((await thrown(response())).apiMissing).toBe(true)
  })

  it('JSON with a detail is the API, whatever the detail is', async () => {
    expect((await thrown(fromApi())).apiMissing).toBeFalsy()
    const coded = new Response('{"detail":{"code":"gone","message":"Gone"}}', { status: 404 })
    expect((await thrown(coded)).apiMissing).toBeFalsy()
    expect((await thrown(new Response('{"detail":""}', { status: 404 }))).apiMissing).toBeFalsy()
  })

  it('only a 404 is marked: another status from a proxy keeps its own meaning', async () => {
    expect((await thrown(new Response('Forbidden', { status: 403 }))).apiMissing).toBeFalsy()
    expect((await thrown(new Response('Bad Gateway', { status: 502 }))).apiMissing).toBeFalsy()
  })
})

describe('what the error says', () => {
  // HTTP/2 has no reason phrase, so `statusText` is empty there.
  it.each([['HTTP/1.1', 'Not Found'], ['HTTP/2', '']])('is a sentence over %s', async (_, statusText) => {
    const err = await thrown(new Response('404 page not found', { status: 404, statusText }))
    expect(err.detail).toBe(NOT_ANSWERING)
    expect(err.message).toBe(NOT_ANSWERING)
  })

  it('the API keeps its own words', async () => {
    expect((await thrown(fromApi())).detail).toBe('Project not found')
  })
})

describe('starting an upload', () => {
  it('a proxy 404 holds the queue, an API 404 refuses the file', async () => {
    expect(classifyInitiateError(await thrown(plainText()))).toEqual({ kind: 'hold', reason: 'connection' })
    expect(classifyInitiateError(await thrown(fromApi()))).toEqual({ kind: 'refusal', message: 'Project not found' })
  })

  it('the file waits and starts once the API is back', async () => {
    vi.useFakeTimers()
    const server = fakeServer((_, i) => (i === 0 ? proxied() : 'answer'))

    const [id] = drop([small('a.jpg')])
    await flush()
    expect(rowOf(id).status).not.toBe('failed')
    await vi.advanceTimersByTimeAsync(60_000)
    await flush()

    expect(server.initiates).toHaveLength(2)
    expect(rowOf(id).status).toBe('processing')
  })
})

describe('sending an upload', () => {
  function presignFailsFirst(times: number) {
    fakeServer()
    const serve = vi.mocked(api.post).getMockImplementation() as (...a: unknown[]) => Promise<unknown>
    let n = 0
    vi.mocked(api.post).mockImplementation(((path: string, ...rest: unknown[]) => {
      if (path === '/upload/presign-part' && ++n <= times) return Promise.reject(proxied())
      return serve(path, ...rest)
    }) as never)
    return () => n
  }

  it('a presign answered by the proxy is tried again', async () => {
    vi.useFakeTimers()
    const presigns = presignFailsFirst(2)

    const [id] = drop([small('a.jpg')])
    await flush()
    await vi.advanceTimersByTimeAsync(30_000)
    await flush()

    expect(presigns()).toBe(3)
    expect(rowOf(id).status).toBe('processing')
  })

  it('if it never comes back, the row can be resumed', async () => {
    vi.useFakeTimers()
    presignFailsFirst(Infinity)

    const [id] = drop([small('a.jpg')])
    await flush()
    await vi.advanceTimersByTimeAsync(600_000)
    await flush()

    expect(rowOf(id)).toMatchObject({ status: 'interrupted', versionId: 'v1', uploadId: 'u1', error: NOT_ANSWERING })
  })

  it('a completion answered by the proxy is sent again, past a restart of 45 seconds', async () => {
    vi.useFakeTimers()
    fakeServer()
    const serve = vi.mocked(api.post).getMockImplementation() as (...a: unknown[]) => Promise<unknown>
    const began = Date.now()
    let sent = 0
    vi.mocked(api.post).mockImplementation(((path: string, ...rest: unknown[]) => {
      if (path === '/upload/complete') {
        sent += 1
        if (Date.now() - began < 45_000) return Promise.reject(proxied())
      }
      return serve(path, ...rest)
    }) as never)

    const [id] = drop([small('a.jpg')])
    await flush()
    await vi.advanceTimersByTimeAsync(90_000)
    await flush()

    expect(sent).toBe(5)
    expect(rowOf(id).status).toBe('processing')
  })
})

describe('an interrupted upload', () => {
  beforeEach(() => useUploadStore.setState({ files: [interrupted()] }))

  it('Resume keeps the row resumable when the proxy answers /parts', async () => {
    fakeServer()
    vi.mocked(api.get).mockRejectedValue(proxied())

    useUploadStore.getState().resumeUpload('r', fileOf('clip.mp4', 50 * MB))
    await settle()

    expect(rowOf('r').status).not.toBe('failed')
    expect(rowOf('r')).toMatchObject({ versionId: 'v1', uploadId: 'u1' })
  })

  it('Discard keeps the row and says so, instead of dropping it', async () => {
    vi.mocked(api.get).mockRejectedValue(proxied())

    expect(await useUploadStore.getState().discardUpload('r')).toBe(NOT_ANSWERING)

    expect(rowOf('r')).toMatchObject({ status: 'interrupted', error: NOT_ANSWERING })
    expect(api.post).not.toHaveBeenCalled()
  })

  it('a Discard that failed with no words still says so: the dialog closes on an empty answer', async () => {
    // A 502 over HTTP/2 has neither a body to read nor a reason phrase.
    vi.mocked(api.get).mockRejectedValue(new ApiError(502, ''))

    expect(await useUploadStore.getState().discardUpload('r')).toBeTruthy()

    expect(rowOf('r').error).toBeTruthy()
  })

  it('an abort answered by the proxy is a failed Discard, not a finished one', async () => {
    vi.mocked(api.get).mockRejectedValue(new ApiError(404, 'Version not found'))
    vi.mocked(api.post).mockRejectedValue(proxied())

    expect(await useUploadStore.getState().discardUpload('r')).toBe(NOT_ANSWERING)

    expect(rowOf('r').status).toBe('interrupted')
  })

  it('the API saying so itself is still final', async () => {
    vi.mocked(api.get).mockRejectedValue(new ApiError(404, 'Version not found'))
    vi.mocked(api.post).mockRejectedValue(new ApiError(404, 'Upload not found'))

    expect(await useUploadStore.getState().discardUpload('r')).toBeNull()

    expect(useUploadStore.getState().files).toEqual([])
  })
})

describe('a row saved before rows had owners', () => {
  it.each([
    ['kept when the proxy answers', proxied, 1],
    ['let go when the API says it is gone', () => new ApiError(404, 'Version not found'), 0],
  ])('is %s', async (_, error, left) => {
    const r = interrupted()
    delete r.ownerId
    useUploadStore.setState({ files: [r] })
    vi.mocked(api.get).mockImplementation(((path: string) =>
      path.endsWith('/parts') ? Promise.reject(error()) : Promise.resolve([])) as never)

    signInAs('someone-else')
    signInAs(X)
    await settle()

    expect(useUploadStore.getState().files).toHaveLength(left)
  })
})
