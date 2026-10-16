'use client'

import React, { useState, useCallback, useMemo, useRef } from 'react'
import {
  ChevronRight,
  FolderOpen,
  Folder as FolderIcon,
  Plus,
  Trash2,
  MoreHorizontal,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { ContextMenuArea, DotsMenu } from '@/components/shared/item-menu'
import { FolderMenuItems } from './menus/folder-menu'
import type { FolderTreeNode } from '@/types'
import { carriesFiles } from '@/lib/drag'

interface FolderTreeProps {
  tree: FolderTreeNode[]
  projectName: string
  currentFolderId: string | null // null = root
  showTrash: boolean
  onSelectFolder: (folderId: string | null) => void
  onShowTrash: () => void
  onCreateFolder: (name: string, parentId: string | null) => Promise<void>
  onRenameFolder: (folderId: string, name: string) => Promise<void>
  onDeleteFolder: (folderId: string) => Promise<void>
  /** Create Share Link in a folder's menu. Absent = not offered. */
  onShareFolder?: (folderId: string, folderName: string) => void
  // Drag-drop targets
  onDropItems?: (targetFolderId: string | null, assetIds: string[], folderIds: string[]) => void
  /** Files dropped on a folder row upload into it, `null` being the project
   *  root. Absent = uploads not allowed. */
  onDropFiles?: (targetFolderId: string | null, files: File[]) => void
  /** See FolderCard: lets the region above shrink its marking to this row. */
  onFileDragOverFolder?: (folderId: string | null, from?: string) => void
  /** Which folder currently holds the file-drag marking, so exactly one row can
   *  be lit. See FolderCard. */
  fileDragTarget?: string | null
}

/**
 * Identifies the project-root row in the page's single-owner drag marking.
 *
 * `null` is already spoken for there: it means "released". Folder ids are
 * UUIDs, so a sentinel that is not one cannot collide with a real row.
 */
export const PROJECT_ROOT_ROW = '__project_root__'

/**
 * The drag behaviour of one row of the tree, file drags and item drags alike.
 *
 * The project root and every folder row want exactly this. They used to carry
 * two copies of it, and the root's was the shorter one -- what it was missing
 * did not show up by reading it. It had no depth counter, so it blinked as the
 * pointer crossed its own icon and label; and it lit from its own state instead
 * of reporting to the page, so it was invisible to the release logic: crossing
 * up from a folder row lit the root at once while the folder row only scheduled
 * its guarded release, and both wore the ring for that window -- the exact
 * condition the timer and the `from` guard exist to prevent.
 *
 * One implementation is what makes the invariant hold rather than being
 * restated. The callbacks take no folder id: each row closes over its own, so
 * the root's `null` and a folder's id are the caller's business.
 */
function useRowFileDrag({
  rowId,
  onDropFiles,
  onDropItems,
  onFileDragOverFolder,
}: {
  /** Identifies this row in the page's marking. */
  rowId: string
  /** Absent = this row does not take files, and says so with a `none` cursor. */
  onDropFiles?: (files: File[]) => void
  onDropItems?: (assetIds: string[], folderIds: string[]) => void
  onFileDragOverFolder?: (folderId: string | null, from?: string) => void
}) {
  const [isDragOver, setIsDragOver] = useState(false)
  // Counted rather than toggled, because the row's own children raise
  // dragenter/dragleave as the pointer crosses them.
  const dragDepth = useRef(0)

  const clearDrag = useCallback(() => {
    dragDepth.current = 0
    setIsDragOver(false)
    onFileDragOverFolder?.(null, rowId)
  }, [rowId, onFileDragOverFolder])

  const onDragEnter = useCallback(
    (e: React.DragEvent) => {
      if (!carriesFiles(e) || !onDropFiles) return
      e.preventDefault()
      // Deliberately NOT stopPropagation: the region above counts dragenter
      // against dragleave to know when the pointer has left it entirely, and
      // swallowing one half of that pair makes its counter drift.
      dragDepth.current += 1
      // No local highlight for a file drag: the page owns the marking, so two
      // rows cannot both be lit while the pointer is between them.
      onFileDragOverFolder?.(rowId)
    },
    [rowId, onDropFiles, onFileDragOverFolder],
  )

  const onDragOver = useCallback(
    (e: React.DragEvent) => {
      if (carriesFiles(e)) {
        // Refusing still means preventing the default. Without it the browser
        // handles the drop itself and navigates the tab to `file:///...`,
        // losing whatever is unsaved. `none` is what tells the pointer so.
        e.preventDefault()
        if (!onDropFiles) {
          e.dataTransfer.dropEffect = 'none'
          return
        }
        // A row is a more specific target than the shell behind it, so it takes
        // the event rather than letting the shell's refusal overwrite the
        // cursor over one of the few places a file can actually go.
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'copy'
        // Re-asserted on every dragover, not only on entry: this is what makes
        // the marking recover by itself if anything ever releases it early.
        onFileDragOverFolder?.(rowId)
        return
      }
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setIsDragOver(true)
    },
    [rowId, onDropFiles, onFileDragOverFolder],
  )

  const onDragLeave = useCallback(
    (e: React.DragEvent) => {
      if (carriesFiles(e) && onDropFiles) {
        // See onDragEnter: this half bubbles too, or the region's count of its
        // own children never comes back down.
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current > 0) return
      }
      clearDrag()
    },
    [clearDrag, onDropFiles],
  )

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (carriesFiles(e)) {
        // See onDragOver: prevented whether or not it is accepted.
        e.preventDefault()
        if (!onDropFiles) return
        e.stopPropagation()
        clearDrag()
        // Handed over even when the list is empty, which is what several
        // promised-file sources on macOS produce: the caller owns the region
        // marking, and it has to come down either way. Uploading nothing is a
        // no-op there.
        onDropFiles(Array.from(e.dataTransfer.files))
        return
      }
      e.preventDefault()
      setIsDragOver(false)
      try {
        const data = JSON.parse(e.dataTransfer.getData('application/json'))
        onDropItems?.(data.assetIds ?? [], data.folderIds ?? [])
      } catch {
        // ignore
      }
    },
    [clearDrag, onDropFiles, onDropItems],
  )

  return {
    isDragOver,
    dragHandlers: { onDragEnter, onDragOver, onDragLeave, onDrop },
  }
}

