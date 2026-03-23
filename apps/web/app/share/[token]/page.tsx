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
  ExternalLink,
  ArrowLeft,
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
  folder_name?: string
  title?: string
  description?: string | null
  permission?: SharePermission
  allow_download?: boolean
  show_versions?: boolean
  show_watermark?: boolean
  appearance?: ShareLinkAppearance | null
  requires_password?: boolean
  expired?: boolean
  branding?: ProjectBranding | null
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
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const body = password ? JSON.stringify({ password }) : undefined
  const method = password ? 'POST' : 'GET'
  const logParam = logOpen ? '?log_open=true' : ''
  const url = password
    ? `${API_URL}/share/${token}/validate`
    : `${API_URL}/share/${token}${logParam}`

  const response = await fetch(url, { method, headers, body })
  if (!response.ok) {
    if (response.status === 401) return { requires_password: true }
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

// ─── Guest comment list ───────────────────────────────────────────────────────

interface GuestCommentListProps {
  token: string
}

function GuestCommentList({ token }: GuestCommentListProps) {
  const [comments, setComments] = React.useState<GuestComment[]>([])
  const [loading, setLoading] = React.useState(true)
  const [refreshKey, setRefreshKey] = React.useState(0)

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
      <div className="flex items-center gap-2 py-4">
        <Loader2 className="h-4 w-4 animate-spin text-text-tertiary" />
        <span className="text-sm text-text-tertiary">Loading comments…</span>
      </div>
    )
  }

  if (comments.length === 0) {
    return (
      <p className="py-4 text-center text-sm text-text-tertiary">No comments yet. Be the first!</p>
    )
  }

  return (
    <div className="space-y-3">
      {comments.map((comment) => (
        <div
          key={comment.id}
          className="rounded-lg border border-border bg-bg-secondary p-3"
        >
          <div className="flex items-center gap-2 mb-1.5">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-muted text-2xs font-medium text-accent">
              {comment.guest_name.charAt(0).toUpperCase()}
            </div>
            <span className="text-xs font-medium text-text-primary">{comment.guest_name}</span>
            {comment.timecode_start != null && (
              <span className="text-2xs text-text-tertiary font-mono">
                @ {Math.floor(comment.timecode_start / 60)}:{String(Math.floor(comment.timecode_start % 60)).padStart(2, '0')}
              </span>
            )}
            <span className="ml-auto text-2xs text-text-tertiary">
              {new Date(comment.created_at).toLocaleDateString()}
            </span>
          </div>
          <p className="text-sm text-text-secondary leading-relaxed">{comment.body}</p>
        </div>
      ))}
    </div>
  )
}

// ─── Share page viewer ────────────────────────────────────────────────────────

interface ShareViewerProps {
  token: string
  asset: Asset
  permission: SharePermission
  allowDownload: boolean
  branding: ProjectBranding | null
}

