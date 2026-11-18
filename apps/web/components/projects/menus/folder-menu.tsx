'use client'

import * as React from 'react'
import { FolderPlus, Pencil, Share2, Trash2 } from 'lucide-react'
import { MenuAction, MenuSeparator } from '@/components/shared/item-menu'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { NameDialog } from '../name-dialog'
import type { Folder } from '@/types'

export interface FolderMenuHandlers {
  onShare?: () => void
  onNewSubfolder?: () => void
  onRename?: () => void
  onDelete?: () => void
}

function hasAny(handlers: { [K in keyof FolderMenuHandlers]?: unknown }) {
  return !!(handlers.onShare || handlers.onNewSubfolder || handlers.onRename || handlers.onDelete)
}

/**
 * A folder's menu: the same everywhere a folder is shown (the tree, the grid,
 * the list), from its ⋯ button and on right-click. Each entry is shown only
 * when its action is, so share mode can leave them all out. Null when none is.
 */
export function FolderMenuItems(handlers: FolderMenuHandlers) {
  const { onShare, onNewSubfolder, onRename, onDelete } = handlers
  if (!hasAny(handlers)) return null
  return (
    <>
      {onShare && (
        <MenuAction icon={Share2} onSelect={onShare}>
          Create Share Link
        </MenuAction>
      )}
      {onNewSubfolder && (
        <MenuAction icon={FolderPlus} onSelect={onNewSubfolder}>
          New Subfolder
        </MenuAction>
      )}
      {(onShare || onNewSubfolder) && (onRename || onDelete) && <MenuSeparator />}
      {onRename && (
        <MenuAction icon={Pencil} onSelect={onRename}>
          Rename
        </MenuAction>
      )}
      {onDelete && (
        <MenuAction icon={Trash2} onSelect={onDelete} danger>
          Delete
        </MenuAction>
      )}
    </>
  )
}

/**
 * The folder menu for the grid and the list, where Rename and Delete ask in a
 * dialog. Returns the items (null when there are none) and the dialogs, which
 * the caller renders once next to the folder.
 */
export function useFolderMenu(
  folder: Pick<Folder, 'id' | 'name'>,
  actions: {
    onShare?: (folderId: string, folderName: string) => void
    onNewSubfolder?: (parentId: string) => void
    onRename?: (folderId: string, name: string) => Promise<void> | void
    onDelete?: (folderId: string) => Promise<void> | void
  },
) {
  const [renameOpen, setRenameOpen] = React.useState(false)
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const { onShare, onNewSubfolder, onRename, onDelete } = actions

  const items = (
    <FolderMenuItems
      onShare={onShare ? () => onShare(folder.id, folder.name) : undefined}
      onNewSubfolder={onNewSubfolder ? () => onNewSubfolder(folder.id) : undefined}
      onRename={onRename ? () => setRenameOpen(true) : undefined}
      onDelete={onDelete ? () => setDeleteOpen(true) : undefined}
    />
  )
  const itemsOrNull = hasAny({ onShare, onNewSubfolder, onRename, onDelete }) ? items : null

  const dialogs = (
    <>
      {onRename && (
        <NameDialog
          open={renameOpen}
          onOpenChange={setRenameOpen}
          title="Rename Folder"
          placeholder="Folder name"
          defaultValue={folder.name}
          submitLabel="Rename"
          onSubmit={async (name) => { await onRename(folder.id, name) }}
        />
      )}
      {onDelete && (
        <ConfirmDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          title={`Delete "${folder.name}"?`}
          description="This folder and all its contents will be moved to trash. You can restore them later."
          confirmLabel="Delete"
          variant="danger"
          onConfirm={() => onDelete(folder.id)}
        />
      )}
    </>
  )

  return { items: itemsOrNull, dialogs }
}

/** useFolderMenu for a folder rendered inside a list, where a hook can't be
 *  called per row: `children` gets the items, and the dialogs come along. */
export function WithFolderMenu({
  folder,
  actions,
  children,
}: {
  folder: Pick<Folder, 'id' | 'name'>
  actions: Parameters<typeof useFolderMenu>[1]
  children: (items: React.ReactNode) => React.ReactNode
}) {
  const { items, dialogs } = useFolderMenu(folder, actions)
  return (
    <>
      {children(items)}
      {dialogs}
    </>
  )
}
