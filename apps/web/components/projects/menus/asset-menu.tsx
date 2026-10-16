'use client'

import * as React from 'react'
import { Download, Link as LinkIcon, Pencil, Share2, Trash2 } from 'lucide-react'
import { copyToClipboard } from '@/lib/utils'
import { withBasePath } from '@/lib/base-path'
import { DownloadSubmenu } from '@/components/shared/download-menu'
import { MenuAction, MenuSeparator } from '@/components/shared/item-menu'
import type { Asset, DownloadOption } from '@/types'

export interface AssetMenuHandlers {
  onShare?: () => void
  /** `rendition` is a DownloadOption id; left out, the server picks. */
  onDownload?: (rendition?: string) => void
  /** With this, Download opens a submenu of what the asset can be downloaded as. */
  loadDownloadOptions?: () => Promise<DownloadOption[] | null>
  onRename?: () => void
  onDelete?: () => void
}

/** An asset's menu, for its ⋯ button and its right-click alike. */
export function AssetMenuItems({
  asset,
  onShare,
  onDownload,
  loadDownloadOptions,
  onRename,
  onDelete,
}: AssetMenuHandlers & { asset: Pick<Asset, 'id' | 'project_id'> }) {
  return (
    <>
      <MenuAction icon={Share2} onSelect={() => onShare?.()}>
        Create Share Link
      </MenuAction>
      <MenuSeparator />
      {loadDownloadOptions && onDownload ? (
        <DownloadSubmenu load={loadDownloadOptions} onPick={onDownload} />
      ) : (
        <MenuAction icon={Download} onSelect={() => onDownload?.()}>
          Download
        </MenuAction>
      )}
      <MenuAction
        icon={LinkIcon}
        onSelect={() => {
          void copyToClipboard(
            `${window.location.origin}${withBasePath(`/projects/${asset.project_id}/assets/${asset.id}`)}`,
          )
        }}
      >
        Copy Asset URL
      </MenuAction>
      <MenuSeparator />
      <MenuAction icon={Pencil} onSelect={() => onRename?.()}>
        Rename
      </MenuAction>
      <MenuAction icon={Trash2} onSelect={() => onDelete?.()} danger>
        Delete
      </MenuAction>
    </>
  )
}
