import { describe, expect, it } from 'vitest'
import { isProjectListKey } from '../project-keys'

// The project list is cached under `/projects` and `/projects?scope=all`. A
// revalidation by this matcher must not reach a project's own keys.

describe('isProjectListKey', () => {
  it('matches the list keys', () => {
    expect(isProjectListKey('/projects')).toBe(true)
    expect(isProjectListKey('/projects?scope=all')).toBe(true)
  })

  it('leaves a project and what belongs to it alone', () => {
    expect(isProjectListKey('/projects/p1')).toBe(false)
    expect(isProjectListKey('/projects/p1/assets')).toBe(false)
    expect(isProjectListKey('/projectsx')).toBe(false)
  })

  it('ignores keys that are not strings', () => {
    expect(isProjectListKey(null)).toBe(false)
    expect(isProjectListKey(['/projects'])).toBe(false)
  })
})