function ShareViewer({ token, asset, permission, allowDownload, branding }: ShareViewerProps) {
  const [streamUrl, setStreamUrl] = React.useState<string | null>(null)
  const [streamLoading, setStreamLoading] = React.useState(false)
  const [commentKey, setCommentKey] = React.useState(0)

  // For video/audio assets, get a stream URL via the share token
  React.useEffect(() => {
    if (asset.asset_type !== 'video' && asset.asset_type !== 'audio') return
    setStreamLoading(true)
    fetch(`${API_URL}/share/${token}/stream`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.url) setStreamUrl(data.url)
      })
      .catch(() => null)
      .finally(() => setStreamLoading(false))
  }, [token, asset.asset_type])

  const primaryColor = branding?.primary_color ?? '#6366f1'
  const brandingTitle = branding?.custom_title ?? 'FreeFrame'

  return (
    <div className="min-h-screen bg-bg-primary text-text-primary">
      {/* Brand header */}
      <header
        className="flex items-center justify-between border-b border-border px-5 py-3"
        style={{ borderBottomColor: `${primaryColor}30` }}
      >
        <div className="flex items-center gap-3">
          {branding?.logo_s3_key ? (
            <img
              src={`${API_URL}/share/${token}/branding/logo`}
              alt={brandingTitle}
              className="h-7 w-auto object-contain"
            />
          ) : (
            <div
              className="flex h-7 w-7 items-center justify-center rounded text-xs font-bold text-white"
              style={{ backgroundColor: primaryColor }}
            >
              FF
            </div>
          )}
          <span className="text-sm font-medium text-text-secondary">{brandingTitle}</span>
        </div>

        <div className="flex items-center gap-2">
          {allowDownload && (
            <a
              href={streamUrl ?? '#'}
              download
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-text-secondary',
                'hover:bg-bg-hover hover:text-text-primary transition-colors',
                !streamUrl && 'opacity-50 pointer-events-none',
              )}
            >
              <Download className="h-3.5 w-3.5" />
              Download
            </a>
          )}
        </div>
      </header>

      {/* Asset title */}
      <div className="border-b border-border px-5 py-3">
        <h1 className="text-sm font-medium text-text-primary">{asset.name}</h1>
        {asset.description && (
          <p className="mt-0.5 text-xs text-text-tertiary">{asset.description}</p>
        )}
        <div className="mt-1.5 flex items-center gap-2">
          <span className="rounded-full bg-bg-secondary px-2 py-0.5 text-2xs text-text-tertiary capitalize">
            {asset.asset_type.replace('_', ' ')}
          </span>
          <span className="rounded-full bg-bg-secondary px-2 py-0.5 text-2xs text-text-tertiary capitalize">
            {permission} access
          </span>
        </div>
      </div>

      {/* Main content */}
      <div className="mx-auto max-w-5xl px-4 py-6">
        {/* Media viewer */}
        <div className="mb-6 overflow-hidden rounded-xl border border-border bg-bg-secondary">
          {asset.asset_type === 'video' && (
            <div className="aspect-video w-full bg-black">
              {streamLoading ? (
                <div className="flex h-full items-center justify-center">
                  <Loader2 className="h-8 w-8 animate-spin text-text-tertiary" />
                </div>
              ) : streamUrl ? (
                <video
                  src={streamUrl}
                  controls
                  className="h-full w-full"
                  preload="metadata"
                >
                  Your browser does not support video playback.
                </video>
              ) : (
                <div className="flex h-full items-center justify-center">
                  <p className="text-sm text-text-tertiary">Video unavailable</p>
                </div>
              )}
            </div>
          )}

          {asset.asset_type === 'audio' && (
            <div className="p-6">
              {streamLoading ? (
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="h-6 w-6 animate-spin text-text-tertiary" />
                </div>
              ) : streamUrl ? (
                <audio src={streamUrl} controls className="w-full">
                  Your browser does not support audio playback.
                </audio>
              ) : (
                <p className="text-center text-sm text-text-tertiary py-6">Audio unavailable</p>
              )}
            </div>
          )}

          {(asset.asset_type === 'image' || asset.asset_type === 'image_carousel') && (
            <div className="flex items-center justify-center p-4 bg-bg-tertiary">
              <img
                src={`${API_URL}/share/${token}/thumbnail`}
                alt={asset.name}
                className="max-h-[60vh] w-auto rounded object-contain"
                onError={(e) => {
                  ;(e.target as HTMLImageElement).style.display = 'none'
                }}
              />
            </div>
          )}
        </div>

        {/* Approval actions (for approve permission) */}
        {permission === 'approve' && (
          <div className="mb-6 flex items-center gap-3 rounded-xl border border-border bg-bg-secondary px-4 py-3">
            <p className="flex-1 text-sm text-text-secondary">Your review decision:</p>
            <GuestApprovalActions token={token} asset={asset} />
          </div>
        )}

        {/* Comments section */}
        {(permission === 'comment' || permission === 'approve') && (
          <div className="rounded-xl border border-border bg-bg-secondary overflow-hidden">
            <div className="border-b border-border px-4 py-3">
              <h2 className="text-sm font-medium text-text-primary">Comments</h2>
            </div>
            <div className="px-4 py-4">
              <GuestCommentList key={commentKey} token={token} />
            </div>
            <GuestCommentInput
              token={token}
              onCommentPosted={() => setCommentKey((k) => k + 1)}
            />
          </div>
        )}

        {permission === 'view' && (
          <div className="rounded-xl border border-border bg-bg-secondary px-4 py-3 text-center">
            <p className="text-sm text-text-tertiary">View-only access. Comments are disabled.</p>
          </div>
        )}

        {/* Custom footer */}
        {branding?.custom_footer && (
          <p className="mt-6 text-center text-xs text-text-tertiary">{branding.custom_footer}</p>
        )}
      </div>
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
      <span className="inline-flex items-center gap-1.5 text-sm font-medium text-status-success">
        <CheckCircle2 className="h-4 w-4" />
        You approved
      </span>
    )
  }

  if (status === 'rejected') {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm font-medium text-status-error">
        <XCircle className="h-4 w-4" />
        You rejected
      </span>
    )
  }

  return (
    <div className="flex items-center gap-2">
      {error && <span className="text-xs text-status-error mr-2">{error}</span>}
      <Button
        variant="secondary"
        size="sm"
        onClick={() => handleDecision('rejected')}
        disabled={loading}
        className="text-status-error border-status-error/30 hover:border-status-error/60 hover:bg-status-error/10"
      >
        <XCircle className="h-4 w-4" />
        Reject
      </Button>
      <Button
        variant="primary"
        size="sm"
        onClick={() => handleDecision('approved')}
        loading={loading}
        className="bg-status-success hover:opacity-90"
      >
        <CheckCircle2 className="h-4 w-4" />
        Approve
      </Button>
    </div>
  )
}

