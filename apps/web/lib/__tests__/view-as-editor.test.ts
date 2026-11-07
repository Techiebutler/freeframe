import { afterEach, describe, expect, it } from 'vitest'
import { canManageWorkspace, canManageWorkspaceReally, ownsProject } from '../workspace-access'

const owner = { id: 'u1', is_superadmin: false } as never
const project = { id: 'p1', role: 'owner', created_by: 'u1' } as never

describe('View as editor', () => {
  afterEach(() => window.localStorage.removeItem('ff:view-as-editor'))
  it('an owner manages the workspace normally', () => {
    expect(canManageWorkspace(owner, [project])).toBe(true)
    expect(ownsProject(owner, project)).toBe(true)
  })
  it('switched on, the owner sees the editor view but keeps the real right to switch back', () => {
    window.localStorage.setItem('ff:view-as-editor', '1')
    expect(canManageWorkspace(owner, [project])).toBe(false)
    expect(ownsProject(owner, project)).toBe(false)
    expect(canManageWorkspaceReally(owner, [project])).toBe(true)
  })
})
