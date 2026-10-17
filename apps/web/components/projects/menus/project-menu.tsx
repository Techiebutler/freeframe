'use client'

import * as React from 'react'
import { ExternalLink, Link as LinkIcon, Settings, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { copyToClipboard } from '@/lib/utils'
import { withBasePath } from '@/lib/base-path'
import { MenuAction, MenuLabel, MenuSeparator } from '@/components/shared/item-menu'
import { ProjectSettingsDialog } from '../project-settings-dialog'
import type { Project } from '@/types'

/**
 * A project's menu, for the card's ⋯ button and right-click on a card or a
 * list row. Owners only: everyone else gets null, and keeps the browser's menu.
 * The card is a link, and this menu replaces the browser's, so it carries the
 * two link entries people use there.
 * The settings dialog comes back as `dialogs`, for the caller to render once.
 */
export function useProjectMenu(
  project: Project,
  { isOwner, onMutate }: { isOwner?: boolean; onMutate?: () => void },
) {
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)
  const canManage = isOwner || project.role === 'owner'

  const handleDelete = async () => {
    if (!confirm(`Delete "${project.name}"? This action cannot be undone.`)) return
    setDeleting(true)
    try {
      await api.delete(`/projects/${project.id}`)
      onMutate?.()
    } catch {
      // silently fail
    } finally {
      setDeleting(false)
    }
  }

  const projectUrl = () => `${window.location.origin}${withBasePath(`/projects/${project.id}`)}`

  const items = canManage ? (
    <>
      <MenuLabel>Project</MenuLabel>
      <MenuAction icon={ExternalLink} onSelect={() => window.open(projectUrl(), '_blank')} immediate>
        Open in New Tab
      </MenuAction>
      <MenuAction icon={LinkIcon} onSelect={() => { void copyToClipboard(projectUrl()) }} immediate>
        Copy Link
      </MenuAction>
      <MenuSeparator />
      <MenuAction icon={Settings} onSelect={() => setSettingsOpen(true)}>
        Project Settings
      </MenuAction>
      <MenuSeparator />
      <MenuAction icon={Trash2} onSelect={handleDelete} disabled={deleting} danger>
        Delete
      </MenuAction>
    </>
  ) : null

  const dialogs = canManage ? (
    <ProjectSettingsDialog
      project={project}
      open={settingsOpen}
      onOpenChange={setSettingsOpen}
      onUpdated={() => onMutate?.()}
    />
  ) : null

  return { items, dialogs }
}
