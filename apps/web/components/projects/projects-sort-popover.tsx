'use client'

import { SortPopoverView, dateDirectionLabels, type SortOption } from './sort-popover'
import { useProjectsViewStore, type ProjectSortKey } from '@/stores/projects-view-store'

const projectSortOptions: SortOption<ProjectSortKey>[] = [
  { value: 'date', label: 'Date', directionLabels: dateDirectionLabels },
  { value: 'name', label: 'Name' },
]

/** Sort options for the Projects page — only the ones projects have. */
export function ProjectsSortPopover() {
  const { sortKey, setSortKey, sortDirection, toggleSortDirection } = useProjectsViewStore()

  return (
    <SortPopoverView
      options={projectSortOptions}
      sortKey={sortKey}
      sortDirection={sortDirection}
      onSortKeyChange={setSortKey}
      onToggleDirection={toggleSortDirection}
    />
  )
}
