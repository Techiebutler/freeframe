import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  parseUploadConcurrency,
  serverUploadConcurrency,
  clientUploadConcurrency,
} from '../runtime-config'

afterEach(() => {
  vi.unstubAllEnvs()
  delete document.documentElement.dataset.ffUploadConcurrency
})

describe('parseUploadConcurrency', () => {
  it.each([undefined, 'abc', 0, -2, '', null])('falls back to 5 for %j', (raw) => {
    expect(parseUploadConcurrency(raw)).toBe(5)
  })

  it('rounds down a fractional value', () => {
    expect(parseUploadConcurrency('3.7')).toBe(3)
  })

  it('caps at 16', () => {
    expect(parseUploadConcurrency('99')).toBe(16)
  })

  it('accepts 1', () => {
    expect(parseUploadConcurrency('1')).toBe(1)
  })
})

describe('serverUploadConcurrency', () => {
  it('prefers UPLOAD_CONCURRENCY over the older NEXT_PUBLIC_ name', () => {
    vi.stubEnv('UPLOAD_CONCURRENCY', '3')
    vi.stubEnv('NEXT_PUBLIC_UPLOAD_CONCURRENCY', '9')
    expect(serverUploadConcurrency()).toBe(3)
  })

  it('falls back to NEXT_PUBLIC_UPLOAD_CONCURRENCY', () => {
    vi.stubEnv('UPLOAD_CONCURRENCY', undefined)
    vi.stubEnv('NEXT_PUBLIC_UPLOAD_CONCURRENCY', '2')
    expect(serverUploadConcurrency()).toBe(2)
  })

  it('is 5 when neither is set', () => {
    vi.stubEnv('UPLOAD_CONCURRENCY', undefined)
    vi.stubEnv('NEXT_PUBLIC_UPLOAD_CONCURRENCY', undefined)
    expect(serverUploadConcurrency()).toBe(5)
  })
})

describe('clientUploadConcurrency', () => {
  it('reads the value the server put on <html>', () => {
    document.documentElement.dataset.ffUploadConcurrency = '7'
    expect(clientUploadConcurrency()).toBe(7)
  })

  it('is 5 when the attribute is absent', () => {
    expect(clientUploadConcurrency()).toBe(5)
  })
})