interface FolderNodeProps {
  node: FolderTreeNode
  depth: number
  currentFolderId: string | null
  onSelectFolder: (folderId: string | null) => void
  onCreateFolder: (name: string, parentId: string | null) => Promise<void>
  onRenameFolder: (folderId: string, name: string) => Promise<void>
  onDeleteFolder: (folderId: string) => Promise<void>
  onShareFolder?: (folderId: string, folderName: string) => void
  onDropItems?: (targetFolderId: string | null, assetIds: string[], folderIds: string[]) => void
  /** Files dropped on a folder row upload into it. Absent = uploads not allowed. */
  onDropFiles?: (targetFolderId: string, files: File[]) => void
  /** See FolderCard: lets the region above shrink its marking to this row. */
  onFileDragOverFolder?: (folderId: string | null, from?: string) => void
  /** See FolderTreeProps. */
  fileDragTarget?: string | null
}

function FolderNode({
  node,
  depth,
  currentFolderId,
  onSelectFolder,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onShareFolder,
  onDropItems,
  onDropFiles,
  onFileDragOverFolder,
  fileDragTarget,
}: FolderNodeProps) {
  const [expanded, setExpanded] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameName, setRenameName] = useState(node.name)
  // Rename is picked in the menu but starts once the menu has closed. While it
  // is open its focus trap takes focus back from a new field, and when it
  // closes it hands focus to the row; either blurs the field, and blur ends
  // the rename. So the pick is remembered, and acted on as the menu lets go.
  const renamePicked = useRef(false)
  const startRenameAfterClose = useCallback((e: Event) => {
    if (!renamePicked.current) return
    renamePicked.current = false
    e.preventDefault()
    setRenameName(node.name)
    setRenaming(true)
  }, [node.name])
  const isActive = currentFolderId === node.id

  const hasChildren = node.children.length > 0

  const handleClick = useCallback(() => {
    onSelectFolder(node.id)
    if (hasChildren) setExpanded((p) => !p)
  }, [node.id, hasChildren, onSelectFolder])

  const handleRename = useCallback(async () => {
    if (renameName.trim() && renameName !== node.name) {
      await onRenameFolder(node.id, renameName.trim())
    }
    setRenaming(false)
  }, [renameName, node.id, node.name, onRenameFolder])

  const { isDragOver, dragHandlers } = useRowFileDrag({
    rowId: node.id,
    onDropFiles: useMemo(
      () => (onDropFiles ? (files: File[]) => onDropFiles(node.id, files) : undefined),
      [onDropFiles, node.id],
    ),
    onDropItems: useMemo(
      () => (assetIds: string[], folderIds: string[]) =>
        onDropItems?.(node.id, assetIds, folderIds),
      [onDropItems, node.id],
    ),
    onFileDragOverFolder,
  })

  // The same items for the ⋯ button and right-click. Rename stays inline here,
  // where the grid asks in a dialog.
  const menuItems = (
    <FolderMenuItems
      onShare={onShareFolder ? () => onShareFolder(node.id, node.name) : undefined}
      onNewSubfolder={() => onCreateFolder('', node.id)}
      onRename={() => {
        renamePicked.current = true
      }}
      onDelete={async () => {
        if (confirm(`Delete folder "${node.name}" and all its contents?`)) {
          await onDeleteFolder(node.id)
        }
      }}
    />
  )

  return (
    <div>
      {/* Right-click opens the folder's menu; while renaming, the input gets
          the browser's own menu back. */}
      <ContextMenuArea items={menuItems} disabled={renaming} onCloseAutoFocus={startRenameAfterClose}>
      <div
        className={cn(
          'group flex items-center gap-1 px-2 py-1 rounded-md text-[13px] cursor-pointer transition-colors',
          isActive
            ? 'bg-accent/10 text-accent font-medium'
            : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover',
          (isDragOver || fileDragTarget === node.id) && 'ring-2 ring-accent/50 bg-accent/5',
        )}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
        onClick={handleClick}
        {...dragHandlers}
      >
        {/* Expand chevron */}
        <span className={cn('shrink-0 transition-transform', expanded && 'rotate-90')}>
          {hasChildren ? (
            <ChevronRight className="h-3 w-3" />
          ) : (
            <span className="w-3" />
          )}
        </span>

        {/* Icon */}
        {isActive || expanded ? (
          <FolderOpen className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <FolderIcon className="h-3.5 w-3.5 shrink-0" />
        )}

        {/* Name */}
        {renaming ? (
          <input
            className="flex-1 min-w-0 bg-transparent border-b border-accent outline-none text-[13px] text-text-primary px-0.5"
            value={renameName}
            onChange={(e) => setRenameName(e.target.value)}
            onBlur={handleRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRename()
              if (e.key === 'Escape') setRenaming(false)
            }}
            autoFocus
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="truncate flex-1 min-w-0">{node.name}</span>
        )}

        {/* Item count */}
        {node.item_count > 0 && !renaming && (
          <span className="text-[10px] text-text-tertiary shrink-0">{node.item_count}</span>
        )}

        {/* Menu button */}
        <DotsMenu items={menuItems} onCloseAutoFocus={startRenameAfterClose}>
          <button
            aria-label={`${node.name} menu`}
            className="opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 shrink-0 h-5 w-5 flex items-center justify-center rounded hover:bg-bg-hover transition-opacity"
            // Opening the menu is not a click on the folder.
            onClick={(e) => e.stopPropagation()}
          >
            <MoreHorizontal className="h-3 w-3" />
          </button>
        </DotsMenu>
      </div>
      </ContextMenuArea>

      {/* Children */}
      {expanded && hasChildren && (
        <div>
          {node.children.map((child) => (
            <FolderNode
              key={child.id}
              node={child}
              depth={depth + 1}
              currentFolderId={currentFolderId}
              onSelectFolder={onSelectFolder}
              onCreateFolder={onCreateFolder}
              onRenameFolder={onRenameFolder}
              onDeleteFolder={onDeleteFolder}
              onShareFolder={onShareFolder}
              onDropItems={onDropItems}
              onDropFiles={onDropFiles}
              onFileDragOverFolder={onFileDragOverFolder}
              fileDragTarget={fileDragTarget}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function FolderTree({
  tree,
  projectName,
  currentFolderId,
  showTrash,
  onSelectFolder,
  onShowTrash,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onShareFolder,
  onDropItems,
  onDropFiles,
  onFileDragOverFolder,
  fileDragTarget,
}: FolderTreeProps) {
  // The root row is a row like any other: same hook, same reporting, so the
  // page's "exactly one frame is lit" holds here too rather than stopping at
  // the folders. `null` as the drop target is what this row means by itself.
  const { isDragOver: isDragOverRoot, dragHandlers: rootDragHandlers } =
    useRowFileDrag({
      rowId: PROJECT_ROOT_ROW,
      onDropFiles: useMemo(
        () => (onDropFiles ? (files: File[]) => onDropFiles(null, files) : undefined),
        [onDropFiles],
      ),
      onDropItems: useMemo(
        () => (assetIds: string[], folderIds: string[]) =>
          onDropItems?.(null, assetIds, folderIds),
        [onDropItems],
      ),
      onFileDragOverFolder,
    })

  return (
    <div className="space-y-0.5">
      {/* Project root */}
      <div
        className={cn(
          'flex items-center gap-2 px-2 py-1.5 rounded-md text-[13px] cursor-pointer transition-colors',
          currentFolderId === null && !showTrash
            ? 'bg-accent/10 text-accent font-medium'
            : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover',
          (isDragOverRoot || fileDragTarget === PROJECT_ROOT_ROW) &&
            'ring-2 ring-accent/50 bg-accent/5',
        )}
        onClick={() => onSelectFolder(null)}
        {...rootDragHandlers}
      >
        <FolderOpen className="h-4 w-4 shrink-0" />
        <span className="truncate">{projectName}</span>
      </div>

      {/* Folder tree */}
      {tree.map((node) => (
        <FolderNode
          key={node.id}
          node={node}
          depth={1}
          currentFolderId={currentFolderId}
          onSelectFolder={onSelectFolder}
          onCreateFolder={onCreateFolder}
          onRenameFolder={onRenameFolder}
          onDeleteFolder={onDeleteFolder}
          onShareFolder={onShareFolder}
          onDropItems={onDropItems}
          onDropFiles={onDropFiles}
          onFileDragOverFolder={onFileDragOverFolder}
          fileDragTarget={fileDragTarget}
        />
      ))}

      {/* Recently Deleted */}
      <div
        className={cn(
          'flex items-center gap-2 px-2 py-1 rounded-md text-[13px] cursor-pointer transition-colors mt-2',
          showTrash
            ? 'bg-accent/10 text-accent font-medium'
            : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover',
        )}
        onClick={onShowTrash}
      >
        <Trash2 className="h-3.5 w-3.5 shrink-0" />
        <span>Recently Deleted</span>
      </div>
    </div>
  )
}
