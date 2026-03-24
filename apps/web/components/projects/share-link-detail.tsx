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
  Layout,
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

  React.useEffect(() => {
    if (shareLink) {
      setLocalTitle(shareLink.title || '')
      setLocalDescription(shareLink.description || '')
    }
  }, [shareLink])

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

  const shareType = shareLink.folder_id ? 'folder' : 'asset'

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

        {/* Content preview placeholder */}
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-8">
          <div className="flex flex-col items-center justify-center text-center space-y-3">
            <div className="h-12 w-12 rounded-full bg-white/[0.05] flex items-center justify-center">
              {shareType === 'folder' ? (
                <Layout className="h-6 w-6 text-zinc-500" />
              ) : (
                <Eye className="h-6 w-6 text-zinc-500" />
              )}
            </div>
            <div>
              <p className="text-sm font-medium text-zinc-300 capitalize">
                {shareType} Share
              </p>
            </div>
          </div>
        </div>

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
                description="Anyone with the link can access"
                checked={shareLink.is_enabled}
                onCheckedChange={(checked) => immediateUpdate({ is_enabled: checked })}
              />
              <div className="flex items-center gap-2 rounded-md bg-white/[0.04] px-3 py-2 mt-2">
                <span className="flex-1 truncate font-mono text-xs text-zinc-400">
                  {shareUrl}
                </span>
                <CopyButton text={shareUrl} />
              </div>
              <div className="flex items-center gap-1.5 mt-1">
                <span className="inline-flex items-center rounded-full bg-green-500/10 px-2 py-0.5 text-2xs font-medium text-green-400">
                  Public
                </span>
              </div>
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
                        updateAppearance({ accent_color: color })
                      }
                    }}
                    placeholder="None"
                    maxLength={7}
                    className="w-20 rounded border border-white/[0.08] bg-white/[0.04] px-2 py-1 text-xs text-zinc-300 placeholder:text-zinc-600 outline-none focus:border-accent/50 font-mono"
                  />
                  {localAccentColor ? (
                    <div
                      className="h-5 w-5 rounded-full border border-white/10"
                      style={{ backgroundColor: `#${localAccentColor.replace('#', '')}` }}
                    />
                  ) : (
                    <div className="h-5 w-5 rounded-full border border-white/10 bg-white/[0.04]" />
                  )}
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
