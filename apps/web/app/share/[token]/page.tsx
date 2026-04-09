'use client'

import * as React from 'react'
import {
  Lock,
  AlertTriangle,
  Clock,
  Loader2,
  CheckCircle2,
  XCircle,
  Download,
  ArrowLeft,
  Columns2,
  MessageSquare,
  User,
  FileText,
  Image as ImageIcon,
  Video,
  Music,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { GuestCommentInput } from '@/components/review/guest-comment-input'
import { FolderShareViewer } from '@/components/share/folder-share-viewer'
import type { Asset, SharePermission, ProjectBranding, ShareLinkAppearance } from '@/types'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ShareValidateResponse {
  asset?: Asset
  asset_id?: string | null
  folder_id?: string | null
  project_id?: string | null
  folder_name?: string
  project_name?: string
  title?: string
  description?: string | null
  permission?: SharePermission
  allow_download?: boolean
  show_versions?: boolean
  show_watermark?: boolean
  appearance?: ShareLinkAppearance | null
  visibility?: string
  requires_password?: boolean
  requires_auth?: boolean
  share_session?: string | null
  expired?: boolean
  created_by_name?: string | null
  viewer_name?: string | null
  viewer_email?: string | null
  branding?: ProjectBranding | null
  error?: string
}

interface GuestComment {
  id: string
  body: string
  guest_name: string
  guest_email: string
  created_at: string
  timecode_start?: number | null
}

interface CommentsResponse {
  comments: GuestComment[]
}

// ─── Utility ──────────────────────────────────────────────────────────────────

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

async function fetchShareInfo(
  token: string,
  password?: string,
  logOpen?: boolean,
): Promise<ShareValidateResponse> {
  const params = new URLSearchParams()
  if (password) params.set('password', password)
  if (logOpen) params.set('log_open', 'true')
  const qs = params.toString() ? `?${params.toString()}` : ''
  const url = `${API_URL}/share/${token}${qs}`

  // Include auth token if user is already logged in (for secure links)
  const headers: Record<string, string> = {}
  let accessToken: string | null = null
  try {
    if (typeof window !== 'undefined') {
      accessToken = localStorage.getItem('ff_access_token')
    }
  } catch {}
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`
  }

  const response = await fetch(url, { headers })
  if (!response.ok) {
    if (response.status === 403) {
      const data = await response.json().catch(() => ({}))
      if (data.detail === 'Incorrect password') {
        return { requires_password: true, error: 'Incorrect password' }
      }
      return { requires_password: true }
    }
    if (response.status === 410) return { expired: true }
    return {}
  }
  return response.json()
}

// ─── Password gate ────────────────────────────────────────────────────────────

interface PasswordGateProps {
  onSubmit: (password: string) => void
  error?: string | null
  loading?: boolean
}

function PasswordGate({ onSubmit, error, loading }: PasswordGateProps) {
  const [password, setPassword] = React.useState('')

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (password.trim()) onSubmit(password.trim())
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-primary p-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-bg-secondary p-6 shadow-xl">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-accent-muted">
            <Lock className="h-5 w-5 text-accent" />
          </div>
          <div>
            <h1 className="text-sm font-semibold text-text-primary">Password required</h1>
            <p className="text-xs text-text-tertiary">Enter the password to access this link</p>
          </div>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter password…"
            autoFocus
            className="flex h-9 w-full rounded-md border border-border bg-bg-tertiary px-3 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-border-focus"
          />
          {error && <p className="text-xs text-status-error">{error}</p>}
          <Button type="submit" size="sm" className="w-full" loading={loading}>
            Access link
          </Button>
        </form>
      </div>
    </div>
  )
}

// ─── Error state ──────────────────────────────────────────────────────────────

interface ErrorStateProps {
  expired?: boolean
}

function ErrorState({ expired }: ErrorStateProps) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-primary p-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-bg-secondary p-6 text-center shadow-xl">
        <div className="mb-4 flex justify-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-status-error/10">
            {expired ? (
              <Clock className="h-6 w-6 text-status-error" />
            ) : (
              <AlertTriangle className="h-6 w-6 text-status-error" />
            )}
          </div>
        </div>
        <h1 className="text-sm font-semibold text-text-primary">
          {expired ? 'Link expired' : 'Link not found'}
        </h1>
        <p className="mt-1 text-xs text-text-tertiary">
          {expired
            ? 'This share link has expired and is no longer accessible.'
            : 'This share link is invalid or has been removed.'}
        </p>
      </div>
    </div>
  )
}

// ─── Guest comment list (for right panel) ────────────────────────────────────

interface GuestCommentListProps {
  token: string
  refreshKey: number
}

function GuestCommentList({ token, refreshKey }: GuestCommentListProps) {
  const [comments, setComments] = React.useState<GuestComment[]>([])
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    setLoading(true)
    fetch(`${API_URL}/share/${token}/comments`)
      .then((r) => (r.ok ? r.json() : Promise.resolve({ comments: [] })))
      .then((data: CommentsResponse) => setComments(data.comments ?? []))
      .catch(() => setComments([]))
      .finally(() => setLoading(false))
  }, [token, refreshKey])

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-zinc-500" />
      </div>
    )
  }

  if (comments.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
        <div className="h-12 w-12 rounded-full bg-white/5 flex items-center justify-center mb-3">
          <MessageSquare className="h-6 w-6 text-zinc-600" />
        </div>
        <p className="text-sm font-medium text-zinc-300">No comments — yet</p>
        <p className="text-xs text-zinc-500 mt-1">
          Be the first to leave feedback on this asset.
        </p>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2.5">
      {comments.map((comment) => (
        <div
          key={comment.id}
          className="rounded-lg bg-white/[0.03] border border-white/5 px-3 py-2.5"
        >
          <div className="flex items-center gap-2 mb-1.5">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-purple-500/20 text-2xs font-medium text-purple-400">
              {comment.guest_name.charAt(0).toUpperCase()}
            </div>
            <span className="text-xs font-medium text-zinc-200">{comment.guest_name}</span>
            {comment.timecode_start != null && (
              <span className="text-2xs text-zinc-500 font-mono bg-white/5 px-1.5 py-0.5 rounded">
                {Math.floor(comment.timecode_start / 60)}:
                {String(Math.floor(comment.timecode_start % 60)).padStart(2, '0')}
              </span>
            )}
            <span className="ml-auto text-2xs text-zinc-600">
              {new Date(comment.created_at).toLocaleDateString()}
            </span>
          </div>
          <p className="text-sm text-zinc-300 leading-relaxed">{comment.body}</p>
        </div>
      ))}
    </div>
  )
}

// ─── Guest approval actions ───────────────────────────────────────────────────

interface GuestApprovalActionsProps {
  token: string
  asset: Asset
}

function GuestApprovalActions({ token, asset }: GuestApprovalActionsProps) {
  const [status, setStatus] = React.useState<'idle' | 'approved' | 'rejected'>('idle')
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  async function handleDecision(decision: 'approved' | 'rejected') {
    setLoading(true)
    setError(null)
    try {
      const response = await fetch(`${API_URL}/share/${token}/${decision === 'approved' ? 'approve' : 'reject'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ asset_id: asset.id }),
      })
      if (!response.ok) throw new Error('Failed to submit decision')
      setStatus(decision)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit')
    } finally {
      setLoading(false)
    }
  }

  if (status === 'approved') {
    return (
      <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-green-500/10 border border-green-500/20">
        <CheckCircle2 className="h-4 w-4 text-green-400" />
        <span className="text-sm font-medium text-green-400">Approved</span>
      </div>
    )
  }

  if (status === 'rejected') {
    return (
      <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/20">
        <XCircle className="h-4 w-4 text-red-400" />
        <span className="text-sm font-medium text-red-400">Rejected</span>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2">
      {error && <span className="text-xs text-red-400 mr-2">{error}</span>}
      <Button
        variant="secondary"
        size="sm"
        onClick={() => handleDecision('rejected')}
        disabled={loading}
        className="text-red-400 border-red-500/30 hover:border-red-500/60 hover:bg-red-500/10"
      >
        <XCircle className="h-4 w-4" />
        Reject
      </Button>
      <Button
        variant="primary"
        size="sm"
        onClick={() => handleDecision('approved')}
        loading={loading}
        className="bg-green-600 hover:bg-green-700"
      >
        <CheckCircle2 className="h-4 w-4" />
        Approve
      </Button>
    </div>
  )
}

