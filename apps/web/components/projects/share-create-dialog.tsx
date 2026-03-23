'use client'

import * as React from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import {
  X,
  Copy,
  Check,
  Globe,
  Pencil,
  ExternalLink,
  FolderIcon,
  Image,
  Film,
  Music,
  Images,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import type { AssetResponse, Folder, ShareLink } from '@/types'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ShareCreateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  currentFolderId: string | null
  assets: AssetResponse[]
  folders: Folder[]
  onShareCreated: () => void
}

type SelectedItem =
  | { type: 'asset'; id: string; name: string; thumbnailUrl: string | null; assetType: string }
  | { type: 'folder'; id: string; name: string }

interface CreatedShareResult {
  token: string
  title: string
  itemType: 'asset' | 'folder'
  thumbnailUrl: string | null
}

// ─── Asset type icon helper ──────────────────────────────────────────────────

function AssetTypeIcon({ type, className }: { type: string; className?: string }) {
  switch (type) {
    case 'video':
      return <Film className={className} />
    case 'audio':
      return <Music className={className} />
    case 'image_carousel':
      return <Images className={className} />
    case 'image':
    default:
      return <Image className={className} />
  }
}

// ─── Copy button ─────────────────────────────────────────────────────────────

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = React.useState(false)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback
    }
  }

  return (
    <Button variant="secondary" size="sm" onClick={handleCopy}>
      {copied ? (
        <>
          <Check className="h-3.5 w-3.5 text-status-success" />
          {label ? 'Copied!' : ''}
        </>
      ) : (
        <>
          <Copy className="h-3.5 w-3.5" />
          {label ?? ''}
        </>
      )}
    </Button>
  )
}

// ─── Selection Phase ─────────────────────────────────────────────────────────

interface SelectionPhaseProps {
  assets: AssetResponse[]
  folders: Folder[]
  selectedItems: Map<string, SelectedItem>
  onToggle: (item: SelectedItem) => void
  onCancel: () => void
  onCreate: () => void
  creating: boolean
}

