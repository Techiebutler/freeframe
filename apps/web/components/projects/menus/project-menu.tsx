'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { ExternalLink, Link as LinkIcon, Settings, Trash2 } from 'lucide-react'
import { copyToClipboard } from '@/lib/utils'
import { withBasePath } from '@/lib/base-path'
import { MenuAction, MenuLabel, MenuSeparator } from '@/components/shared/item-menu'
import type { Project } from '@/types'

/**
 * A project's menu, for the card's ⋯ button and right-click on a card or a
 * list row. Owners only: everyone else gets null, and keeps the browser's menu.
 * The card is a link, and this menu replaces the browser's, so it carries the
 * two link entries people use there.
 *
 * Settings and Delete both open the project's settings page; deleting happens
 * on its Danger tab, behind a typed confirmation.
 */
export function useProjectMenu(project: Project, { isOwner }: { isOwner?: boolean }) {
  const router = useRouter()
  const canManage = isOwner || project.role === 'owner'
  const settingsPath = `/projects/${project.id}/settings`

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
      <MenuAction icon={Settings} onSelect={() => router.push(settingsPath)}>
        Project Settings
      </MenuAction>
      <MenuSeparator />
      <MenuAction icon={Trash2} onSelect={() => router.push(`${settingsPath}?tab=danger`)} danger>
        Delete Project
      </MenuAction>
    </>
  ) : null

  return { items }
}
