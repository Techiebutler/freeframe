import { afterEach, describe, expect, it } from 'vitest'
import { deploymentRoot, withBasePath } from '../base-path'

const original = process.env.NEXT_PUBLIC_BASE_PATH

afterEach(() => {
  if (original === undefined) delete process.env.NEXT_PUBLIC_BASE_PATH
  else process.env.NEXT_PUBLIC_BASE_PATH = original
})

describe('deploymentRoot', () => {
  it('is the origin when no basePath is configured', () => {
    delete process.env.NEXT_PUBLIC_BASE_PATH
    expect(deploymentRoot('https://example.com')).toBe('https://example.com')
  })

  it('appends the basePath for sub-path deployments', () => {
    process.env.NEXT_PUBLIC_BASE_PATH = '/freeframe'
    expect(deploymentRoot('https://example.com')).toBe('https://example.com/freeframe')
  })

  it('does not double the slash on an origin with a trailing slash', () => {
    process.env.NEXT_PUBLIC_BASE_PATH = '/freeframe'
    expect(deploymentRoot('https://example.com/')).toBe('https://example.com/freeframe')
  })
})

describe('withBasePath', () => {
  it('prefixes raw navigations for sub-path deployments', () => {
    process.env.NEXT_PUBLIC_BASE_PATH = '/freeframe'
    expect(withBasePath('/6RBr')).toBe('/freeframe/6RBr')
  })

  it('is a no-op on root deployments', () => {
    delete process.env.NEXT_PUBLIC_BASE_PATH
    expect(withBasePath('/6RBr')).toBe('/6RBr')
  })
})