// ─── Folder asset viewer (single asset within folder share) ──────────────────

interface FolderAssetViewerProps {
  token: string
  assetId: string
  allowDownload: boolean
  branding: any
  onBack: () => void
}

function FolderAssetViewer({ token, assetId, allowDownload, branding, onBack }: FolderAssetViewerProps) {
  const [streamUrl, setStreamUrl] = React.useState<string | null>(null)
  const [thumbnailUrl, setThumbnailUrl] = React.useState<string | null>(null)
  const [assetInfo, setAssetInfo] = React.useState<{ name: string; asset_type: string; description?: string } | null>(null)
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    let cancelled = false
    setLoading(true)

    // Fetch stream URL (which may also include asset info)
    const streamPromise = fetch(`${API_URL}/share/${token}/stream/${assetId}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)

    // Fetch thumbnail URL
    const thumbPromise = fetch(`${API_URL}/share/${token}/thumbnail/${assetId}`)
      .then((r) => {
        if (!r.ok) return null
        // If the endpoint returns JSON with a url field
        const contentType = r.headers.get('content-type')
        if (contentType?.includes('application/json')) {
          return r.json()
        }
        // If it redirects or returns image directly, use the request URL
        return { url: `${API_URL}/share/${token}/thumbnail/${assetId}` }
      })
      .catch(() => null)

    Promise.all([streamPromise, thumbPromise]).then(([streamData, thumbData]) => {
      if (cancelled) return
      if (streamData?.url) setStreamUrl(streamData.url)
      if (streamData?.name) setAssetInfo({ name: streamData.name, asset_type: streamData.asset_type ?? 'image', description: streamData.description })
      else setAssetInfo({ name: 'Asset', asset_type: 'image' })
      if (thumbData?.url) setThumbnailUrl(thumbData.url)
      setLoading(false)
    })

    return () => { cancelled = true }
  }, [token, assetId])

  const primaryColor = branding?.primary_color ?? '#6366f1'
  const brandingTitle = branding?.custom_title ?? 'FreeFrame'

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg-primary">
        <Loader2 className="h-8 w-8 animate-spin text-text-tertiary" />
      </div>
    )
  }

  const assetType = assetInfo?.asset_type ?? 'image'

  return (
    <div className="min-h-screen bg-bg-primary text-text-primary">
      {/* Brand header */}
      <header
        className="flex items-center justify-between border-b border-border px-5 py-3"
        style={{ borderBottomColor: `${primaryColor}30` }}
      >
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to folder
          </button>
        </div>

        <div className="flex items-center gap-2">
          {allowDownload && streamUrl && (
            <a
              href={streamUrl}
              download
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-text-secondary',
                'hover:bg-bg-hover hover:text-text-primary transition-colors',
              )}
            >
              <Download className="h-3.5 w-3.5" />
              Download
            </a>
          )}
        </div>
      </header>

      {/* Asset title */}
      <div className="border-b border-border px-5 py-3">
        <h1 className="text-sm font-medium text-text-primary">{assetInfo?.name ?? 'Asset'}</h1>
        {assetInfo?.description && (
          <p className="mt-0.5 text-xs text-text-tertiary">{assetInfo.description}</p>
        )}
        <div className="mt-1.5 flex items-center gap-2">
          <span className="rounded-full bg-bg-secondary px-2 py-0.5 text-2xs text-text-tertiary capitalize">
            {assetType.replace('_', ' ')}
          </span>
        </div>
      </div>

      {/* Main content */}
      <div className="mx-auto max-w-5xl px-4 py-6">
        <div className="mb-6 overflow-hidden rounded-xl border border-border bg-bg-secondary">
          {assetType === 'video' && (
            <div className="aspect-video w-full bg-black">
              {streamUrl ? (
                <video src={streamUrl} controls className="h-full w-full" preload="metadata">
                  Your browser does not support video playback.
                </video>
              ) : (
                <div className="flex h-full items-center justify-center">
                  <p className="text-sm text-text-tertiary">Video unavailable</p>
                </div>
              )}
            </div>
          )}

          {assetType === 'audio' && (
            <div className="p-6">
              {streamUrl ? (
                <audio src={streamUrl} controls className="w-full">
                  Your browser does not support audio playback.
                </audio>
              ) : (
                <p className="text-center text-sm text-text-tertiary py-6">Audio unavailable</p>
              )}
            </div>
          )}

          {(assetType === 'image' || assetType === 'image_carousel') && (
            <div className="flex items-center justify-center p-4 bg-bg-tertiary">
              <img
                src={thumbnailUrl ?? `${API_URL}/share/${token}/thumbnail/${assetId}`}
                alt={assetInfo?.name ?? 'Asset'}
                className="max-h-[60vh] w-auto rounded object-contain"
                onError={(e) => {
                  ;(e.target as HTMLImageElement).style.display = 'none'
                }}
              />
            </div>
          )}
        </div>

        {/* Custom footer */}
        {branding?.custom_footer && (
          <p className="mt-6 text-center text-xs text-text-tertiary">{branding.custom_footer}</p>
        )}
      </div>
    </div>
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
    | {
        stage: 'ready'
        asset: Asset
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
        permission: SharePermission
        allowDownload: boolean
        showVersions: boolean
        appearance: ShareLinkAppearance
        branding: any
      }

  const [state, setState] = React.useState<PageState>({ stage: 'loading' })
  const [viewingAssetInFolder, setViewingAssetInFolder] = React.useState<string | null>(null)

  async function validate(password?: string) {
    if (password) {
      setState({ stage: 'password_required', loading: true })
    }
    try {
      const isFirstLoad = !password
      const data = await fetchShareInfo(token, password, isFirstLoad)
      if (data.requires_password && !password) {
        setState({ stage: 'password_required' })
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

      // Folder share mode: folder_id is present, asset_id is null
      if (data.folder_id && !data.asset_id) {
        const defaultAppearance: ShareLinkAppearance = {
          layout: 'grid',
          theme: 'dark',
          accent_color: null,
          open_in_viewer: true,
          sort_by: 'name',
        }
        setState({
          stage: 'folder_ready',
          folderName: data.folder_name ?? 'Shared Folder',
          title: data.title ?? data.folder_name ?? 'Shared Folder',
          description: data.description ?? null,
          permission: data.permission,
          allowDownload: data.allow_download ?? false,
          showVersions: data.show_versions ?? true,
          appearance: data.appearance ?? defaultAppearance,
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
      <div className="flex min-h-screen items-center justify-center bg-bg-primary">
        <Loader2 className="h-8 w-8 animate-spin text-text-tertiary" />
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

  if (state.stage === 'folder_ready' && !viewingAssetInFolder) {
    return (
      <FolderShareViewer
        token={token}
        folderName={state.folderName}
        title={state.title}
        description={state.description}
        permission={state.permission}
        allowDownload={state.allowDownload}
        showVersions={state.showVersions}
        appearance={state.appearance}
        branding={state.branding}
        onAssetClick={(assetId) => setViewingAssetInFolder(assetId)}
      />
    )
  }

  if (state.stage === 'folder_ready' && viewingAssetInFolder) {
    return (
      <FolderAssetViewer
        token={token}
        assetId={viewingAssetInFolder}
        allowDownload={state.allowDownload}
        branding={state.branding}
        onBack={() => setViewingAssetInFolder(null)}
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