// ─── Share Top Bar ────────────────────────────────────────────────────────────

interface ShareTopBarProps {
  shareName: string
  assetName?: string
  allowDownload: boolean
  downloadUrl: string | null
  token: string
  assetId: string
  sidebarOpen: boolean
  onToggleSidebar: () => void
  onBack?: () => void
  branding: ProjectBranding | null
}

function ShareTopBar({
  shareName,
  assetName,
  allowDownload,
  downloadUrl,
  token,
  assetId,
  sidebarOpen,
  onToggleSidebar,
  onBack,
  branding,
}: ShareTopBarProps) {
  const [downloading, setDownloading] = React.useState(false)

  async function handleDownload() {
    setDownloading(true)
    try {
      const res = await fetch(`${API_URL}/share/${token}/stream/${assetId}?download=true`)
      if (!res.ok) return
      const data = await res.json()
      if (data?.url) {
        const iframe = document.createElement('iframe')
        iframe.style.display = 'none'
        iframe.src = data.url
        document.body.appendChild(iframe)
        setTimeout(() => iframe.remove(), 30000)
      }
    } catch {
      // silent
    } finally {
      setDownloading(false)
    }
  }
  const primaryColor = branding?.primary_color ?? '#7c3aed'

  return (
    <div className="flex items-center justify-between border-b border-white/[0.06] px-3 h-12 bg-zinc-950 shrink-0">
      {/* Left: back + avatar + breadcrumb */}
      <div className="flex items-center gap-2 min-w-0 flex-1">
        {onBack && (
          <button
            onClick={onBack}
            className="flex items-center justify-center h-7 w-7 rounded-md text-zinc-400 hover:text-white hover:bg-white/10 transition-colors shrink-0"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
        )}

        {/* Avatar placeholder */}
        <div
          className="flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold text-white shrink-0"
          style={{ backgroundColor: primaryColor }}
        >
          {branding?.logo_s3_key ? (
            <img
              src={`${API_URL}/share/branding/logo`}
              alt=""
              className="h-full w-full rounded-full object-cover"
              onError={(e) => {
                ;(e.target as HTMLImageElement).style.display = 'none'
              }}
            />
          ) : (
            'FF'
          )}
        </div>

        {/* Breadcrumb */}
        <nav className="flex items-center gap-1 text-[13px] min-w-0">
          <span className="text-zinc-500 shrink-0 truncate max-w-[200px]">
            {shareName}
          </span>
          {assetName && (
            <>
              <span className="text-zinc-600">/</span>
              <span className="text-white font-medium truncate">{assetName}</span>
            </>
          )}
        </nav>
      </div>

      {/* Right: download + panel toggle */}
      <div className="flex items-center gap-2 shrink-0">
        {allowDownload && (
          <button
            onClick={handleDownload}
            disabled={downloading}
            className="inline-flex items-center gap-1.5 rounded-md bg-purple-600 hover:bg-purple-700 px-3 py-1.5 text-xs font-medium text-white transition-colors disabled:opacity-60"
          >
            {downloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            Download
          </button>
        )}

        <button
          onClick={onToggleSidebar}
          className={cn(
            'flex items-center justify-center h-8 w-8 rounded-md transition-colors',
            sidebarOpen
              ? 'bg-white/10 text-white'
              : 'text-zinc-500 hover:text-white hover:bg-white/10',
          )}
          title="Toggle panel"
        >
          <Columns2 className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}

// ─── Share Media Viewer ───────────────────────────────────────────────────────

interface ShareMediaViewerProps {
  asset: Asset & { thumbnail_url?: string; stream_url?: string }
  token: string
  streamUrl: string | null
  streamLoading: boolean
}

function ShareMediaViewer({ asset, token, streamUrl, streamLoading }: ShareMediaViewerProps) {
  return (
    <div className="flex-1 flex items-center justify-center bg-black min-h-0 overflow-hidden">
      {asset.asset_type === 'video' && (
        <div className="w-full h-full flex items-center justify-center">
          {streamLoading ? (
            <Loader2 className="h-8 w-8 animate-spin text-zinc-500" />
          ) : streamUrl ? (
            <video
              src={streamUrl}
              controls
              className="max-h-full max-w-full"
              preload="metadata"
            >
              Your browser does not support video playback.
            </video>
          ) : (
            <div className="flex flex-col items-center gap-2">
              <Video className="h-10 w-10 text-zinc-700" />
              <p className="text-sm text-zinc-500">Video unavailable</p>
            </div>
          )}
        </div>
      )}

      {asset.asset_type === 'audio' && (
        <div className="w-full max-w-2xl px-8">
          {streamLoading ? (
            <Loader2 className="h-6 w-6 animate-spin text-zinc-500 mx-auto" />
          ) : streamUrl ? (
            <div className="space-y-6">
              <div className="flex flex-col items-center gap-3">
                <div className="h-24 w-24 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center">
                  <Music className="h-10 w-10 text-zinc-500" />
                </div>
                <p className="text-sm font-medium text-zinc-300">{asset.name}</p>
              </div>
              <audio src={streamUrl} controls className="w-full">
                Your browser does not support audio playback.
              </audio>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2">
              <Music className="h-10 w-10 text-zinc-700" />
              <p className="text-sm text-zinc-500">Audio unavailable</p>
            </div>
          )}
        </div>
      )}

      {(asset.asset_type === 'image' || asset.asset_type === 'image_carousel') && (
        <div className="w-full h-full flex items-center justify-center p-4">
          <img
            src={asset.thumbnail_url || asset.stream_url || `${API_URL}/share/${token}/thumbnail/${asset.id}`}
            alt={asset.name}
            className="max-h-full max-w-full object-contain"
            onError={(e) => {
              const target = e.target as HTMLImageElement
              target.style.display = 'none'
              const parent = target.parentElement
              if (parent) {
                const fallback = document.createElement('div')
                fallback.className = 'flex flex-col items-center gap-2'
                fallback.innerHTML = `
                  <svg class="h-10 w-10 text-zinc-700" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
                  <p class="text-sm text-zinc-500">Image unavailable</p>
                `
                parent.appendChild(fallback)
              }
            }}
          />
        </div>
      )}
    </div>
  )
}

// ─── Share Right Panel ────────────────────────────────────────────────────────

interface ShareRightPanelProps {
  token: string
  asset: Asset & { thumbnail_url?: string; stream_url?: string }
  permission: SharePermission
  commentRefreshKey: number
  onCommentPosted: () => void
}

function ShareRightPanel({
  token,
  asset,
  permission,
  commentRefreshKey,
  onCommentPosted,
}: ShareRightPanelProps) {
  const [activeTab, setActiveTab] = React.useState<'comments' | 'fields'>('comments')

  return (
    <div className="w-[360px] flex flex-col border-l border-white/[0.06] bg-[#141416] shrink-0 animate-in slide-in-from-right-2 duration-150">
      {/* Tabs */}
      <div className="px-4 pt-3 pb-2 shrink-0">
        <div className="flex items-center bg-white/5 rounded-lg p-0.5">
          <button
            onClick={() => setActiveTab('comments')}
            className={cn(
              'flex-1 py-1.5 text-[13px] font-medium rounded-md transition-all flex items-center justify-center gap-1.5',
              activeTab === 'comments'
                ? 'bg-white/10 text-white shadow-sm'
                : 'text-zinc-500 hover:text-zinc-300',
            )}
          >
            <MessageSquare className="h-3.5 w-3.5" />
            Comments
          </button>
          <button
            onClick={() => setActiveTab('fields')}
            className={cn(
              'flex-1 py-1.5 text-[13px] font-medium rounded-md transition-all flex items-center justify-center gap-1.5',
              activeTab === 'fields'
                ? 'bg-white/10 text-white shadow-sm'
                : 'text-zinc-500 hover:text-zinc-300',
            )}
          >
            <FileText className="h-3.5 w-3.5" />
            Fields
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        {activeTab === 'comments' ? (
          <>
            {/* Comments header */}
            <div className="px-4 py-2 shrink-0 flex items-center justify-between">
              <span className="text-xs font-medium text-zinc-400">All comments</span>
            </div>

            {/* Comment list */}
            <GuestCommentList token={token} refreshKey={commentRefreshKey} />

            {/* Approval actions */}
            {permission === 'approve' && (
              <div className="px-4 py-3 border-t border-white/[0.06] shrink-0">
                <GuestApprovalActions token={token} asset={asset} />
              </div>
            )}

            {/* Comment input */}
            {(permission === 'comment' || permission === 'approve') ? (
              <GuestCommentInput
                token={token}
                onCommentPosted={onCommentPosted}
                className="border-t border-white/[0.06] bg-[#141416]"
              />
            ) : (
              <div className="px-4 py-3 border-t border-white/[0.06] shrink-0">
                <p className="text-xs text-zinc-600 text-center">View-only access. Comments are disabled.</p>
              </div>
            )}
          </>
        ) : (
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            <div className="space-y-3">
              <FieldRow label="Name" value={asset.name} />
              <FieldRow label="Type" value={asset.asset_type.replace('_', ' ')} capitalize />
{asset.description && <FieldRow label="Description" value={asset.description} />}
              {asset.rating != null && <FieldRow label="Rating" value={`${asset.rating}/5`} />}
              {asset.due_date && (
                <FieldRow
                  label="Due date"
                  value={new Date(asset.due_date).toLocaleDateString()}
                />
              )}
              {asset.keywords && asset.keywords.length > 0 && (
                <div className="space-y-1">
                  <span className="text-xs text-zinc-500">Keywords</span>
                  <div className="flex flex-wrap gap-1">
                    {asset.keywords.map((kw: string, i: number) => (
                      <span
                        key={i}
                        className="text-2xs bg-white/5 text-zinc-400 rounded px-1.5 py-0.5"
                      >
                        {kw}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function FieldRow({
  label,
  value,
  capitalize: shouldCapitalize,
}: {
  label: string
  value: string
  capitalize?: boolean
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-zinc-500">{label}</span>
      <span className={cn('text-xs text-zinc-200 font-medium truncate ml-4 max-w-[200px]', shouldCapitalize && 'capitalize')}>
        {value}
      </span>
    </div>
  )
}

// ─── Share Viewer (single asset — Frame.io layout) ────────────────────────────

interface ShareViewerProps {
  token: string
  asset: Asset & { thumbnail_url?: string; stream_url?: string }
  permission: SharePermission
  allowDownload: boolean
  branding: ProjectBranding | null
  shareName?: string
  onBack?: () => void
}

function ShareViewer({
  token,
  asset,
  permission,
  allowDownload,
  branding,
  shareName,
  onBack,
}: ShareViewerProps) {
  const [streamUrl, setStreamUrl] = React.useState<string | null>(asset.stream_url ?? null)
  const [streamLoading, setStreamLoading] = React.useState(false)
  const [commentKey, setCommentKey] = React.useState(0)
  const [sidebarOpen, setSidebarOpen] = React.useState(true)

  // For video/audio assets, get a stream URL if not already provided
  React.useEffect(() => {
    if (asset.stream_url) {
      setStreamUrl(asset.stream_url)
      return
    }
    if (asset.asset_type !== 'video' && asset.asset_type !== 'audio') return
    setStreamLoading(true)
    fetch(`${API_URL}/share/${token}/stream/${asset.id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.stream_url) setStreamUrl(data.stream_url)
        else if (data?.url) setStreamUrl(data.url)
      })
      .catch(() => null)
      .finally(() => setStreamLoading(false))
  }, [token, asset.asset_type, asset.stream_url, asset.id])

  const displayName = shareName || branding?.custom_title || 'FreeFrame'

  return (
    <div className="absolute inset-0 flex flex-col bg-zinc-950 text-white overflow-hidden">
      {/* Top bar */}
      <ShareTopBar
        shareName={displayName}
        assetName={asset.name}
        allowDownload={allowDownload}
        downloadUrl={streamUrl}
        token={token}
        assetId={asset.id}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((p) => !p)}
        onBack={onBack}
        branding={branding}
      />

      {/* Main content: viewer + sidebar */}
      <div className="flex flex-1 overflow-hidden min-h-0">
        {/* Left: full-screen media viewer */}
        <ShareMediaViewer
          asset={asset}
          token={token}
          streamUrl={streamUrl}
          streamLoading={streamLoading}
        />

        {/* Right: comments panel */}
        {sidebarOpen && (
          <ShareRightPanel
            token={token}
            asset={asset}
            permission={permission}
            commentRefreshKey={commentKey}
            onCommentPosted={() => setCommentKey((k) => k + 1)}
          />
        )}
      </div>

      {/* Custom footer */}
      {branding?.custom_footer && (
        <div className="shrink-0 border-t border-white/[0.06] px-4 py-1.5 text-center">
          <p className="text-2xs text-zinc-600">{branding.custom_footer}</p>
        </div>
      )}
    </div>
  )
}

// ─── Folder Asset Viewer (single asset within folder share) ──────────────────

interface FolderAssetViewerProps {
  token: string
  assetId: string
  permission: SharePermission
  allowDownload: boolean
  branding: any
  folderName: string
  onBack: () => void
}

function FolderAssetViewer({
  token,
  assetId,
  permission,
  allowDownload,
  branding,
  folderName,
  onBack,
}: FolderAssetViewerProps) {
  const [streamUrl, setStreamUrl] = React.useState<string | null>(null)
  const [thumbnailUrl, setThumbnailUrl] = React.useState<string | null>(null)
  const [assetInfo, setAssetInfo] = React.useState<{
    name: string
    asset_type: string
    description?: string
    status?: string
    keywords?: string[]
  } | null>(null)
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    let cancelled = false
    setLoading(true)

    const streamPromise = fetch(`${API_URL}/share/${token}/stream/${assetId}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)

    const thumbPromise = fetch(`${API_URL}/share/${token}/thumbnail/${assetId}`)
      .then((r) => {
        if (!r.ok) return null
        const contentType = r.headers.get('content-type')
        if (contentType?.includes('application/json')) {
          return r.json()
        }
        return { url: `${API_URL}/share/${token}/thumbnail/${assetId}` }
      })
      .catch(() => null)

    Promise.all([streamPromise, thumbPromise]).then(([streamData, thumbData]) => {
      if (cancelled) return
      if (streamData?.url) setStreamUrl(streamData.url)
      if (streamData?.name)
        setAssetInfo({
          name: streamData.name,
          asset_type: streamData.asset_type ?? 'image',
          description: streamData.description,
          status: streamData.status,
          keywords: streamData.keywords,
        })
      else setAssetInfo({ name: 'Asset', asset_type: 'image' })
      if (thumbData?.url) setThumbnailUrl(thumbData.url)
      setLoading(false)
    })

    return () => {
      cancelled = true
    }
  }, [token, assetId])

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-950">
        <Loader2 className="h-8 w-8 animate-spin text-zinc-500" />
      </div>
    )
  }

  const assetType = assetInfo?.asset_type ?? 'image'

  // Build a pseudo-asset object for the viewer
  const pseudoAsset = {
    id: assetId,
    name: assetInfo?.name ?? 'Asset',
    asset_type: assetType,
    description: assetInfo?.description,
    status: assetInfo?.status ?? 'draft',
    keywords: assetInfo?.keywords ?? [],
    thumbnail_url: thumbnailUrl,
    stream_url: streamUrl,
  } as Asset & { thumbnail_url?: string; stream_url?: string }

  return (
    <ShareViewer
      token={token}
      asset={pseudoAsset}
      permission={permission}
      allowDownload={allowDownload}
      branding={branding}
      shareName={folderName}
      onBack={onBack}
    />
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function SharePage({
  params,
}: {
  params: { token: string }
}) {
  const { token } = params

  type PageState =
    | { stage: 'loading' }
    | { stage: 'password_required'; error?: string; loading?: boolean }
    | { stage: 'expired' }
    | { stage: 'invalid' }
    | { stage: 'auth_required'; title?: string }
    | {
        stage: 'ready'
        asset: Asset & { thumbnail_url?: string; stream_url?: string }
        permission: SharePermission
        allowDownload: boolean
        showVersions: boolean
        branding: ProjectBranding | null
      }
    | {
        stage: 'folder_ready'
        folderName: string
        title: string
        description: string | null
        createdByName: string | null
        viewerName: string | null
        permission: SharePermission
        allowDownload: boolean
        showVersions: boolean
        appearance: ShareLinkAppearance
        branding: any
      }

  const [state, setState] = React.useState<PageState>({ stage: 'loading' })
  const [shareSession, setShareSession] = React.useState<string | null>(null)
  const openLogged = React.useRef(false)

  async function validate(password?: string) {
    if (password) {
      setState({ stage: 'password_required', loading: true })
    }
    try {
      const shouldLogOpen = !password && !openLogged.current
      if (shouldLogOpen) openLogged.current = true
      const data = await fetchShareInfo(token, password, shouldLogOpen)
      if (data.requires_auth) {
        setState({ stage: 'auth_required', title: data.title })
        return
      }
      if (data.requires_password) {
        setState({ stage: 'password_required', error: data.error || undefined })
        return
      }
      if (data.expired) {
        setState({ stage: 'expired' })
        return
      }
      if (!data.permission) {
        setState({ stage: 'invalid' })
        return
      }

      // Store share session from password-protected link validation
      if (data.share_session) {
        setShareSession(data.share_session)
      }

      // Folder share mode OR project root share mode
      if ((data.folder_id || data.project_id) && !data.asset_id) {
        const defaultAppearance: ShareLinkAppearance = {
          layout: 'grid',
          theme: 'dark',
          accent_color: null,
          open_in_viewer: true,
          sort_by: 'created_at',
          card_size: 'm',
          aspect_ratio: 'landscape',
          thumbnail_scale: 'fill',
          show_card_info: true,
        }
        const folderName = data.folder_name ?? data.project_name ?? 'Shared'
        setState({
          stage: 'folder_ready',
          folderName,
          title: data.title ?? folderName,
          description: data.description ?? null,
          createdByName: data.created_by_name ?? null,
          viewerName: data.viewer_name ?? null,
          permission: data.permission,
          allowDownload: data.allow_download ?? false,
          showVersions: data.show_versions ?? true,
          appearance: { ...defaultAppearance, ...(data.appearance ?? {}) },
          branding: data.branding ?? null,
        })
        return
      }

      // Standard asset share mode
      if (!data.asset) {
        setState({ stage: 'invalid' })
        return
      }
      setState({
        stage: 'ready',
        asset: data.asset,
        permission: data.permission,
        allowDownload: data.allow_download ?? false,
        showVersions: data.show_versions ?? true,
        branding: data.branding ?? null,
      })
    } catch {
      setState({ stage: 'invalid' })
    }
  }

  React.useEffect(() => {
    validate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  if (state.stage === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-950">
        <Loader2 className="h-8 w-8 animate-spin text-zinc-500" />
      </div>
    )
  }

  if (state.stage === 'password_required') {
    return (
      <PasswordGate
        onSubmit={(pw) => validate(pw)}
        error={state.error}
        loading={state.loading}
      />
    )
  }

  if (state.stage === 'expired') {
    return <ErrorState expired />
  }

  if (state.stage === 'invalid') {
    return <ErrorState />
  }

  if (state.stage === 'auth_required') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg-primary p-4">
        <div className="w-full max-w-sm rounded-xl border border-border bg-bg-secondary p-6 shadow-xl text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-accent-muted">
            <Lock className="h-6 w-6 text-accent" />
          </div>
          <h1 className="text-lg font-semibold text-text-primary">
            {state.title || 'Secure Share Link'}
          </h1>
          <p className="mt-2 text-sm text-text-tertiary">
            This link is private. Please sign in to view the shared content.
          </p>
          <a
            href="/login"
            className="mt-4 inline-flex w-full items-center justify-center rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent/90 transition-colors"
          >
            Sign in to continue
          </a>
        </div>
      </div>
    )
  }

  if (state.stage === 'folder_ready') {
    return (
      <FolderShareViewer
        token={token}
        shareSession={shareSession}
        folderName={state.folderName}
        title={state.title}
        description={state.description}
        createdByName={state.createdByName}
        viewerName={state.viewerName}
        permission={state.permission}
        allowDownload={state.allowDownload}
        showVersions={state.showVersions}
        appearance={state.appearance}
        branding={state.branding}
      />
    )
  }

  return (
    <ShareViewer
      token={token}
      asset={state.asset}
      permission={state.permission}
      allowDownload={state.allowDownload}
      branding={state.branding}
    />
  )
}
