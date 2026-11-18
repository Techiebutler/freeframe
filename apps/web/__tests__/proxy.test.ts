import { describe, expect, it } from 'vitest'

import { isPublicRoute } from '../proxy'

describe('isPublicRoute', () => {
  it('allows both long and short public share URLs without authentication', () => {
    expect(isPublicRoute('/share/a-long-share-token')).toBe(true)
    expect(isPublicRoute('/s/aShortShareCode')).toBe(true)
  })

  it('keeps dashboard routes protected', () => {
    expect(isPublicRoute('/projects')).toBe(false)
  })
})
