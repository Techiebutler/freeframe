'use client'

import * as React from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { ChevronRight, Folder as FolderIcon, X, ArrowLeft, FolderInput } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type { FolderTreeNode } from '@/types'

interface MoveToDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectName: string
  tree: FolderTreeNode[]
  /** The folder currently being browsed (null = project root) */
  currentFolderId: string | null
  /** IDs of items being moved — disable moving into themselves */
  movingFolderIds?: string[]
  onMove: (targetFolderId: string | null) => void
}

/** Flatten tree to find a node by id */
function findNode(nodes: FolderTreeNode[], id: string): FolderTreeNode | null {
  for (const node of nodes) {
    if (node.id === id) return node
    const found = findNode(node.children, id)
    if (found) return found
  }
  return null
}

/** Build breadcrumb path from root to a given node id */
function buildPath(nodes: FolderTreeNode[], targetId: string): FolderTreeNode[] {
  for (const node of nodes) {
    if (node.id === targetId) return [node]
    const sub = buildPath(node.children, targetId)
    if (sub.length) return [node, ...sub]
  }
  return []
}

/** Check if candidateId is an ancestor-or-self of targetId */
function isAncestorOrSelf(nodes: FolderTreeNode[], candidateId: string, targetId: string): boolean {
  if (candidateId === targetId) return true
  const node = findNode(nodes, candidateId)
  if (!node) return false
  const path = buildPath(nodes, targetId)
  return path.some((n) => n.id === candidateId)
}

export function MoveToDialog({
  open,
  onOpenChange,
  projectName,
  tree,
  currentFolderId,
  movingFolderIds = [],
  onMove,
}: MoveToDialogProps) {
  // The folder we're browsing inside the dialog
  const [browseFolderId, setBrowseFolderId] = React.useState<string | null>(null)

  // Reset to root when dialog opens
  React.useEffect(() => {
    if (open) setBrowseFolderId(null)
  }, [open])

  // Children at current browse level
  const children = browseFolderId
    ? (findNode(tree, browseFolderId)?.children ?? [])
    : tree

  // Breadcrumb path
  const breadcrumbs = browseFolderId ? buildPath(tree, browseFolderId) : []

  // Can we move to this destination?
  // Disable: same as where items already are, or inside a folder being moved
  const isDisabled = (folderId: string | null): boolean => {
    if (folderId === currentFolderId) return true
    if (folderId !== null && movingFolderIds.some((mid) =>
      isAncestorOrSelf(tree, mid, folderId),
    )) return true
    return false
  }

  const targetIsRoot = browseFolderId === null

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] rounded-xl border border-border bg-bg-secondary shadow-2xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
          {/* Header */}
          <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
            {browseFolderId ? (
              <button
                onClick={() => setBrowseFolderId(breadcrumbs.length > 1 ? breadcrumbs[breadcrumbs.length - 2].id : null)}
                className="flex items-center justify-center h-6 w-6 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors shrink-0"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
            ) : (
              <FolderInput className="h-4 w-4 text-text-tertiary shrink-0" />
            )}

            {/* Breadcrumb */}
            <div className="flex items-center gap-1 flex-1 min-w-0 text-sm font-semibold text-text-primary truncate">
              <span
                className="cursor-pointer hover:text-accent transition-colors truncate"
                onClick={() => setBrowseFolderId(null)}
              >
                {projectName}
              </span>
              {breadcrumbs.map((crumb) => (
                <React.Fragment key={crumb.id}>
                  <ChevronRight className="h-3 w-3 text-text-tertiary shrink-0" />
                  <span
                    className="cursor-pointer hover:text-accent transition-colors truncate"
                    onClick={() => setBrowseFolderId(crumb.id)}
                  >
                    {crumb.name}
                  </span>
                </React.Fragment>
              ))}
            </div>

            <Dialog.Close className="flex items-center justify-center h-6 w-6 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors shrink-0">
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>

          {/* Folder list */}
          <div className="max-h-64 overflow-y-auto py-1">
            {children.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-text-tertiary">No subfolders</p>
            ) : (
              children.map((folder) => {
                const disabled = movingFolderIds.includes(folder.id)
                return (
                  <div
                    key={folder.id}
                    className={cn(
                      'flex items-center gap-2.5 px-3 py-2 transition-colors',
                      disabled
                        ? 'opacity-40 cursor-not-allowed'
                        : 'cursor-pointer hover:bg-bg-hover',
                    )}
                    onClick={() => !disabled && setBrowseFolderId(folder.id)}
                  >
                    <FolderIcon className="h-4 w-4 text-text-tertiary shrink-0" />
                    <span className="flex-1 text-sm text-text-primary truncate">{folder.name}</span>
                    {folder.children.length > 0 && (
                      <ChevronRight className="h-3.5 w-3.5 text-text-tertiary shrink-0" />
                    )}
                  </div>
                )
              })
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border">
            <Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={isDisabled(browseFolderId)}
              onClick={() => {
                onMove(browseFolderId)
                onOpenChange(false)
              }}
            >
              Move here
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
