import { afterEach, describe, expect, it } from 'vitest'
import { withBasePath } from '../base-path'

const original = process.env.NEXT_PUBLIC_BASE_PATH

afterEach(() => {
  if (original === undefined) delete process.env.NEXT_PUBLIC_BASE_PATH
  else process.env.NEXT_PUBLIC_BASE_PATH = original
})

describe('withBasePath', () => {
  it('is a no-op on a root deployment', () => {
    delete process.env.NEXT_PUBLIC_BASE_PATH
    expect(withBasePath('/share/abc')).toBe('/share/abc')
  })

  it('prefixes app-absolute paths on a sub-path deployment', () => {
    process.env.NEXT_PUBLIC_BASE_PATH = '/freeframe'
    expect(withBasePath('/share/abc')).toBe('/freeframe/share/abc')
  })
})
