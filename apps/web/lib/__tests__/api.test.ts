import { describe, it, expect, beforeEach, vi } from 'vitest'
import { api, ApiError } from '../api'

vi.mock('../auth', () => ({
  getAccessToken: vi.fn(() => null),
  refreshAccessToken: vi.fn(() => Promise.resolve(null)),
}))

import { getAccessToken, refreshAccessToken } from '../auth'

describe('API client', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('successful GET request returns JSON data', async () => {
    const mockData = { id: '1', name: 'Test' }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (key: string) => key === 'content-type' ? 'application/json' : null,
      },
      json: () => Promise.resolve(mockData),
      text: () => Promise.resolve(JSON.stringify(mockData)),
    }))

    const result = await api.get('/test')
    expect(result).toEqual(mockData)
  })

  it('adds Bearer token header when token exists', async () => {
    vi.mocked(getAccessToken).mockReturnValue('my-token')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (key: string) => key === 'content-type' ? 'application/json' : null,
      },
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(JSON.stringify({})),
    }))

    await api.get('/test')

    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer my-token',
        }),
      }),
    )
  })

  it('throws ApiError on non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      headers: {
        get: () => 'application/json',
      },
      json: () => Promise.resolve({ detail: 'Resource not found' }),
    }))

    await expect(api.get('/missing')).rejects.toThrow(ApiError)
    await expect(api.get('/missing')).rejects.toMatchObject({
      status: 404,
      detail: 'Resource not found',
    })
  })

  it('401 triggers token refresh and retries request', async () => {
    const newToken = 'refreshed-token'
    vi.mocked(refreshAccessToken).mockResolvedValue(newToken)

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        headers: { get: () => 'application/json' },
        json: () => Promise.resolve({ detail: 'Token expired' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: {
          get: (key: string) => key === 'content-type' ? 'application/json' : null,
        },
        json: () => Promise.resolve({ success: true }),
        text: () => Promise.resolve(JSON.stringify({ success: true })),
      })

    vi.stubGlobal('fetch', fetchMock)

    const result = await api.get('/protected')
    expect(result).toEqual({ success: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // Second call should use the refreshed token
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Bearer ${newToken}`,
        }),
      }),
    )
  })

  it('returns undefined for 204 No Content responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      headers: {
        get: () => null,
      },
    }))

    const result = await api.delete('/test/1')
    expect(result).toBeUndefined()
  })
})
