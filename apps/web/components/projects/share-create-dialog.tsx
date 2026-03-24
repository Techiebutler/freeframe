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
  ChevronRight,
  ChevronLeft,
  MessageSquare,
  Download,
  Key,
  Clock,
  Droplets,
  LayoutGrid,
} from 'lucide-react'
import * as Switch from '@radix-ui/react-switch'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import type { AssetResponse, Folder, ShareLink, ShareLinkAppearance } from '@/types'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ShareCreateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  currentFolderId: string | null
  assets: AssetResponse[]
  folders: Folder[]
  preselectedItem?: { type: 'folder' | 'asset'; id: string; name: string } | null
  onShareCreated: () => void
  onAdvancedSettings?: (token: string) => void
}

type SelectedItem =
  | { type: 'asset'; id: string; name: string; thumbnailUrl: string | null; assetType: string }
  | { type: 'folder'; id: string; name: string }

interface CreatedShareResult {
  token: string
  title: string
  itemType: 'asset' | 'folder'
  thumbnailUrl: string | null
  assetId?: string | null
  folderId?: string | null
  projectId?: string | null
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

// ─── Share Invite Input (autocomplete for user search) ──────────────────────

interface InviteUser { id: string; name: string; email: string }

function ShareInviteInput({ token, shareLink }: { token: string; shareLink: { asset_id: string | null; folder_id: string | null; project_id?: string | null; permission: string } }) {
  const [query, setQuery] = React.useState('')
  const [suggestions, setSuggestions] = React.useState<InviteUser[]>([])
  const [showDrop, setShowDrop] = React.useState(false)
  const [sent, setSent] = React.useState<string | null>(null)
  const [invitedUsers, setInvitedUsers] = React.useState<InviteUser[]>([])
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const ref = React.useRef<HTMLDivElement>(null)

  // Fetch already invited users
  React.useEffect(() => {
    async function loadInvited() {
      try {
        const targetId = shareLink.folder_id || shareLink.asset_id
        if (!targetId) return
        const type = shareLink.folder_id ? 'folders' : 'assets'
        const shares = await api.get<Array<{ shared_with_user_id: string | null; permission: string }>>(`/${type}/${targetId}/direct-shares`)
        if (shares?.length) {
          const userIds = shares.filter(s => s.shared_with_user_id).map(s => s.shared_with_user_id).join(',')
          if (userIds) {
            const users = await api.get<InviteUser[]>(`/users?ids=${userIds}`)
            setInvitedUsers(users)
          }
        }
      } catch {}
    }
    loadInvited()
  }, [shareLink.asset_id, shareLink.folder_id])

  function search(q: string) {
    if (timerRef.current) clearTimeout(timerRef.current)
    if (!q.trim()) { setSuggestions([]); setShowDrop(false); return }
    timerRef.current = setTimeout(async () => {
      try {
        const r = await api.get<InviteUser[]>(`/users/search?q=${encodeURIComponent(q.trim())}`)
        setSuggestions(r)
        setShowDrop(r.length > 0)
      } catch { setSuggestions([]) }
    }, 250)
  }

  async function invite(userId?: string, email?: string) {
    try {
      const body: Record<string, unknown> = { permission: shareLink.permission || 'view', share_token: token }
      if (userId) body.user_id = userId
      if (email) body.email = email
      if (shareLink.folder_id) {
        await api.post(`/folders/${shareLink.folder_id}/share/user`, body)
      } else if (shareLink.asset_id) {
        await api.post(`/assets/${shareLink.asset_id}/share/user`, body)
      } else if (shareLink.project_id) {
        await api.post(`/projects/${shareLink.project_id}/share/user`, body)
      }
      const name = suggestions.find(s => s.id === userId)?.name || email || 'user'
      setSent(name)
      if (userId) {
        const u = suggestions.find(s => s.id === userId)
        if (u) setInvitedUsers(prev => [...prev.filter(p => p.id !== u.id), u])
      }
      setQuery('')
      setSuggestions([])
      setShowDrop(false)
      setTimeout(() => setSent(null), 3000)
    } catch {}
  }

  React.useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setShowDrop(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  return (
    <div className="relative" ref={ref}>
      <input
        type="text"
        value={query}
        onChange={(e) => { setQuery(e.target.value); search(e.target.value) }}
        onFocus={() => suggestions.length > 0 && setShowDrop(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && query.includes('@') && !showDrop) invite(undefined, query.trim())
        }}
        placeholder="Send to name or email"
        className="flex h-9 w-full rounded-md border border-border bg-bg-secondary px-3 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent"
      />
      {showDrop && (
        <div className="absolute z-[100] left-0 right-0 mt-1 rounded-lg border border-border bg-bg-secondary shadow-xl overflow-hidden">
          {suggestions.map((u) => (
            <button
              key={u.id}
              onClick={() => invite(u.id, u.email)}
              className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-bg-hover transition-colors"
            >
              <div className="h-6 w-6 rounded-full bg-accent/20 flex items-center justify-center shrink-0">
                <span className="text-2xs font-medium text-accent">{(u.name || u.email).charAt(0).toUpperCase()}</span>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-text-primary truncate">{u.name}</p>
                <p className="text-2xs text-text-tertiary truncate">{u.email}</p>
              </div>
            </button>
          ))}
        </div>
      )}
      {sent && <p className="text-2xs text-status-success mt-1">Invited {sent}</p>}
      {!sent && !invitedUsers.length && <p className="text-2xs text-text-tertiary mt-1">Type to search or enter email</p>}

      {/* Invited users list */}
      {invitedUsers.length > 0 && (
        <div className="mt-2 space-y-1">
          {invitedUsers.map((u) => (
            <div key={u.id} className="flex items-center gap-2 rounded-md bg-bg-tertiary px-2.5 py-1.5">
              <div className="h-5 w-5 rounded-full bg-accent/20 flex items-center justify-center shrink-0">
                <span className="text-2xs font-medium text-accent">{(u.name || u.email).charAt(0).toUpperCase()}</span>
              </div>
              <span className="text-xs text-text-primary truncate flex-1">{u.name || u.email}</span>
              <span className="text-2xs text-text-tertiary shrink-0">{u.email}</span>
              <button
                onClick={() => setInvitedUsers(prev => prev.filter(p => p.id !== u.id))}
                className="text-text-tertiary hover:text-status-error transition-colors shrink-0"
                title="Remove"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Selection Phase ─────────────────────────────────────────────────────────

interface SelectionPhaseProps {
  assets: AssetResponse[]
  folders: Folder[]
  currentFolderId: string | null
  selectedItems: Map<string, SelectedItem>
  onToggle: (item: SelectedItem) => void
  onCancel: () => void
  onCreate: () => void
  creating: boolean
}

function SelectionPhase({
  assets,
  folders,
  currentFolderId,
  selectedItems,
  onToggle,
  onCancel,
  onCreate,
  creating,
}: SelectionPhaseProps) {
  const hasItems = folders.length > 0 || assets.length > 0
  const totalItems = folders.length + assets.length
  const folderCount = folders.length
  const assetCount = assets.length

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-5 py-4">
        <Dialog.Title className="text-sm font-semibold text-text-primary">
          Create Share Link
        </Dialog.Title>
        <Dialog.Close className="text-text-tertiary hover:text-text-primary transition-colors">
          <X className="h-4 w-4" />
        </Dialog.Close>
      </div>

      {/* Content */}
      <div className="px-5 py-4">
        <div className="rounded-lg border border-border bg-bg-tertiary px-4 py-4">
          <div className="flex items-center gap-3 mb-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent/10 shrink-0">
              <FolderIcon className="h-5 w-5 text-accent" />
            </div>
            <div>
              <p className="text-sm font-semibold text-text-primary">
                {currentFolderId ? 'Share this folder' : 'Share project'}
              </p>
              <p className="text-xs text-text-tertiary">
                One link with all contents included
              </p>
            </div>
          </div>

          {/* Item summary */}
          <div className="flex items-center gap-3 text-xs text-text-secondary">
            {folderCount > 0 && (
              <span className="flex items-center gap-1">
                <FolderIcon className="h-3.5 w-3.5 text-text-tertiary" />
                {folderCount} folder{folderCount !== 1 ? 's' : ''}
              </span>
            )}
            {assetCount > 0 && (
              <span className="flex items-center gap-1">
                <Image className="h-3.5 w-3.5 text-text-tertiary" />
                {assetCount} asset{assetCount !== 1 ? 's' : ''}
              </span>
            )}
            {totalItems === 0 && <span>Empty — no items to share</span>}
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-end border-t border-border px-5 py-3 gap-2">
        <Button variant="secondary" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={onCreate}
          disabled={creating || totalItems === 0}
          loading={creating}
        >
          Create Share Link
        </Button>
      </div>
    </>
  )
}

// ─── Link Created Phase ──────────────────────────────────────────────────────

interface LinkCreatedPhaseProps {
  result: CreatedShareResult
  allResults?: CreatedShareResult[]
  onSelectResult?: (result: CreatedShareResult) => void
  onDone: () => void
  onAdvancedSettings?: (token: string) => void
}

function LinkCreatedPhase({ result, allResults, onSelectResult, onDone, onAdvancedSettings }: LinkCreatedPhaseProps) {
  const [title, setTitle] = React.useState(result.title)
  const [editingTitle, setEditingTitle] = React.useState(false)
  const [savingTitle, setSavingTitle] = React.useState(false)
  const [showSettings, setShowSettings] = React.useState(false)
  const [visibility, setVisibility] = React.useState<'public' | 'secure'>('public')
  const [allowComments, setAllowComments] = React.useState(false)
  const [allowDownloads, setAllowDownloads] = React.useState(false)
  const [passphrase, setPassphrase] = React.useState(false)
  const [passphraseValue, setPassphraseValue] = React.useState('')
  const [showPassphraseInput, setShowPassphraseInput] = React.useState(false)
  const [watermark, setWatermark] = React.useState(false)
  const [expiresAt, setExpiresAt] = React.useState<string>('')

  // Sync title when switching between results
  React.useEffect(() => {
    setTitle(result.title)
    setEditingTitle(false)
    setShowSettings(false)
  }, [result.token, result.title])
  const [layout, setLayout] = React.useState<'grid' | 'list'>('grid')
  const titleInputRef = React.useRef<HTMLInputElement>(null)
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  // Fetch share link details to initialize settings
  React.useEffect(() => {
    api.get<ShareLink>(`/share/${result.token}/details`).then((data) => {
      setAllowComments(data.permission === 'comment' || data.permission === 'approve')
      setAllowDownloads(data.allow_download)
      setPassphrase(data.has_password ?? false)
      setWatermark(data.show_watermark)
      setExpiresAt(data.expires_at ? new Date(data.expires_at).toISOString().split('T')[0] : '')
      setLayout((data.appearance as ShareLinkAppearance | null)?.layout || 'grid')
      setVisibility(data.visibility === 'secure' ? 'secure' : 'public')
    }).catch(() => {})
  }, [result.token])

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

  async function patchLink(updates: Record<string, unknown>) {
    try {
      await api.patch(`/share/${result.token}`, updates)
    } catch {
      // silent fail
    }
  }

  function debouncedPatch(updates: Record<string, unknown>) {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => patchLink(updates), 400)
  }

  React.useEffect(() => {
    if (editingTitle && titleInputRef.current) {
      titleInputRef.current.focus()
      titleInputRef.current.select()
    }
  }, [editingTitle])

  // Compute settings summary
  const settingsSummary = [
    'view',
    allowDownloads ? 'download' : null,
    allowComments ? 'comment' : null,
  ].filter(Boolean)

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
      <div className="px-5 py-4 space-y-4 max-h-[60vh] overflow-y-auto">
        {/* Multiple share links switcher */}
        {allResults && allResults.length > 1 && (
          <div className="space-y-1">
            <p className="text-2xs font-medium text-text-tertiary uppercase tracking-wider">
              {allResults.length} share links created
            </p>
            <div className="flex flex-wrap gap-1.5">
              {allResults.map((r) => (
                <button
                  key={r.token}
                  onClick={() => onSelectResult?.(r)}
                  className={cn(
                    'flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs transition-colors border',
                    r.token === result.token
                      ? 'bg-accent/10 border-accent/30 text-accent font-medium'
                      : 'bg-bg-tertiary border-border text-text-secondary hover:bg-bg-hover',
                  )}
                >
                  {r.itemType === 'folder' ? <FolderIcon className="h-3 w-3" /> : <Image className="h-3 w-3" />}
                  <span className="truncate max-w-[120px]">{r.title}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Share URL + Visibility */}
        <div className="flex items-center gap-2 rounded-md border border-border bg-bg-tertiary px-3 py-2">
          <span className="flex-1 truncate font-mono text-xs text-text-primary">{shareUrl}</span>
          <button
            onClick={async () => {
              try { await navigator.clipboard.writeText(shareUrl) } catch {}
            }}
            className="text-text-tertiary hover:text-text-primary transition-colors shrink-0"
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
          <select
            value={visibility}
            onChange={(e) => {
              const v = e.target.value as 'public' | 'secure'
              setVisibility(v)
              patchLink({ visibility: v })
            }}
            className="shrink-0 rounded-full border border-border bg-bg-secondary px-2 py-0.5 text-2xs font-medium text-text-primary outline-none cursor-pointer"
          >
            <option value="public">🌐 Public</option>
            <option value="secure">🔒 Secure</option>
          </select>
        </div>

        {/* Send to name or email — with autocomplete */}
        <ShareInviteInput token={result.token} shareLink={{ asset_id: result.assetId ?? null, folder_id: result.folderId ?? null, project_id: result.projectId ?? null, permission: 'view' }} />

        {/* Preview thumbnail or Settings */}
        {!showSettings ? (
          <>
            {/* Preview */}
            {result.thumbnailUrl ? (
              <div className="rounded-lg border border-border bg-bg-tertiary overflow-hidden">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={result.thumbnailUrl} alt={title} className="w-full h-32 object-cover" />
              </div>
            ) : (
              <div className="rounded-lg border border-border bg-bg-tertiary h-32 flex items-center justify-center">
                {result.itemType === 'folder' ? (
                  <FolderIcon className="h-10 w-10 text-text-tertiary/40" />
                ) : (
                  <Image className="h-10 w-10 text-text-tertiary/40" />
                )}
              </div>
            )}

            {/* Settings disclosure */}
            <button
              onClick={() => setShowSettings(true)}
              className="w-full flex items-center justify-between rounded-lg border border-border bg-bg-tertiary px-4 py-3 hover:bg-bg-hover transition-colors"
            >
              <div className="text-left">
                <p className="text-sm font-medium text-text-primary">Settings</p>
                <p className="text-xs text-text-tertiary">
                  Anyone with the link can {settingsSummary.join(', ')}.
                </p>
              </div>
              <ChevronRight className="h-4 w-4 text-text-tertiary" />
            </button>
          </>
        ) : (
          <>
            {/* Inline settings panel */}
            <button
              onClick={() => setShowSettings(false)}
              className="flex items-center gap-1 text-sm font-medium text-text-primary hover:text-accent transition-colors"
            >
              <ChevronLeft className="h-4 w-4" />
              Back
            </button>

            <div className="space-y-1">
              {/* Layout */}
              <div className="flex items-center justify-between py-2.5">
                <div className="flex items-center gap-2.5">
                  <LayoutGrid className="h-4 w-4 text-text-tertiary" />
                  <span className="text-sm text-text-primary">Layout</span>
                </div>
                <div className="flex items-center gap-1 rounded-lg border border-border bg-bg-tertiary p-0.5">
                  {(['grid', 'list'] as const).map((l) => (
                    <button
                      key={l}
                      onClick={() => { setLayout(l); patchLink({ appearance: { layout: l, theme: 'dark', accent_color: null, open_in_viewer: true, sort_by: 'created_at' } }) }}
                      className={cn('rounded-md px-3 py-1 text-2xs font-medium capitalize', layout === l ? 'bg-accent text-white' : 'text-text-tertiary hover:text-text-primary')}
                    >{l}</button>
                  ))}
                </div>
              </div>

              {/* Allow comments */}
              <div className="flex items-center justify-between py-2.5">
                <div className="flex items-center gap-2.5">
                  <MessageSquare className="h-4 w-4 text-text-tertiary" />
                  <span className="text-sm text-text-primary">Allow comments</span>
                </div>
                <Switch.Root
                  checked={allowComments}
                  onCheckedChange={(v) => { setAllowComments(v); patchLink({ permission: v ? 'comment' : 'view' }) }}
                  className="w-9 h-5 rounded-full relative bg-bg-tertiary border border-border data-[state=checked]:bg-accent transition-colors"
                >
                  <Switch.Thumb className="block w-4 h-4 rounded-full bg-white shadow transition-transform translate-x-0.5 data-[state=checked]:translate-x-[18px]" />
                </Switch.Root>
              </div>

              {/* Allow downloads */}
              <div className="flex items-center justify-between py-2.5">
                <div className="flex items-center gap-2.5">
                  <Download className="h-4 w-4 text-text-tertiary" />
                  <span className="text-sm text-text-primary">Allow downloads</span>
                </div>
                <Switch.Root
                  checked={allowDownloads}
                  onCheckedChange={(v) => { setAllowDownloads(v); patchLink({ allow_download: v }) }}
                  className="w-9 h-5 rounded-full relative bg-bg-tertiary border border-border data-[state=checked]:bg-accent transition-colors"
                >
                  <Switch.Thumb className="block w-4 h-4 rounded-full bg-white shadow transition-transform translate-x-0.5 data-[state=checked]:translate-x-[18px]" />
                </Switch.Root>
              </div>

              {/* Passphrase */}
              <div className="space-y-2">
                <div className="flex items-center justify-between py-2.5">
                  <div className="flex items-center gap-2.5">
                    <Key className="h-4 w-4 text-text-tertiary" />
                    <span className="text-sm text-text-primary">Passphrase</span>
                  </div>
                  <Switch.Root
                    checked={passphrase}
                    onCheckedChange={(v) => {
                      setPassphrase(v)
                      setShowPassphraseInput(v)
                      if (!v) { setPassphraseValue(''); patchLink({ password: null }) }
                    }}
                    className="w-9 h-5 rounded-full relative bg-bg-tertiary border border-border data-[state=checked]:bg-accent transition-colors"
                  >
                    <Switch.Thumb className="block w-4 h-4 rounded-full bg-white shadow transition-transform translate-x-0.5 data-[state=checked]:translate-x-[18px]" />
                  </Switch.Root>
                </div>
                {passphrase && (
                  <div className="relative">
                    <input
                      type={showPassphraseInput ? 'text' : 'password'}
                      value={passphraseValue}
                      onChange={(e) => { setPassphraseValue(e.target.value); debouncedPatch({ password: e.target.value || null }) }}
                      placeholder={passphrase && !passphraseValue ? '••••••••' : 'Enter passphrase'}
                      className="w-full rounded-md border border-border bg-bg-secondary px-3 py-2 pr-14 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassphraseInput(!showPassphraseInput)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-2xs text-text-tertiary hover:text-text-primary transition-colors px-1 py-0.5"
                    >
                      {showPassphraseInput ? 'Hide' : 'Show'}
                    </button>
                  </div>
                )}
              </div>

              {/* Expiration date */}
              <div className="flex items-center justify-between py-2.5">
                <div className="flex items-center gap-2.5">
                  <Clock className="h-4 w-4 text-text-tertiary" />
                  <span className="text-sm text-text-primary">Expiration date</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <input
                    type="date"
                    value={expiresAt}
                    onChange={(e) => { setExpiresAt(e.target.value); patchLink({ expires_at: e.target.value ? new Date(e.target.value).toISOString() : null }) }}
                    className="w-[120px] rounded border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary outline-none focus:border-accent [color-scheme:dark]"
                  />
                  {expiresAt && (
                    <button onClick={() => { setExpiresAt(''); patchLink({ expires_at: null }) }} className="text-text-tertiary hover:text-text-primary">
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
              </div>

              {/* Watermark */}
              <div className="flex items-center justify-between py-2.5">
                <div className="flex items-center gap-2.5">
                  <Droplets className="h-4 w-4 text-text-tertiary" />
                  <span className="text-sm text-text-primary">Watermark</span>
                </div>
                <Switch.Root
                  checked={watermark}
                  onCheckedChange={(v) => { setWatermark(v); patchLink({ show_watermark: v }) }}
                  className="w-9 h-5 rounded-full relative bg-bg-tertiary border border-border data-[state=checked]:bg-accent transition-colors"
                >
                  <Switch.Thumb className="block w-4 h-4 rounded-full bg-white shadow transition-transform translate-x-0.5 data-[state=checked]:translate-x-[18px]" />
                </Switch.Root>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-border px-5 py-3">
        <button
          onClick={() => {
            onAdvancedSettings?.(result.token)
            onDone()
          }}
          className="text-xs text-text-tertiary hover:text-text-secondary transition-colors flex items-center gap-1"
        >
          Advanced settings
          <ExternalLink className="h-3 w-3" />
        </button>
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
  preselectedItem,
  onShareCreated,
  onAdvancedSettings,
}: ShareCreateDialogProps) {
  const [selectedItems, setSelectedItems] = React.useState<Map<string, SelectedItem>>(new Map())
  const [creating, setCreating] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [createdResult, setCreatedResult] = React.useState<CreatedShareResult | null>(null)
  const [allCreatedResults, setAllCreatedResults] = React.useState<CreatedShareResult[]>([])

  // Reset state when dialog opens/closes
  React.useEffect(() => {
    if (open) {
      const initial = new Map<string, SelectedItem>()
      if (preselectedItem) {
        const key = `${preselectedItem.type}:${preselectedItem.id}`
        if (preselectedItem.type === 'folder') {
          initial.set(key, { type: 'folder', id: preselectedItem.id, name: preselectedItem.name })
        } else {
          const asset = assets.find(a => a.id === preselectedItem.id)
          initial.set(key, {
            type: 'asset',
            id: preselectedItem.id,
            name: preselectedItem.name,
            thumbnailUrl: asset?.thumbnail_url ?? null,
            assetType: asset?.asset_type ?? 'image',
          })
        }
      }
      setSelectedItems(initial)
      setCreating(false)
      setError(null)
      setCreatedResult(null)
      setAllCreatedResults([])
    }
  }, [open, preselectedItem, assets])

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
    setCreating(true)
    setError(null)

    try {
      let shareLink: ShareLink
      let itemType: 'asset' | 'folder' = 'folder'
      let thumbUrl: string | null = null

      // Check if a specific item is selected (single asset or single folder)
      const items = Array.from(selectedItems.values())
      const singleItem = items.length === 1 ? items[0] : null

      if (singleItem?.type === 'asset') {
        // Share a single asset
        shareLink = await api.post<ShareLink>(`/assets/${singleItem.id}/share`, {
          title: singleItem.name,
        })
        itemType = 'asset'
        thumbUrl = singleItem.thumbnailUrl
      } else if (singleItem?.type === 'folder') {
        // Share a specific folder
        shareLink = await api.post<ShareLink>(`/folders/${singleItem.id}/share`, {
          title: singleItem.name,
        })
      } else if (currentFolderId) {
        // Share the current folder (contains everything visible)
        const folderName = folders.find(f => f.id === currentFolderId)?.name || 'Shared Folder'
        shareLink = await api.post<ShareLink>(`/folders/${currentFolderId}/share`, {
          title: folderName,
        })
      } else {
        // Share project root (all root folders + assets in one link)
        shareLink = await api.post<ShareLink>(`/projects/${projectId}/share`, {
          title: 'Shared Project',
        })
      }

      setCreatedResult({
        token: shareLink.token,
        title: shareLink.title || 'Share Link',
        itemType,
        thumbnailUrl: thumbUrl,
        assetId: shareLink.asset_id ?? null,
        folderId: shareLink.folder_id ?? null,
        projectId: shareLink.project_id ?? null,
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
            <LinkCreatedPhase
              result={createdResult}
              allResults={allCreatedResults}
              onSelectResult={(r) => setCreatedResult(r)}
              onDone={handleDone}
              onAdvancedSettings={onAdvancedSettings}
            />
          ) : (
            <SelectionPhase
              assets={assets}
              folders={folders}
              currentFolderId={currentFolderId}
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
