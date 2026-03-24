'use client'

import * as React from 'react'
import * as Switch from '@radix-ui/react-switch'
import useSWR from 'swr'
import {
  ArrowLeft,
  Copy,
  Check,
  ExternalLink,
  Lock,
  Calendar,
  Paintbrush,
  LayoutGrid,
  LayoutList,
  Eye,
  EyeOff,
  ChevronDown,
  ChevronRight,
  MessageSquare,
  Download,
  Layers,
  Droplets,
  Globe,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { ShareLinkActivityPanel } from '@/components/projects/share-link-activity'
import type { ShareLink, ShareLinkAppearance } from '@/types'

// ─── Shared hook for share link data + mutations ────────────────────────────

function useShareLinkData(token: string) {
  const { data: shareLink, mutate } = useSWR<ShareLink>(
    `/share/${token}/details`,
    (key: string) => api.get<ShareLink>(key),
  )

  const updateTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const debouncedUpdate = React.useCallback(
    (updates: Record<string, unknown>) => {
      if (updateTimerRef.current) clearTimeout(updateTimerRef.current)
      updateTimerRef.current = setTimeout(async () => {
        try {
          await api.patch(`/share/${token}`, updates)
          mutate()
        } catch {
          // Silent fail — could add toast
        }
      }, 300)
    },
    [token, mutate],
  )

  const immediateUpdate = React.useCallback(
    async (updates: Record<string, unknown>) => {
      try {
        await api.patch(`/share/${token}`, updates)
        mutate()
      } catch {
        // Silent fail
      }
    },
    [token, mutate],
  )

  const appearance: ShareLinkAppearance = shareLink?.appearance || {
    layout: 'grid',
    theme: 'dark',
    accent_color: null,
    open_in_viewer: false,
    sort_by: 'name',
  }

  const updateAppearance = React.useCallback(
    (patch: Partial<ShareLinkAppearance>) => {
      const updated = { ...appearance, ...patch }
      immediateUpdate({ appearance: updated })
    },
    [appearance, immediateUpdate],
  )

  return { shareLink, mutate, debouncedUpdate, immediateUpdate, appearance, updateAppearance }
}

// ─── Collapsible Section ─────────────────────────────────────────────────────

function Section({
  title,
  icon,
  defaultOpen = true,
  children,
}: {
  title: string
  icon: React.ReactNode
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = React.useState(defaultOpen)

  return (
    <div className="border-b border-white/[0.06]">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-4 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400 hover:text-zinc-300 transition-colors"
      >
        {icon}
        <span className="flex-1 text-left">{title}</span>
        {open ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
      </button>
      {open && <div className="px-4 pb-4 space-y-3">{children}</div>}
    </div>
  )
}

// ─── Toggle Row ──────────────────────────────────────────────────────────────

function ToggleRow({
  label,
  description,
  checked,
  onCheckedChange,
}: {
  label: string
  description?: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm text-zinc-200">{label}</p>
        {description && (
          <p className="text-xs text-zinc-500 mt-0.5">{description}</p>
        )}
      </div>
      <Switch.Root
        checked={checked}
        onCheckedChange={onCheckedChange}
        className={cn(
          'relative h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors',
          checked ? 'bg-accent' : 'bg-white/15',
        )}
      >
        <Switch.Thumb
          className={cn(
            'block h-4 w-4 rounded-full bg-white transition-transform',
            checked ? 'translate-x-[18px]' : 'translate-x-[2px]',
          )}
        />
      </Switch.Root>
    </div>
  )
}

// ─── Share User Search (autocomplete) ───────────────────────────────────────

interface UserSuggestion {
  id: string
  name: string
  email: string
  avatar_url?: string | null
}

interface InvitedUser {
  id: string
  name: string
  email: string
  permission: string
}

function ShareUserSearch({ shareLink }: { shareLink: ShareLink }) {
  const [query, setQuery] = React.useState('')
  const [suggestions, setSuggestions] = React.useState<UserSuggestion[]>([])
  const [showSuggestions, setShowSuggestions] = React.useState(false)
  const [sending, setSending] = React.useState(false)
  const [sent, setSent] = React.useState<string | null>(null)
  const [invitedUsers, setInvitedUsers] = React.useState<InvitedUser[]>([])
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const containerRef = React.useRef<HTMLDivElement>(null)

  // Fetch already-invited users from direct shares
  React.useEffect(() => {
    async function fetchInvited() {
      try {
        const targetId = shareLink.folder_id || shareLink.asset_id
        if (!targetId) return
        const type = shareLink.folder_id ? 'folders' : 'assets'
        const shares = await api.get<Array<{ id: string; shared_with_user_id: string | null; permission: string }>>(`/${type}/${targetId}/direct-shares`)
        if (shares && shares.length > 0) {
          const userIds = shares.filter(s => s.shared_with_user_id).map(s => s.shared_with_user_id).join(',')
          if (userIds) {
            const users = await api.get<Array<{ id: string; name: string; email: string }>>(`/users?ids=${userIds}`)
            setInvitedUsers(users.map(u => ({
              id: u.id,
              name: u.name,
              email: u.email,
              permission: shares.find(s => s.shared_with_user_id === u.id)?.permission || 'view',
            })))
          }
        }
      } catch {
        // Endpoint may not exist yet — silently fail
      }
    }
    fetchInvited()
  }, [shareLink.asset_id, shareLink.folder_id])

  function searchUsers(q: string) {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (!q.trim()) {
      setSuggestions([])
      setShowSuggestions(false)
      return
    }
    debounceRef.current = setTimeout(async () => {
      try {
        const results = await api.get<UserSuggestion[]>(`/users/search?q=${encodeURIComponent(q.trim())}`)
        setSuggestions(results)
        setShowSuggestions(results.length > 0)
      } catch {
        setSuggestions([])
      }
    }, 250)
  }

  async function inviteUser(user: UserSuggestion) {
    setSending(true)
    try {
      const body = { permission: shareLink.permission || 'view', user_id: user.id, share_token: shareLink.token }
      if (shareLink.folder_id) {
        await api.post(`/folders/${shareLink.folder_id}/share/user`, body)
      } else if (shareLink.asset_id) {
        await api.post(`/assets/${shareLink.asset_id}/share/user`, body)
      } else if ((shareLink as any).project_id) {
        await api.post(`/projects/${(shareLink as any).project_id}/share/user`, body)
      }
      setSent(user.name || user.email)
      setQuery('')
      setSuggestions([])
      setShowSuggestions(false)
      setInvitedUsers(prev => [...prev.filter(u => u.id !== user.id), { id: user.id, name: user.name, email: user.email, permission: shareLink.permission || 'view' }])
      setTimeout(() => setSent(null), 3000)
    } catch {
      // Could show error
    } finally {
      setSending(false)
    }
  }

  async function inviteByEmail(email: string) {
    setSending(true)
    try {
      const body = { permission: shareLink.permission || 'view', email, share_token: shareLink.token }
      if (shareLink.folder_id) {
        await api.post(`/folders/${shareLink.folder_id}/share/user`, body)
      } else if (shareLink.asset_id) {
        await api.post(`/assets/${shareLink.asset_id}/share/user`, body)
      } else if ((shareLink as any).project_id) {
        await api.post(`/projects/${(shareLink as any).project_id}/share/user`, body)
      }
      setSent(email)
      setQuery('')
      setSuggestions([])
      setShowSuggestions(false)
      setTimeout(() => setSent(null), 3000)
    } catch {
      // Could show error
    } finally {
      setSending(false)
    }
  }

  // Close suggestions on outside click
  React.useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowSuggestions(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  return (
    <div className="mt-2 relative" ref={containerRef}>
      <input
        type="text"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          searchUsers(e.target.value)
        }}
        onFocus={() => {
          if (suggestions.length > 0) setShowSuggestions(true)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && query.includes('@') && !showSuggestions) {
            inviteByEmail(query.trim())
          }
        }}
        placeholder="Send to name or email"
        disabled={sending}
        className="w-full rounded-md border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-accent/50"
      />

      {/* Suggestions dropdown — rendered inline to avoid overflow clipping */}
      {showSuggestions && suggestions.length > 0 && (
        <div className="mt-1 rounded-lg border border-white/[0.08] bg-zinc-900 shadow-xl">
          {suggestions.map((user) => (
            <button
              key={user.id}
              onClick={() => inviteUser(user)}
              className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-white/[0.06] transition-colors first:rounded-t-lg last:rounded-b-lg"
            >
              <div className="h-7 w-7 rounded-full bg-accent/20 flex items-center justify-center shrink-0">
                <span className="text-xs font-medium text-accent">
                  {(user.name || user.email).charAt(0).toUpperCase()}
                </span>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-zinc-200 truncate">{user.name}</p>
                <p className="text-2xs text-zinc-500 truncate">{user.email}</p>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Success message */}
      {sent && (
        <p className="text-2xs text-green-400 mt-1">Invited {sent}</p>
      )}
      {!sent && !invitedUsers.length && (
        <p className="text-2xs text-zinc-600 mt-1">Type to search users or enter email</p>
      )}

      {/* Invited users list */}
      {invitedUsers.length > 0 && (
        <div className="mt-2 space-y-1">
          {invitedUsers.map((user) => (
            <div
              key={user.id}
              className="flex items-center gap-2 rounded-md bg-white/[0.04] px-2.5 py-1.5"
            >
              <div className="h-6 w-6 rounded-full bg-accent/20 flex items-center justify-center shrink-0">
                <span className="text-2xs font-medium text-accent">
                  {(user.name || user.email).charAt(0).toUpperCase()}
                </span>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs text-zinc-200 truncate">{user.name}</p>
              </div>
              <span className="text-2xs text-zinc-500 capitalize shrink-0">{user.permission}</span>
              <button
                onClick={async () => {
                  try {
                    const targetId = shareLink.folder_id || shareLink.asset_id
                    const type = shareLink.folder_id ? 'folders' : 'assets'
                    // Find the share ID for this user
                    const shares = await api.get<Array<{ id: string; shared_with_user_id: string }>>(`/${type}/${targetId}/direct-shares`)
                    const share = shares.find(s => s.shared_with_user_id === user.id)
                    if (share && shareLink.folder_id) {
                      await api.delete(`/folders/${shareLink.folder_id}/shares/${share.id}`)
                    }
                    // For assets, we'd need a similar delete endpoint — for now just remove from UI
                    setInvitedUsers(prev => prev.filter(u => u.id !== user.id))
                  } catch {
                    setInvitedUsers(prev => prev.filter(u => u.id !== user.id))
                  }
                }}
                className="text-zinc-600 hover:text-red-400 transition-colors shrink-0"
                title="Remove access"
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

// ─── Copy Button (small, inline) ────────────────────────────────────────────

function CopyButton({ text, className }: { text: string; className?: string }) {
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
    <button
      onClick={handleCopy}
      className={cn(
        'inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200 transition-colors',
        className,
      )}
      title="Copy to clipboard"
    >
      {copied ? (
        <>
          <Check className="h-3.5 w-3.5 text-green-400" />
          <span>Copied!</span>
        </>
      ) : (
        <>
          <Copy className="h-3.5 w-3.5" />
          <span>Copy</span>
        </>
      )}
    </button>
  )
}

// ─── Copy Link Button (larger, for main content area) ────────────────────────

function CopyLinkButton({ text }: { text: string }) {
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
    <button
      onClick={handleCopy}
      className={cn(
        'inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors',
        copied
          ? 'border-green-500/30 text-green-400'
          : 'border-white/[0.08] text-zinc-300 hover:bg-white/[0.04] hover:text-zinc-100',
      )}
    >
      {copied ? (
        <>
          <Check className="h-4 w-4" />
          Copied!
        </>
      ) : (
        <>
          <Copy className="h-4 w-4" />
          Copy Link
        </>
      )}
    </button>
  )
}

// ─── Props ───────────────────────────────────────────────────────────────────

interface ShareLinkContentProps {
  token: string
  projectId: string
  onBack: () => void
  frontendUrl: string
}

interface ShareLinkSettingsPanelProps {
  token: string
}

// ─── ShareLinkContent (LEFT/MAIN panel) ─────────────────────────────────────

export function ShareLinkContent({ token, projectId, onBack, frontendUrl }: ShareLinkContentProps) {
  const { shareLink, immediateUpdate } = useShareLinkData(token)

  const [localTitle, setLocalTitle] = React.useState('')
  const [localDescription, setLocalDescription] = React.useState('')
  const [previewThumbnails, setPreviewThumbnails] = React.useState<{ id: string; name: string; thumbnail_url: string | null; asset_type: string }[]>([])
  const [previewFolders, setPreviewFolders] = React.useState<{ id: string; name: string; item_count: number }[]>([])

  React.useEffect(() => {
    if (shareLink) {
      setLocalTitle(shareLink.title || '')
      setLocalDescription(shareLink.description || '')
    }
  }, [shareLink])

  // Fetch preview data for shares
  React.useEffect(() => {
    if (!shareLink) return
    const folderId = shareLink.folder_id
    const isProjectShare = !folderId && !shareLink.asset_id

    if (shareLink.asset_id) {
      // Asset share: fetch the single asset
      api.get<{ id: string; name: string; asset_type: string; thumbnail_url: string | null }>(
        `/assets/${shareLink.asset_id}`,
      )
        .then((asset) => setPreviewThumbnails([asset]))
        .catch(() => setPreviewThumbnails([]))
      setPreviewFolders([])
    } else {
      // Folder or project root share: fetch assets + folders
      const folderParam = folderId ? `folder_id=${folderId}` : 'folder_id=root'
      api.get<{ id: string; name: string; asset_type: string; thumbnail_url: string | null }[]>(
        `/projects/${projectId}/assets?${folderParam}`,
      )
        .then((assets) => setPreviewThumbnails(assets.slice(0, 4)))
        .catch(() => setPreviewThumbnails([]))

      // Fetch subfolders
      const parentParam = folderId || 'root'
      api.get<{ id: string; name: string; item_count: number }[]>(
        `/projects/${projectId}/folders?parent_id=${parentParam}`,
      )
        .then((folders) => setPreviewFolders(folders))
        .catch(() => setPreviewFolders([]))
    }
  }, [shareLink, projectId])

  const shareUrl = `${frontendUrl}/share/${token}`

  if (!shareLink) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex items-center gap-2 text-zinc-500">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-500 border-t-transparent" />
          <span className="text-sm">Loading...</span>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-y-auto">
      <div className="p-6 space-y-6">
        {/* Back button */}
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          All Share Links
        </button>

        {/* Editable title */}
        <input
          type="text"
          value={localTitle}
          onChange={(e) => setLocalTitle(e.target.value)}
          onBlur={() => {
            if (localTitle !== shareLink.title) {
              immediateUpdate({ title: localTitle })
            }
          }}
          placeholder="Untitled Share Link"
          className="w-full bg-transparent text-2xl font-semibold text-zinc-100 placeholder:text-zinc-600 outline-none border-none focus:ring-0"
        />

        {/* Editable description */}
        <textarea
          value={localDescription}
          onChange={(e) => setLocalDescription(e.target.value)}
          onBlur={() => {
            if (localDescription !== (shareLink.description || '')) {
              immediateUpdate({ description: localDescription || null })
            }
          }}
          placeholder="Add a description..."
          rows={2}
          className="w-full bg-transparent text-sm text-zinc-400 placeholder:text-zinc-600 outline-none border-none resize-none focus:ring-0"
        />

        {/* Content preview — matches project view style */}
        {(previewFolders.length > 0 || previewThumbnails.length > 0) ? (
          <div className="space-y-4">
            {/* Folders */}
            {previewFolders.length > 0 && (
              <>
                <span className="text-xs text-text-tertiary font-medium uppercase tracking-wider">
                  {previewFolders.length} {previewFolders.length === 1 ? 'Folder' : 'Folders'}
                </span>
                <div className="grid grid-cols-3 gap-3">
                  {previewFolders.map((folder) => (
                    <div key={folder.id} className="rounded-lg border border-border bg-bg-tertiary/50 overflow-hidden">
                      <div className="aspect-[4/3] flex items-center justify-center bg-white/[0.02]">
                        <svg className="h-10 w-10 text-text-tertiary/50" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg>
                      </div>
                      <div className="px-3 py-2">
                        <p className="text-sm font-medium text-text-primary truncate">{folder.name}</p>
                        <p className="text-xs text-text-tertiary mt-0.5">{folder.item_count} {folder.item_count === 1 ? 'Item' : 'Items'}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
            {/* Assets */}
            {previewThumbnails.length > 0 && (
              <>
                <span className="text-xs text-text-tertiary font-medium uppercase tracking-wider">
                  {previewThumbnails.length} {previewThumbnails.length === 1 ? 'Asset' : 'Assets'}
                </span>
                <div className="grid grid-cols-3 gap-3">
                  {previewThumbnails.slice(0, 6).map((asset) => (
                    <div key={asset.id} className="rounded-lg border border-border bg-bg-tertiary/50 overflow-hidden">
                      <div className="aspect-[16/10] bg-bg-tertiary flex items-center justify-center overflow-hidden">
                        {asset.thumbnail_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={asset.thumbnail_url} alt={asset.name} className="h-full w-full object-cover" />
                        ) : (
                          <Eye className="h-8 w-8 text-text-tertiary/40" />
                        )}
                      </div>
                      <div className="px-3 py-2">
                        <p className="text-sm font-medium text-text-primary truncate">{asset.name}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="rounded-xl border border-border bg-bg-tertiary/50 p-8 flex flex-col items-center justify-center text-center space-y-3">
            <div className="h-12 w-12 rounded-full bg-white/[0.05] flex items-center justify-center">
              <Eye className="h-6 w-6 text-zinc-500" />
            </div>
            <p className="text-sm font-medium text-zinc-300">No content yet</p>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => window.open(shareUrl, '_blank')}
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 transition-colors"
          >
            <ExternalLink className="h-4 w-4" />
            Open Share Link
          </button>
          <CopyLinkButton text={shareUrl} />
        </div>
      </div>
    </div>
  )
}

// ─── ShareLinkSettingsPanel (RIGHT panel) ───────────────────────────────────

export function ShareLinkSettingsPanel({ token }: ShareLinkSettingsPanelProps) {
  const { shareLink, debouncedUpdate, immediateUpdate, appearance, updateAppearance } = useShareLinkData(token)

  const [rightTab, setRightTab] = React.useState<'settings' | 'activity'>('settings')
  const [localPassword, setLocalPassword] = React.useState('')
  const [passwordEnabled, setPasswordEnabled] = React.useState(false)
  const [showPassword, setShowPassword] = React.useState(false)
  const [localAccentColor, setLocalAccentColor] = React.useState('')

  React.useEffect(() => {
    if (shareLink) {
      setPasswordEnabled(shareLink.has_password ?? false)
      setLocalPassword(shareLink.password_value || '')
      setLocalAccentColor(shareLink.appearance?.accent_color || '')
    }
  }, [shareLink])

  const shareUrl = typeof window !== 'undefined' ? `${window.location.origin}/share/${token}` : `/share/${token}`

  if (!shareLink) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex items-center gap-2 text-zinc-500">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-500 border-t-transparent" />
          <span className="text-sm">Loading...</span>
        </div>
      </div>
    )
  }

  return (
    <>
      {/* Tabs */}
      <div className="flex items-center border-b border-border">
        {(['settings', 'activity'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setRightTab(tab)}
            className={cn(
              'flex-1 flex items-center justify-center gap-1.5 py-2.5 text-sm font-medium capitalize transition-colors border-b-2',
              rightTab === tab
                ? 'border-accent text-text-primary'
                : 'border-transparent text-text-tertiary hover:text-text-secondary',
            )}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto">
        {rightTab === 'settings' ? (
          <div>
            {/* Link Visibility */}
            <Section title="Link Visibility" icon={<Globe className="h-3.5 w-3.5" />}>
              <ToggleRow
                label="Enabled"
                description={shareLink.visibility === 'secure' ? 'Only invited users can access' : 'Anyone with the link can access'}
                checked={shareLink.is_enabled}
                onCheckedChange={(checked) => immediateUpdate({ is_enabled: checked })}
              />
              {/* URL + Visibility dropdown */}
              <div className="flex items-center gap-2 rounded-md bg-white/[0.04] px-3 py-2 mt-2">
                <span className="flex-1 truncate font-mono text-xs text-zinc-400">
                  {shareUrl}
                </span>
                <CopyButton text={shareUrl} />
                <select
                  value={shareLink.visibility || 'public'}
                  onChange={(e) => immediateUpdate({ visibility: e.target.value })}
                  className="rounded-full border border-white/[0.08] bg-white/[0.04] px-2.5 py-1 text-2xs font-medium text-zinc-300 outline-none cursor-pointer [color-scheme:dark]"
                >
                  <option value="public">🌐 Public</option>
                  <option value="secure">🔒 Secure</option>
                </select>
              </div>
              {shareLink.visibility === 'secure' && (
                <p className="text-2xs text-zinc-500 mt-1">
                  Only project members and people you invite can view this link.
                </p>
              )}
              {/* Send to name or email */}
              <ShareUserSearch
                shareLink={shareLink}
              />
            </Section>

            {/* Permissions */}
            <Section title="Permissions" icon={<MessageSquare className="h-3.5 w-3.5" />}>
              <ToggleRow
                label="Comments"
                description="Allow viewers to leave comments"
                checked={shareLink.permission === 'comment' || shareLink.permission === 'approve'}
                onCheckedChange={(checked) =>
                  immediateUpdate({ permission: checked ? 'comment' : 'view' })
                }
              />
              <ToggleRow
                label="Downloads"
                description="Allow viewers to download files"
                checked={shareLink.allow_download}
                onCheckedChange={(checked) => immediateUpdate({ allow_download: checked })}
              />
              <ToggleRow
                label="Show all versions"
                description="Display version history"
                checked={shareLink.show_versions}
                onCheckedChange={(checked) => immediateUpdate({ show_versions: checked })}
              />
            </Section>

            {/* Security */}
            <Section title="Security" icon={<Lock className="h-3.5 w-3.5" />}>
              <ToggleRow
                label="Passphrase"
                description={passwordEnabled ? 'Password required to access' : 'Require a password to access'}
                checked={passwordEnabled}
                onCheckedChange={(checked) => {
                  setPasswordEnabled(checked)
                  if (!checked) {
                    setLocalPassword('')
                    setShowPassword(false)
                    immediateUpdate({ password: null })
                  }
                }}
              />
              {passwordEnabled && (
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={localPassword}
                    onChange={(e) => {
                      setLocalPassword(e.target.value)
                      debouncedUpdate({ password: e.target.value.trim() || null })
                    }}
                    placeholder="Enter passphrase"
                    className="w-full rounded-md border border-white/[0.08] bg-white/[0.04] px-3 py-2 pr-12 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-accent/50"
                  />
                  <button
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 transition-colors"
                    title={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
              )}

              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm text-zinc-200">Expiration</p>
                  <p className="text-xs text-zinc-500 mt-0.5">
                    {shareLink.expires_at
                      ? `Expires ${new Date(shareLink.expires_at).toLocaleDateString()}`
                      : 'Not set'}
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  <Calendar className="h-3.5 w-3.5 text-zinc-500" />
                  <input
                    type="date"
                    value={
                      shareLink.expires_at
                        ? new Date(shareLink.expires_at).toISOString().split('T')[0]
                        : ''
                    }
                    onChange={(e) => {
                      const val = e.target.value
                      immediateUpdate({
                        expires_at: val ? new Date(val).toISOString() : null,
                      })
                    }}
                    className="w-[130px] rounded border border-white/[0.08] bg-white/[0.04] px-2 py-1 text-xs text-zinc-300 outline-none focus:border-accent/50 [color-scheme:dark]"
                  />
                </div>
              </div>

              <ToggleRow
                label="Watermark"
                description="Overlay watermark on content"
                checked={shareLink.show_watermark}
                onCheckedChange={(checked) => immediateUpdate({ show_watermark: checked })}
              />
            </Section>

            {/* Appearance */}
            <Section title="Appearance" icon={<Paintbrush className="h-3.5 w-3.5" />} defaultOpen={false}>
              {/* Layout — Grid / List */}
              <div className="space-y-1.5">
                <p className="text-xs text-zinc-400">Layout</p>
                <div className="flex gap-2">
                  {(['grid', 'list'] as const).map((layout) => (
                    <button
                      key={layout}
                      onClick={() => updateAppearance({ layout })}
                      className={cn(
                        'flex-1 flex flex-col items-center gap-1.5 rounded-lg border py-3 text-xs font-medium capitalize transition-colors',
                        appearance.layout === layout
                          ? 'bg-accent/10 border-accent text-accent'
                          : 'border-white/[0.08] text-zinc-400 hover:text-zinc-200 hover:border-white/15',
                      )}
                    >
                      {layout === 'grid' ? <LayoutGrid className="h-4 w-4" /> : <LayoutList className="h-4 w-4" />}
                      {layout}
                    </button>
                  ))}
                </div>
              </div>

              {/* Open in viewer */}
              <ToggleRow
                label="Open in viewer"
                description="Click assets to open full viewer"
                checked={appearance.open_in_viewer}
                onCheckedChange={(checked) => updateAppearance({ open_in_viewer: checked })}
              />

              {/* Theme — Dark / Light */}
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm text-zinc-200">Theme</p>
                <div className="flex rounded-lg border border-white/[0.08] overflow-hidden">
                  {(['dark', 'light'] as const).map((theme) => (
                    <button
                      key={theme}
                      onClick={() => updateAppearance({ theme })}
                      className={cn(
                        'px-4 py-1.5 text-xs font-medium capitalize transition-colors',
                        appearance.theme === theme
                          ? 'bg-accent text-white'
                          : 'text-zinc-400 hover:text-zinc-200',
                      )}
                    >
                      {theme === 'dark' ? '🌙' : '☀️'}
                    </button>
                  ))}
                </div>
              </div>

              {/* Accent color */}
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm text-zinc-200">Accent Color</p>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-zinc-500">#</span>
                  <input
                    type="text"
                    value={localAccentColor}
                    onChange={(e) => setLocalAccentColor(e.target.value)}
                    onBlur={() => {
                      const color = localAccentColor.trim() || null
                      if (color !== (appearance.accent_color || '')) {
                        updateAppearance({ accent_color: color ? `#${color.replace('#', '')}` : null })
                      }
                    }}
                    placeholder="None"
                    maxLength={7}
                    className="w-20 rounded border border-white/[0.08] bg-white/[0.04] px-2 py-1 text-xs text-zinc-300 placeholder:text-zinc-600 outline-none focus:border-accent/50 font-mono"
                  />
                  <label className="relative h-6 w-6 rounded-full border border-white/10 cursor-pointer overflow-hidden shrink-0">
                    <div
                      className="absolute inset-0 rounded-full"
                      style={{ backgroundColor: localAccentColor ? `#${localAccentColor.replace('#', '')}` : '#6366f1' }}
                    />
                    <input
                      type="color"
                      value={localAccentColor ? `#${localAccentColor.replace('#', '')}` : '#6366f1'}
                      onChange={(e) => {
                        const hex = e.target.value.replace('#', '')
                        setLocalAccentColor(hex)
                        updateAppearance({ accent_color: `#${hex}` })
                      }}
                      className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    />
                  </label>
                </div>
              </div>

              {/* Card Size — S / M / L */}
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm text-zinc-200">Card Size</p>
                <div className="flex rounded-lg border border-white/[0.08] overflow-hidden">
                  {(['s', 'm', 'l'] as const).map((size) => (
                    <button
                      key={size}
                      onClick={() => updateAppearance({ card_size: size })}
                      className={cn(
                        'px-4 py-1.5 text-xs font-medium uppercase transition-colors',
                        (appearance.card_size || 'm') === size
                          ? 'bg-accent text-white'
                          : 'text-zinc-400 hover:text-zinc-200',
                      )}
                    >
                      {size}
                    </button>
                  ))}
                </div>
              </div>

              {/* Aspect Ratio */}
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm text-zinc-200">Aspect Ratio</p>
                <div className="flex rounded-lg border border-white/[0.08] overflow-hidden">
                  {([
                    { value: 'landscape' as const, icon: '▭' },
                    { value: 'square' as const, icon: '□' },
                    { value: 'portrait' as const, icon: '▯' },
                  ]).map(({ value, icon }) => (
                    <button
                      key={value}
                      onClick={() => updateAppearance({ aspect_ratio: value })}
                      className={cn(
                        'px-4 py-1.5 text-sm transition-colors',
                        (appearance.aspect_ratio || 'landscape') === value
                          ? 'bg-accent text-white'
                          : 'text-zinc-400 hover:text-zinc-200',
                      )}
                    >
                      {icon}
                    </button>
                  ))}
                </div>
              </div>

              {/* Thumbnail Scale — Fit / Fill */}
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm text-zinc-200">Thumbnail Scale</p>
                <div className="flex rounded-lg border border-white/[0.08] overflow-hidden">
                  {(['fit', 'fill'] as const).map((scale) => (
                    <button
                      key={scale}
                      onClick={() => updateAppearance({ thumbnail_scale: scale })}
                      className={cn(
                        'px-4 py-1.5 text-xs font-medium capitalize transition-colors',
                        (appearance.thumbnail_scale || 'fill') === scale
                          ? 'bg-accent text-white'
                          : 'text-zinc-400 hover:text-zinc-200',
                      )}
                    >
                      {scale}
                    </button>
                  ))}
                </div>
              </div>

              {/* Show Card Info */}
              <ToggleRow
                label="Show Card Info"
                description="Display name, type, and size below thumbnail"
                checked={appearance.show_card_info !== false}
                onCheckedChange={(checked) => updateAppearance({ show_card_info: checked })}
              />
            </Section>

            {/* Sort By */}
            <Section title="Sort By" icon={<Layers className="h-3.5 w-3.5" />} defaultOpen={false}>
              <select
                value={appearance.sort_by}
                onChange={(e) =>
                  updateAppearance({
                    sort_by: e.target.value as ShareLinkAppearance['sort_by'],
                  })
                }
                className="w-full rounded-md border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm text-zinc-200 outline-none focus:border-accent/50 [color-scheme:dark]"
              >
                <option value="name">Name</option>
                <option value="created_at">Date created</option>
                <option value="file_size">Size</option>
              </select>
            </Section>
          </div>
        ) : (
          <ShareLinkActivityPanel token={token} />
        )}
      </div>

      {/* Bottom action buttons */}
      <div className="border-t border-border p-3 shrink-0 flex items-center gap-2">
        <button
          onClick={() => window.open(shareUrl, '_blank')}
          className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent/90 transition-colors"
        >
          <ExternalLink className="h-4 w-4" />
          Open Share Link
        </button>
        <CopyLinkButton text={shareUrl} />
      </div>
    </>
  )
}

// ─── Legacy default export (kept for backward compat, now delegates) ────────

export function ShareLinkDetail({ token, projectId, onBack, frontendUrl }: ShareLinkContentProps) {
  return (
    <ShareLinkContent
      token={token}
      projectId={projectId}
      onBack={onBack}
      frontendUrl={frontendUrl}
    />
  )
}
