import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getAccessToken: vi.fn(() => null),
  refreshAccessToken: vi.fn(() => Promise.resolve(null)),
}))

import { api, ApiError } from '@/lib/api'
import { classifyInitiateError } from '@/lib/upload-initiate-outcome'

/** A real `Response`, so `headers.get` is case-insensitive the way the browser's is. */
function errorResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

function stubFetch(response: Response) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
}

async function catchApiError(call: () => Promise<unknown>): Promise<ApiError> {
  try {
    await call()
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError)
    return err as ApiError
  }
  throw new Error('expected the call to reject')
}

describe('ApiError code and retryAfter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it("a /parts that cannot reach storage, as the API answers it, is a storage hold: a queued Resume says Waiting for storage", async () => {
    // `_storage_unreachable` in apps/api/routers/upload.py.
    stubFetch(
      errorResponse(
        503,
        {
          detail: {
            code: 'storage_unavailable',
            message: 'Could not reach storage to check this upload. Please retry.',
            retry_after: 5,
          },
        },
        { 'Retry-After': '5' },
      ),
    )

    const err = await catchApiError(() => api.get('/upload/v1/parts'))

    expect(err.detail).toBe('Could not reach storage to check this upload. Please retry.')
    expect(classifyInitiateError(err)).toEqual({ kind: 'hold', reason: 'storage', retryAfterMs: 5_000 })
  })

  it('reads code and message from a coded detail', async () => {
    stubFetch(
      errorResponse(503, {
        detail: { code: 'storage_unavailable', message: 'm', retry_after: 7 },
      }),
    )

    const err = await catchApiError(() => api.post('/upload/initiate', {}))

    expect(err).toMatchObject({
      status: 503,
      code: 'storage_unavailable',
      detail: 'm',
      retryAfter: 7,
    })
    // `message` is what every `err instanceof Error ? err.message` caller shows.
    expect(err.message).toBe('m')
  })

  it('falls back to the Retry-After header', async () => {
    stubFetch(errorResponse(503, { detail: 'x' }, { 'Retry-After': '4' }))

    const err = await catchApiError(() => api.get('/anything'))

    expect(err.retryAfter).toBe(4)
    expect(err.code).toBeUndefined()
    expect(err.detail).toBe('x')
  })

  it('keeps stringifying a dict detail with no code', async () => {
    stubFetch(errorResponse(400, { detail: { a: 1 } }))

    const err = await catchApiError(() => api.get('/anything'))

    expect(err.detail).toBe(JSON.stringify({ a: 1 }))
    expect(err.code).toBeUndefined()
  })

  it('leaves retryAfter undefined when nothing provides it', async () => {
    stubFetch(errorResponse(500, { detail: 'boom' }))

    const err = await catchApiError(() => api.get('/anything'))

    expect(err.retryAfter).toBeUndefined()
    expect(err.code).toBeUndefined()
  })

  it('prefers the body retry_after over the Retry-After header', async () => {
    stubFetch(
      errorResponse(
        503,
        { detail: { code: 'storage_unavailable', message: 'm', retry_after: 5 } },
        { 'Retry-After': '30' },
      ),
    )

    const err = await catchApiError(() => api.get('/anything'))

    expect(err.retryAfter).toBe(5)
  })

  it('takes the Retry-After header for a coded detail that carries no retry_after', async () => {
    stubFetch(
      errorResponse(
        503,
        { detail: { code: 'storage_unavailable', message: 'm' } },
        { 'Retry-After': '9' },
      ),
    )

    const err = await catchApiError(() => api.get('/anything'))

    expect(err).toMatchObject({ code: 'storage_unavailable', detail: 'm', retryAfter: 9 })
  })

  it('reads a coded detail with no retry hint as a plain coded error', async () => {
    stubFetch(errorResponse(500, { detail: { code: 'storage_error', message: 'm' } }))

    const err = await catchApiError(() => api.get('/anything'))

    expect(err).toMatchObject({ status: 500, code: 'storage_error', detail: 'm' })
    expect(err.retryAfter).toBeUndefined()
  })

  it('ignores a Retry-After that is a date, not integer seconds', async () => {
    stubFetch(
      errorResponse(503, { detail: 'x' }, { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' }),
    )

    const err = await catchApiError(() => api.get('/anything'))

    expect(err.retryAfter).toBeUndefined()
  })

  it('ignores a retry_after that is not a number and uses the header instead', async () => {
    stubFetch(
      errorResponse(
        503,
        { detail: { code: 'storage_unavailable', message: 'm', retry_after: '5' } },
        { 'Retry-After': '3' },
      ),
    )

    const err = await catchApiError(() => api.get('/anything'))

    expect(err.retryAfter).toBe(3)
  })

  it('does not treat a dict with a non-string code or no message as coded', async () => {
    stubFetch(errorResponse(400, { detail: { code: 7, message: 'm' } }))
    const noStringCode = await catchApiError(() => api.get('/anything'))
    expect(noStringCode.detail).toBe(JSON.stringify({ code: 7, message: 'm' }))
    expect(noStringCode.code).toBeUndefined()

    stubFetch(errorResponse(400, { detail: { code: 'c' } }))
    const noMessage = await catchApiError(() => api.get('/anything'))
    expect(noMessage.detail).toBe(JSON.stringify({ code: 'c' }))
    expect(noMessage.code).toBeUndefined()
  })

  it('keeps joining the messages of an array (422) detail', async () => {
    stubFetch(
      errorResponse(422, {
        detail: [{ msg: 'field required', loc: ['body', 'a'] }, { loc: ['body', 'b'] }],
      }),
    )

    const err = await catchApiError(() => api.post('/anything', {}))

    expect(err.detail).toBe('field required; Validation error')
    expect(err.code).toBeUndefined()
  })

  it('falls back to statusText when the body is not JSON', async () => {
    stubFetch(new Response('<html>bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }))

    const err = await catchApiError(() => api.get('/anything'))

    expect(err).toMatchObject({ status: 502, detail: 'Bad Gateway' })
    expect(err.code).toBeUndefined()
    expect(err.retryAfter).toBeUndefined()
  })

  it('carries code and retryAfter on the form upload path too', async () => {
    stubFetch(
      errorResponse(503, {
        detail: { code: 'storage_unavailable', message: 'm', retry_after: 7 },
      }),
    )

    const err = await catchApiError(() => api.upload('/upload', new FormData()))

    expect(err).toMatchObject({ status: 503, code: 'storage_unavailable', detail: 'm', retryAfter: 7 })
  })

  it('keeps the form upload path stringifying an uncoded dict detail', async () => {
    stubFetch(errorResponse(400, { detail: { a: 1 } }, { 'Retry-After': '2' }))

    const err = await catchApiError(() => api.upload('/upload', new FormData()))

    expect(err.detail).toBe(JSON.stringify({ a: 1 }))
    expect(err.retryAfter).toBe(2)
  })

  it('keeps the form upload path stringifying an array (422) detail', async () => {
    const detail = [{ msg: 'field required', loc: ['body', 'file'] }]
    stubFetch(errorResponse(422, { detail }))

    const err = await catchApiError(() => api.upload('/upload', new FormData()))

    expect(err.detail).toBe(JSON.stringify(detail))
  })

  it('accepts code and retryAfter through the constructor options', () => {
    const coded = new ApiError(503, 'm', { code: 'storage_unavailable', retryAfter: 5 })
    expect(coded).toMatchObject({ status: 503, detail: 'm', code: 'storage_unavailable', retryAfter: 5 })
    expect(coded.name).toBe('ApiError')
    expect(coded.message).toBe('m')

    const plain = new ApiError(404, 'gone')
    expect(plain.code).toBeUndefined()
    expect(plain.retryAfter).toBeUndefined()
  })
})
