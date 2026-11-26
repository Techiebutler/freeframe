import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import { currentAppPath, withBasePath } from '../base-path'

const require = createRequire(import.meta.url)

function loadNextConfig() {
  const path = require.resolve('../../next.config.js')
  delete require.cache[path]
  return require('../../next.config.js')
}

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

describe('currentAppPath', () => {
  it.each([
    ['/freeframe/projects?view=mine', '/projects?view=mine'],
    ['/freeframe', '/'],
    ['/freeframe-preview/projects', '/freeframe-preview/projects'],
  ])('returns the app path for %s', (url, expected) => {
    process.env.NEXT_PUBLIC_BASE_PATH = '/freeframe'
    const previous = window.location.href
    window.history.replaceState(null, '', url)
    try {
      expect(currentAppPath()).toBe(expected)
    } finally {
      window.history.replaceState(null, '', previous)
    }
  })
})

describe('next.config basePath', () => {
  it('serves the domain root when the variable is unset', () => {
    delete process.env.NEXT_PUBLIC_BASE_PATH
    expect(loadNextConfig().basePath).toBe('')
  })

  it('reads NEXT_PUBLIC_BASE_PATH into basePath', () => {
    process.env.NEXT_PUBLIC_BASE_PATH = '/freeframe'
    expect(loadNextConfig().basePath).toBe('/freeframe')
  })
})