function SelectionPhase({
  assets,
  folders,
  selectedItems,
  onToggle,
  onCancel,
  onCreate,
  creating,
}: SelectionPhaseProps) {
  const hasItems = folders.length > 0 || assets.length > 0
  const hasSelection = selectedItems.size > 0

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-5 py-4">
        <Dialog.Title className="text-sm font-semibold text-text-primary">
          Select items to share
        </Dialog.Title>
        <Dialog.Close className="text-text-tertiary hover:text-text-primary transition-colors">
          <X className="h-4 w-4" />
        </Dialog.Close>
      </div>

      {/* Content */}
      <div className="px-5 py-4 max-h-[50vh] overflow-y-auto">
        {!hasItems ? (
          <p className="text-sm text-text-tertiary text-center py-8">
            No assets or folders in the current view.
          </p>
        ) : (
          <div className="space-y-1">
            {/* Folders */}
            {folders.map((folder) => {
              const key = `folder:${folder.id}`
              const isSelected = selectedItems.has(key)
              return (
                <label
                  key={key}
                  className={cn(
                    'flex items-center gap-3 rounded-lg px-3 py-2.5 cursor-pointer transition-colors',
                    isSelected ? 'bg-accent/10 border border-accent/30' : 'hover:bg-bg-hover border border-transparent',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() =>
                      onToggle({ type: 'folder', id: folder.id, name: folder.name })
                    }
                    className="rounded border-border accent-accent h-4 w-4 shrink-0"
                  />
                  <FolderIcon className="h-5 w-5 text-text-tertiary shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-text-primary truncate">{folder.name}</p>
                    <p className="text-2xs text-text-tertiary">
                      {folder.item_count} item{folder.item_count !== 1 ? 's' : ''}
                    </p>
                  </div>
                </label>
              )
            })}

            {/* Assets */}
            {assets.map((asset) => {
              const key = `asset:${asset.id}`
              const isSelected = selectedItems.has(key)
              return (
                <label
                  key={key}
                  className={cn(
                    'flex items-center gap-3 rounded-lg px-3 py-2.5 cursor-pointer transition-colors',
                    isSelected ? 'bg-accent/10 border border-accent/30' : 'hover:bg-bg-hover border border-transparent',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() =>
                      onToggle({
                        type: 'asset',
                        id: asset.id,
                        name: asset.name,
                        thumbnailUrl: asset.thumbnail_url,
                        assetType: asset.asset_type,
                      })
                    }
                    className="rounded border-border accent-accent h-4 w-4 shrink-0"
                  />
                  {/* Thumbnail */}
                  <div className="h-10 w-10 rounded bg-bg-tertiary border border-border overflow-hidden flex items-center justify-center shrink-0">
                    {asset.thumbnail_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={asset.thumbnail_url}
                        alt={asset.name}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <AssetTypeIcon type={asset.asset_type} className="h-4 w-4 text-text-tertiary" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-text-primary truncate">{asset.name}</p>
                    <p className="text-2xs text-text-tertiary capitalize">
                      {asset.asset_type.replace('_', ' ')}
                    </p>
                  </div>
                </label>
              )
            })}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-border px-5 py-3">
        <span className="text-xs text-text-tertiary">
          {selectedItems.size} item{selectedItems.size !== 1 ? 's' : ''} selected
        </span>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={onCreate}
            disabled={!hasSelection || creating}
            loading={creating}
          >
            Create Share Link
          </Button>
        </div>
      </div>
    </>
  )
}

// ─── Link Created Phase ──────────────────────────────────────────────────────

interface LinkCreatedPhaseProps {
  result: CreatedShareResult
  onDone: () => void
}

function LinkCreatedPhase({ result, onDone }: LinkCreatedPhaseProps) {
  const [title, setTitle] = React.useState(result.title)
  const [editingTitle, setEditingTitle] = React.useState(false)
  const [savingTitle, setSavingTitle] = React.useState(false)
  const [emailInput, setEmailInput] = React.useState('')
  const titleInputRef = React.useRef<HTMLInputElement>(null)

  const shareUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/share/${result.token}`
      : `/share/${result.token}`

  async function handleSaveTitle() {
    if (!title.trim() || title === result.title) {
      setTitle(result.title)
      setEditingTitle(false)
      return
    }
    setSavingTitle(true)
    try {
      await api.patch(`/share/${result.token}`, { title: title.trim() })
    } catch {
      setTitle(result.title)
    } finally {
      setSavingTitle(false)
      setEditingTitle(false)
    }
  }

  React.useEffect(() => {
    if (editingTitle && titleInputRef.current) {
      titleInputRef.current.focus()
      titleInputRef.current.select()
    }
  }, [editingTitle])

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-5 py-4">
        <div className="flex items-center gap-2 min-w-0">
          {editingTitle ? (
            <input
              ref={titleInputRef}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={handleSaveTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSaveTitle()
                if (e.key === 'Escape') {
                  setTitle(result.title)
                  setEditingTitle(false)
                }
              }}
              disabled={savingTitle}
              className="text-sm font-semibold text-text-primary bg-transparent border-b border-accent outline-none min-w-0"
            />
          ) : (
            <Dialog.Title className="text-sm font-semibold text-text-primary truncate">
              {title}
            </Dialog.Title>
          )}
          {!editingTitle && (
            <button
              onClick={() => setEditingTitle(true)}
              className="text-text-tertiary hover:text-text-primary transition-colors shrink-0"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <Dialog.Close className="text-text-tertiary hover:text-text-primary transition-colors">
          <X className="h-4 w-4" />
        </Dialog.Close>
      </div>

      {/* Content */}
      <div className="px-5 py-4 space-y-4">
        {/* Share URL */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <Globe className="h-3.5 w-3.5 text-status-success" />
            <span className="text-xs font-medium text-status-success">Public</span>
          </div>
          <div className="flex items-center gap-2 rounded-md border border-border bg-bg-tertiary px-3 py-2">
            <span className="flex-1 truncate font-mono text-xs text-text-primary">{shareUrl}</span>
            <button
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(shareUrl)
                } catch {
                  // fallback
                }
              }}
              className="text-text-tertiary hover:text-text-primary transition-colors shrink-0"
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Send to email */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-text-secondary">Send to name or email</label>
          <input
            type="text"
            value={emailInput}
            onChange={(e) => setEmailInput(e.target.value)}
            placeholder="Enter name or email..."
            className="flex h-9 w-full rounded-md border border-border bg-bg-secondary px-3 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-border-focus"
          />
        </div>

        {/* Preview thumbnail */}
        {result.thumbnailUrl && (
          <div className="rounded-lg border border-border bg-bg-tertiary overflow-hidden">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={result.thumbnailUrl}
              alt={title}
              className="w-full h-32 object-cover"
            />
          </div>
        )}

        {/* No thumbnail placeholder */}
        {!result.thumbnailUrl && (
          <div className="rounded-lg border border-border bg-bg-tertiary h-32 flex items-center justify-center">
            {result.itemType === 'folder' ? (
              <FolderIcon className="h-10 w-10 text-text-tertiary/40" />
            ) : (
              <Image className="h-10 w-10 text-text-tertiary/40" />
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-border px-5 py-3">
        <a
          href={shareUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-text-tertiary hover:text-text-secondary transition-colors flex items-center gap-1"
        >
          Advanced settings
          <ExternalLink className="h-3 w-3" />
        </a>
        <div className="flex items-center gap-2">
          <CopyButton text={shareUrl} label="Copy Link" />
          <Button size="sm" onClick={onDone}>
            Done
          </Button>
        </div>
      </div>
    </>
  )
}

// ─── Main Dialog ─────────────────────────────────────────────────────────────

export function ShareCreateDialog({
  open,
  onOpenChange,
  projectId,
  currentFolderId,
  assets,
  folders,
  onShareCreated,
}: ShareCreateDialogProps) {
  const [selectedItems, setSelectedItems] = React.useState<Map<string, SelectedItem>>(new Map())
  const [creating, setCreating] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [createdResult, setCreatedResult] = React.useState<CreatedShareResult | null>(null)

  // Reset state when dialog opens/closes
  React.useEffect(() => {
    if (open) {
      setSelectedItems(new Map())
      setCreating(false)
      setError(null)
      setCreatedResult(null)
    }
  }, [open])

  function handleToggle(item: SelectedItem) {
    const key = `${item.type}:${item.id}`
    setSelectedItems((prev) => {
      const next = new Map(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.set(key, item)
      }
      return next
    })
  }

  async function handleCreate() {
    if (selectedItems.size === 0) return
    setCreating(true)
    setError(null)

    try {
      // Take the first selected item to create a share link
      const firstItem = Array.from(selectedItems.values())[0]
      let shareLink: ShareLink

      if (firstItem.type === 'folder') {
        shareLink = await api.post<ShareLink>(`/folders/${firstItem.id}/share`, {
          title: firstItem.name,
        })
      } else {
        shareLink = await api.post<ShareLink>(`/assets/${firstItem.id}/share`, {
          title: firstItem.name,
        })
      }

      setCreatedResult({
        token: shareLink.token,
        title: shareLink.title || firstItem.name,
        itemType: firstItem.type,
        thumbnailUrl: firstItem.type === 'asset' ? firstItem.thumbnailUrl : null,
      })

      onShareCreated()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create share link')
    } finally {
      setCreating(false)
    }
  }

  function handleDone() {
    onOpenChange(false)
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2',
            'rounded-xl border border-border bg-bg-secondary shadow-xl',
            'max-h-[90vh] flex flex-col',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
          )}
        >
          <Dialog.Description className="sr-only">
            Select items to share and create a public share link.
          </Dialog.Description>

          {error && (
            <div className="mx-5 mt-4 rounded-md border border-status-error/30 bg-status-error/10 px-3 py-2">
              <p className="text-xs text-status-error">{error}</p>
            </div>
          )}

          {createdResult ? (
            <LinkCreatedPhase result={createdResult} onDone={handleDone} />
          ) : (
            <SelectionPhase
              assets={assets}
              folders={folders}
              selectedItems={selectedItems}
              onToggle={handleToggle}
              onCancel={() => onOpenChange(false)}
              onCreate={handleCreate}
              creating={creating}
            />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
