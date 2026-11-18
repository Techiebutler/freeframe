import { describe, it, expect } from 'vitest'
import { ApiError } from '@/lib/api'
import { classifyInitiateError } from '@/lib/upload-initiate-outcome'

const STORAGE_REFUSED = 'Storage refused the upload. Ask your admin to check the storage settings.'

describe('classifyInitiateError', () => {
  describe('refusal', () => {
    it.each([400, 403, 404, 422])('a %i is a refusal carrying the server detail', (status) => {
      expect(classifyInitiateError(new ApiError(status, 'No room for that file'))).toEqual({
        kind: 'refusal',
        message: 'No room for that file',
      })
    })

    it.each([402, 405, 410, 413, 418, 451, 499])(
      'any other 4xx (%i) except 401, 408 and 429 is a refusal',
      (status) => {
        expect(classifyInitiateError(new ApiError(status, 'Refused'))).toEqual({
          kind: 'refusal',
          message: 'Refused',
        })
      },
    )

    it('a 409 is a refusal', () => {
      expect(classifyInitiateError(new ApiError(409, 'Already exists'))).toEqual({
        kind: 'refusal',
        message: 'Already exists',
      })
    })

    it('a coded 4xx that is not a known code is still a refusal', () => {
      expect(classifyInitiateError(new ApiError(403, 'Not yours', { code: 'something_else' }))).toEqual({
        kind: 'refusal',
        message: 'Not yours',
      })
    })

    it('a refusal does not carry a retry delay', () => {
      const outcome = classifyInitiateError(new ApiError(422, 'Bad', { retryAfter: 5 }))
      expect(outcome).toEqual({ kind: 'refusal', message: 'Bad' })
      expect(outcome).not.toHaveProperty('retryAfterMs')
    })
  })

  describe('storage misconfigured', () => {
    it('code storage_error is storage_misconfigured with the server message', () => {
      expect(
        classifyInitiateError(new ApiError(500, 'Bucket is missing', { code: 'storage_error' })),
      ).toEqual({ kind: 'storage_misconfigured', message: 'Bucket is missing' })
    })

    it('storage_error is read before the status, so a 500 with that code is not a 5xx hold', () => {
      expect(
        classifyInitiateError(new ApiError(500, 'Bucket is missing', { code: 'storage_error' })).kind,
      ).toBe('storage_misconfigured')
    })

    it('storage_error is storage_misconfigured on any status', () => {
      expect(
        classifyInitiateError(new ApiError(403, 'Access denied', { code: 'storage_error' })),
      ).toEqual({ kind: 'storage_misconfigured', message: 'Access denied' })
    })

    it('an empty detail falls back to the storage-settings copy', () => {
      expect(classifyInitiateError(new ApiError(500, '', { code: 'storage_error' }))).toEqual({
        kind: 'storage_misconfigured',
        message: STORAGE_REFUSED,
      })
    })

    it('a blank detail falls back to the storage-settings copy', () => {
      expect(classifyInitiateError(new ApiError(500, '   ', { code: 'storage_error' }))).toEqual({
        kind: 'storage_misconfigured',
        message: STORAGE_REFUSED,
      })
    })

    it('a storage_error carries no retry delay', () => {
      const outcome = classifyInitiateError(
        new ApiError(500, 'Bucket is missing', { code: 'storage_error', retryAfter: 5 }),
      )
      expect(outcome).not.toHaveProperty('retryAfterMs')
    })
  })

  describe('hold (storage)', () => {
    it('code storage_unavailable is a storage hold with the server retry delay in ms', () => {
      expect(
        classifyInitiateError(
          new ApiError(503, 'Storage is busy', { code: 'storage_unavailable', retryAfter: 5 }),
        ),
      ).toEqual({ kind: 'hold', reason: 'storage', retryAfterMs: 5000 })
    })

    it('storage_unavailable without a retry delay is a storage hold with no retryAfterMs', () => {
      const outcome = classifyInitiateError(
        new ApiError(503, 'Storage is busy', { code: 'storage_unavailable' }),
      )
      expect(outcome).toEqual({ kind: 'hold', reason: 'storage' })
      expect(outcome).not.toHaveProperty('retryAfterMs')
    })

    it('storage_unavailable is read before the status, so it is a storage hold on any status', () => {
      expect(
        classifyInitiateError(new ApiError(502, 'Storage is busy', { code: 'storage_unavailable' })),
      ).toEqual({ kind: 'hold', reason: 'storage' })
      expect(
        classifyInitiateError(new ApiError(400, 'Storage is busy', { code: 'storage_unavailable' })),
      ).toEqual({ kind: 'hold', reason: 'storage' })
    })
  })

  describe('hold (connection)', () => {
    it('a TypeError (fetch could not reach the server) is a connection hold', () => {
      expect(classifyInitiateError(new TypeError('Failed to fetch'))).toEqual({
        kind: 'hold',
        reason: 'connection',
      })
    })

    it('a 401 with code refresh_unavailable is a connection hold', () => {
      expect(
        classifyInitiateError(new ApiError(401, 'Could not refresh', { code: 'refresh_unavailable' })),
      ).toEqual({ kind: 'hold', reason: 'connection' })
    })

    it('refresh_unavailable is read before the status, so it is a connection hold on any status', () => {
      expect(
        classifyInitiateError(new ApiError(403, 'Could not refresh', { code: 'refresh_unavailable' })),
      ).toEqual({ kind: 'hold', reason: 'connection' })
    })

    it('a 408 holds', () => {
      expect(classifyInitiateError(new ApiError(408, 'Request timeout'))).toEqual({
        kind: 'hold',
        reason: 'connection',
      })
    })

    it('a 429 holds, with the retry delay in ms', () => {
      expect(classifyInitiateError(new ApiError(429, 'Slow down', { retryAfter: 12 }))).toEqual({
        kind: 'hold',
        reason: 'connection',
        retryAfterMs: 12000,
      })
    })

    it('a 502 holds', () => {
      expect(classifyInitiateError(new ApiError(502, 'Bad gateway'))).toEqual({
        kind: 'hold',
        reason: 'connection',
      })
    })

    it('a 504 holds', () => {
      expect(classifyInitiateError(new ApiError(504, 'Gateway timeout'))).toEqual({
        kind: 'hold',
        reason: 'connection',
      })
    })

    it.each([500, 501, 503, 507, 599])('an uncoded %i holds', (status) => {
      expect(classifyInitiateError(new ApiError(status, 'Server trouble'))).toEqual({
        kind: 'hold',
        reason: 'connection',
      })
    })

    it('an uncoded 503 is a connection hold, not a storage hold', () => {
      expect(classifyInitiateError(new ApiError(503, 'Unavailable')).kind).toBe('hold')
      expect(classifyInitiateError(new ApiError(503, 'Unavailable'))).toHaveProperty(
        'reason',
        'connection',
      )
    })

    it('an unknown code on a 5xx holds', () => {
      expect(classifyInitiateError(new ApiError(500, 'Odd', { code: 'something_else' }))).toEqual({
        kind: 'hold',
        reason: 'connection',
      })
    })

    it('an uncoded 401 holds', () => {
      expect(classifyInitiateError(new ApiError(401, 'Not authenticated'))).toEqual({
        kind: 'hold',
        reason: 'connection',
      })
    })

    it('a 401 with an unknown code holds', () => {
      expect(classifyInitiateError(new ApiError(401, 'Nope', { code: 'something_else' }))).toEqual({
        kind: 'hold',
        reason: 'connection',
      })
    })

    it.each([0, 100, 302, 304])('any other ApiError not matched above (status %i) holds', (status) => {
      expect(classifyInitiateError(new ApiError(status, 'Odd'))).toEqual({
        kind: 'hold',
        reason: 'connection',
      })
    })

    it('a non-ApiError Error holds', () => {
      expect(classifyInitiateError(new Error('boom'))).toEqual({ kind: 'hold', reason: 'connection' })
    })

    it.each([['a string', 'boom'], ['undefined', undefined], ['null', null], ['an object', { a: 1 }]])(
      'a thrown %s holds',
      (_label, thrown) => {
        expect(classifyInitiateError(thrown)).toEqual({ kind: 'hold', reason: 'connection' })
      },
    )

    it('retryAfterMs is retryAfter * 1000', () => {
      expect(classifyInitiateError(new ApiError(429, 'Slow', { retryAfter: 1.5 }))).toEqual({
        kind: 'hold',
        reason: 'connection',
        retryAfterMs: 1500,
      })
    })

    it('a zero retryAfter is kept as 0 ms', () => {
      expect(classifyInitiateError(new ApiError(429, 'Slow', { retryAfter: 0 }))).toEqual({
        kind: 'hold',
        reason: 'connection',
        retryAfterMs: 0,
      })
    })

    it.each([
      ['negative', -1],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
    ])('a %s retryAfter is dropped', (_label, retryAfter) => {
      const outcome = classifyInitiateError(new ApiError(429, 'Slow', { retryAfter }))
      expect(outcome).toEqual({ kind: 'hold', reason: 'connection' })
      expect(outcome).not.toHaveProperty('retryAfterMs')
    })
  })

  describe('account', () => {
    it('code identity_changed is account', () => {
      expect(
        classifyInitiateError(new ApiError(401, 'Different user', { code: 'identity_changed' })),
      ).toEqual({ kind: 'account' })
    })

    it('identity_changed is read before the status', () => {
      expect(
        classifyInitiateError(new ApiError(403, 'Different user', { code: 'identity_changed' })),
      ).toEqual({ kind: 'account' })
    })
  })

  describe('session ended', () => {
    it('code session_ended is session_ended', () => {
      expect(
        classifyInitiateError(new ApiError(401, 'Signed out', { code: 'session_ended' })),
      ).toEqual({ kind: 'session_ended' })
    })

    it('session_ended is read before the status', () => {
      expect(
        classifyInitiateError(new ApiError(403, 'Signed out', { code: 'session_ended' })),
      ).toEqual({ kind: 'session_ended' })
    })
  })

  describe('abort', () => {
    it('rethrows AbortError', () => {
      const abort = new DOMException('The operation was aborted.', 'AbortError')
      expect(() => classifyInitiateError(abort)).toThrow(abort)
    })

    it('rethrows the very same AbortError object', () => {
      const abort = new DOMException('The operation was aborted.', 'AbortError')
      let caught: unknown
      try {
        classifyInitiateError(abort)
      } catch (err) {
        caught = err
      }
      expect(caught).toBe(abort)
    })

    it('rethrows an Error whose name is AbortError', () => {
      const abort = Object.assign(new Error('aborted'), { name: 'AbortError' })
      expect(() => classifyInitiateError(abort)).toThrow(abort)
    })

    it('does not rethrow other DOMExceptions', () => {
      expect(classifyInitiateError(new DOMException('Timed out', 'TimeoutError'))).toEqual({
        kind: 'hold',
        reason: 'connection',
      })
    })
  })
})
