'use client'

import { FolderOpen } from 'lucide-react'
import { EmptyState } from '@/components/shared/empty-state'
import { useManageableProjects } from '@/components/settings/project-list'

/**
 * `/settings/projects`: the list is the rail, so the page only prompts. On a
 * phone the shell hides this pane and shows the list in its place.
 *
 * With nothing to select, the rail already says so, so the page stays empty
 * rather than add a second message.
 */
export default function SettingsProjectsPage() {
  const { rows } = useManageableProjects()
  if (rows.length === 0) return null
  return <EmptyState icon={FolderOpen} title="Select a project" className="h-full" />
}
