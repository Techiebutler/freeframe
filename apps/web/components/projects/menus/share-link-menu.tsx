'use client'

import * as React from 'react'
import { ExternalLink, Link as LinkIcon, MinusCircle, Trash2 } from 'lucide-react'
import { copyToClipboard } from '@/lib/utils'
import { withBasePath } from '@/lib/base-path'
import { MenuAction, MenuSeparator } from '@/components/shared/item-menu'

function shareUrl(link: { token: string; short_code?: string | null }) {
  return `${window.location.origin}${withBasePath(
    link.short_code ? `/s/${link.short_code}` : `/share/${link.token}`,
  )}`
}

/** A share link's menu, in the sidebar list and the Share Links table alike. */
export function ShareLinkMenuItems({
  link,
  onToggleEnabled,
  onDelete,
}: {
  link: { token: string; short_code?: string | null; is_enabled: boolean }
  onToggleEnabled: (token: string, enabled: boolean) => void
  onDelete: (token: string) => void
}) {
  return (
    <>
      <MenuAction icon={ExternalLink} onSelect={() => window.open(shareUrl(link), '_blank')} immediate>
        Open Share
      </MenuAction>
      <MenuAction icon={LinkIcon} onSelect={() => { void copyToClipboard(shareUrl(link)) }} immediate>
        Copy Link
      </MenuAction>
      <MenuSeparator />
      <MenuAction icon={MinusCircle} onSelect={() => onToggleEnabled(link.token, !link.is_enabled)}>
        {link.is_enabled ? 'Disable Access' : 'Enable Access'}
      </MenuAction>
      <MenuAction icon={Trash2} onSelect={() => onDelete(link.token)} danger>
        Delete
      </MenuAction>
    </>
  )
}
