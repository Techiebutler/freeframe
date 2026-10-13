import { compareNames } from './utils'
import type { Project } from '@/types'
import type { ProjectSortKey } from '@/stores/projects-view-store'
import type { SortDirection } from '@/stores/view-store'

/** Projects in the order the Projects page's sort menu asks for. */
export function sortProjects(
  projects: Project[],
  key: ProjectSortKey,
  direction: SortDirection,
): Project[] {
  return [...projects].sort((a, b) => {
    const cmp =
      key === 'name'
        ? compareNames(a.name, b.name)
        : new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    return direction === 'asc' ? cmp : -cmp
  })
}
