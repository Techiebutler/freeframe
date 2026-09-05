'use client'

import React, { useState, useCallback } from 'react'
import {
  ChevronRight,
  FolderOpen,
  Folder as FolderIcon,
  Plus,
  Trash2,
  MoreHorizontal,
  Pencil,
  FolderPlus,
  Trash,
} from 'lucide-react'
import { cn } from '@/lib/utils'
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
  // Drag-drop targets
  onDropItems?: (targetFolderId: string | null, assetIds: string[], folderIds: string[]) => void
}

interface FolderNodeProps {
  node: FolderTreeNode
  depth: number
  currentFolderId: string | null
  onSelectFolder: (folderId: string | null) => void
  onCreateFolder: (name: string, parentId: string | null) => Promise<void>
  onRenameFolder: (folderId: string, name: string) => Promise<void>
  onDeleteFolder: (folderId: string) => Promise<void>
  onDropItems?: (targetFolderId: string | null, assetIds: string[], folderIds: string[]) => void
}

function FolderNode({
  node,
  depth,
  currentFolderId,
  onSelectFolder,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onDropItems,
}: FolderNodeProps) {
  const [expanded, setExpanded] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameName, setRenameName] = useState(node.name)
  const [isDragOver, setIsDragOver] = useState(false)
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

  // Drag-drop target
  const handleDragOver = useCallback((e: React.DragEvent) => {
    // A file dragged from the desktop is not a move: it belongs to the region's
    // upload handler, which sits above this in the tree. Returning without
    // preventDefault or stopPropagation lets it through untouched -- otherwise
    // this folder lights up as a target and then the drop lands somewhere else.
    if (carriesFiles(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback(() => setIsDragOver(false), [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      if (carriesFiles(e)) return
      e.preventDefault()
      setIsDragOver(false)
      try {
        const data = JSON.parse(e.dataTransfer.getData('application/json'))
        onDropItems?.(node.id, data.assetIds ?? [], data.folderIds ?? [])
      } catch {
        // ignore
      }
    },
    [node.id, onDropItems],
  )

  return (
    <div>
      <div
        className={cn(
          'group flex items-center gap-1 px-2 py-1 rounded-md text-[13px] cursor-pointer transition-colors',
          isActive
            ? 'bg-accent/10 text-accent font-medium'
            : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover',
          isDragOver && 'ring-2 ring-accent/50 bg-accent/5',
        )}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
        onClick={handleClick}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenuOpen((p) => !p)
        }}
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

        {/* Context menu button */}
        <button
          className="opacity-0 group-hover:opacity-100 shrink-0 h-5 w-5 flex items-center justify-center rounded hover:bg-bg-hover transition-opacity"
          onClick={(e) => {
            e.stopPropagation()
            setMenuOpen((p) => !p)
          }}
        >
          <MoreHorizontal className="h-3 w-3" />
        </button>
      </div>

      {/* Context menu */}
      {menuOpen && (
        <div className="ml-8 mt-0.5 mb-1 rounded-lg border border-border bg-bg-elevated shadow-xl py-1 z-50 w-44">
          <button
            className="flex w-full items-center gap-2 px-3 py-1.5 text-[12px] text-text-secondary hover:bg-bg-hover hover:text-text-primary"
            onClick={() => {
              setMenuOpen(false)
              setRenaming(true)
              setRenameName(node.name)
            }}
          >
            <Pencil className="h-3 w-3" /> Rename
          </button>
          <button
            className="flex w-full items-center gap-2 px-3 py-1.5 text-[12px] text-text-secondary hover:bg-bg-hover hover:text-text-primary"
            onClick={() => {
              setMenuOpen(false)
              onCreateFolder('', node.id)
            }}
          >
            <FolderPlus className="h-3 w-3" /> New Subfolder
          </button>
          <div className="my-1 border-t border-border" />
          <button
            className="flex w-full items-center gap-2 px-3 py-1.5 text-[12px] text-red-400 hover:bg-red-500/10"
            onClick={async () => {
              setMenuOpen(false)
              if (confirm(`Delete folder "${node.name}" and all its contents?`)) {
                await onDeleteFolder(node.id)
              }
            }}
          >
            <Trash className="h-3 w-3" /> Delete
          </button>
        </div>
      )}

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
              onDropItems={onDropItems}
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
  onDropItems,
}: FolderTreeProps) {
  const [isDragOverRoot, setIsDragOverRoot] = useState(false)

  return (
    <div className="space-y-0.5">
      {/* Project root */}
      <div
        className={cn(
          'flex items-center gap-2 px-2 py-1.5 rounded-md text-[13px] cursor-pointer transition-colors',
          currentFolderId === null && !showTrash
            ? 'bg-accent/10 text-accent font-medium'
            : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover',
          isDragOverRoot && 'ring-2 ring-accent/50 bg-accent/5',
        )}
        onClick={() => onSelectFolder(null)}
        onDragOver={(e) => {
          e.preventDefault()
          setIsDragOverRoot(true)
        }}
        onDragLeave={() => setIsDragOverRoot(false)}
        onDrop={(e) => {
          e.preventDefault()
          setIsDragOverRoot(false)
          try {
            const data = JSON.parse(e.dataTransfer.getData('application/json'))
            onDropItems?.(null, data.assetIds ?? [], data.folderIds ?? [])
          } catch {}
        }}
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
          onDropItems={onDropItems}
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
