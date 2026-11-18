'use client'

import { FolderOpen } from 'lucide-react'
import { EmptyState } from '@/components/shared/empty-state'

/**
 * `/settings/projects`: the list is the rail, so the page only prompts. On a
 * phone the shell hides this pane and shows the list in its place.
 */
export default function SettingsProjectsPage() {
  return <EmptyState icon={FolderOpen} title="Select a project" className="h-full" />
}
