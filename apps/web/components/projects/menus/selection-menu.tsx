'use client'

import * as React from 'react'
import { Download, FolderInput, Share2, Trash2 } from 'lucide-react'
import { MenuAction, MenuLabel, MenuSeparator } from '@/components/shared/item-menu'

export interface SelectionActions {
  onShare?: () => void
  onDownload?: () => void
  onMove?: () => void
  onDelete?: () => void
}

/**
 * Right-click on an item inside a selection of several: the selection bar's
 * actions, for everything selected rather than the one item under the pointer.
 */
export function SelectionMenuItems({ count, onShare, onDownload, onMove, onDelete }: SelectionActions & { count: number }) {
  return (
    <>
      <MenuLabel>{count} items selected</MenuLabel>
      {onShare && (
        <MenuAction icon={Share2} onSelect={onShare}>
          Create Share Link
        </MenuAction>
      )}
      {onDownload && (
        <MenuAction icon={Download} onSelect={onDownload}>
          Download
        </MenuAction>
      )}
      {onMove && (
        <MenuAction icon={FolderInput} onSelect={onMove}>
          Move to…
        </MenuAction>
      )}
      {onDelete && (
        <>
          <MenuSeparator />
          <MenuAction icon={Trash2} onSelect={onDelete} danger>
            Delete
          </MenuAction>
        </>
      )}
    </>
  )
}
