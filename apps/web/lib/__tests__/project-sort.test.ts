import { describe, it, expect } from 'vitest'
import { sortProjects } from '../project-sort'
import { compareNames } from '../utils'
import type { Project } from '@/types'

function project(name: string, created_at: string): Project {
  return {
    id: name, name, description: null, created_by: 'u1', project_type: 'personal',
    created_at, deleted_at: null,
  }
}

const projects = [
  project('Project 10', '2026-03-01T00:00:00Z'),
  project('project 2', '2026-01-01T00:00:00Z'),
  project('Alpha', '2026-02-01T00:00:00Z'),
]

describe('compareNames', () => {
  it('orders numbers by value and ignores case', () => {
    expect(['Project 10', 'project 2', 'Project 1'].sort(compareNames))
      .toEqual(['Project 1', 'project 2', 'Project 10'])
  })
})

describe('sortProjects', () => {
  it('sorts by name A-Z, numbers by value', () => {
    expect(sortProjects(projects, 'name', 'asc').map((p) => p.name))
      .toEqual(['Alpha', 'project 2', 'Project 10'])
  })

  it('sorts by date newest first', () => {
    expect(sortProjects(projects, 'date', 'desc').map((p) => p.name))
      .toEqual(['Project 10', 'Alpha', 'project 2'])
  })

  it('does not reorder the array it was given', () => {
    const before = projects.map((p) => p.name)
    sortProjects(projects, 'name', 'asc')
    expect(projects.map((p) => p.name)).toEqual(before)
  })
})
