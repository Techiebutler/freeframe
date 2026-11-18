'use client'

import { authHeaders } from '@/lib/auth-headers'
import { getUsableAccessToken } from '@/lib/auth'

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
  Mic,
  MessageSquare,
  User,
  FileText,
  Image as ImageIcon,
  Video,
  Music,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { GuestCommentInput, IdentityForm, loadIdentity, consumeHostIdentity, type GuestIdentity } from '@/components/review/guest-comment-input'
import { FlowView } from '@/components/review/flow-view'
import { GuestCommentList, type CommentsResponse } from '@/components/share/guest-comments'
import { chainOrder, inferRoles } from '@/components/share/embed-chain'
import { ModuleTabs } from '@/components/share/module-tabs'
import { VideoFrameConstraint } from '@/components/review/video-player'
import { useIsNarrow } from '@/hooks/use-is-narrow'
import { usePhoneView } from '@/hooks/use-phone-view'
import { REVIEW_HLS_CONFIG, pickPlaybackSource, pickReviewLevel } from '@/lib/hls-review'
import { useFirstFrame } from '@/hooks/use-first-frame'
import { withFirstFrameHint } from '@/lib/first-frame'
import { FrameLayer } from '@/components/review/frame-layer'
import { sendToParent, sendAutoreviewEvent, type EmbedMessage } from '@/lib/embed-bridge'
import { approveSharedAsset, guestDictate, shareFeedbackDone, undoApproveSharedAsset, viewerPermission } from '@/lib/share-flow'
import { FolderShareViewer } from '@/components/share/folder-share-viewer'
import type { Asset, SharePermission, ProjectBranding, ShareLinkAppearance, FolderShareAssetItem, FolderShareAssetsResponse } from '@/types'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ShareValidateResponse {
  asset?: Asset
  asset_id?: string | null
  folder_id?: string | null
  request_id?: string | null
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
  viewer_is_staff?: boolean
  branding?: ProjectBranding | null
  error?: string
}


// ─── Utility ──────────────────────────────────────────────────────────────────

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

// Build-time flag: NEXT_PUBLIC_SHARE_COMMENTS_COLLAPSED=true starts the share
// view's comment panel closed and only opens it once the asset already has a
// comment on it. Default (unset/false) keeps today's behaviour: the panel
// opens by default on desktop widths, same as before this flag existed.
// See docs/aditor-delivery-first-share.md for why - a client should land on a
// finished delivery, not a review queue asking to be picked apart.
const SHARE_COMMENTS_COLLAPSED = process.env.NEXT_PUBLIC_SHARE_COMMENTS_COLLAPSED === 'true'

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
    Object.assign(headers, authHeaders(accessToken))
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
            className="flex h-11 w-full rounded-md border border-border bg-bg-tertiary px-3 text-base md:text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-border-focus"
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
        className="h-11 md:h-8 text-red-400 border-red-500/30 hover:border-red-500/60 hover:bg-red-500/10"
      >
        <XCircle className="h-4 w-4" />
        Reject
      </Button>
      <Button
        variant="primary"
        size="sm"
        onClick={() => handleDecision('approved')}
        loading={loading}
        className="h-11 md:h-8 bg-green-600 hover:bg-green-700"
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
  phoneView?: boolean
  onTogglePhoneView?: () => void
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
  phoneView,
  onTogglePhoneView,
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
            aria-label="Back"
            className="flex items-center justify-center h-11 w-11 md:h-7 md:w-7 rounded-md text-zinc-400 hover:text-white hover:bg-white/10 transition-colors shrink-0"
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
            className="inline-flex h-11 md:h-auto shrink-0 items-center gap-1.5 rounded-md bg-purple-600 hover:bg-purple-700 px-3 md:py-1.5 text-xs font-medium text-white transition-colors disabled:opacity-60"
          >
            {downloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            Download
          </button>
        )}

        {onTogglePhoneView && (
          <button
            onClick={onTogglePhoneView}
            aria-pressed={!!phoneView}
            className={cn(
              'hidden md:inline-flex h-11 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors',
              phoneView ? 'bg-white/10 text-white' : 'text-zinc-400 hover:text-white hover:bg-white/10',
            )}
          >
            <Mic className="h-3.5 w-3.5" aria-hidden="true" />
            Talk + Draw
          </button>
        )}

        <button
          onClick={onToggleSidebar}
          className={cn(
            'flex items-center justify-center h-11 w-11 md:h-8 md:w-8 rounded-md transition-colors',
            sidebarOpen
              ? 'bg-white/10 text-white'
              : 'text-zinc-500 hover:text-white hover:bg-white/10',
          )}
          title={sidebarOpen ? 'Hide comments' : 'Show comments'}
          aria-label={sidebarOpen ? 'Hide comments' : 'Show comments'}
          aria-expanded={sidebarOpen}
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
  /** 540p review proxy MP4 (when the version has one): the video starts here. */
  proxyUrl?: string | null
  /** Flow view: the page needs the video element, and mounts the ink layer inside the picture. */
  videoRef?: React.RefObject<HTMLVideoElement>
  overlay?: React.ReactNode
  /** Embed player: no native controls, the embed draws its own bar (components/review/embed-bar.tsx). */
  bare?: boolean
  /** Poster for the first frame (stream API thumbnail_url); without one the video paints its own first frame. */
  poster?: string | null
}

function ShareMediaViewer({ asset, token, streamUrl, streamLoading, proxyUrl, poster, videoRef: externalVideoRef, overlay, bare }: ShareMediaViewerProps) {
  const ownVideoRef = React.useRef<HTMLVideoElement>(null)
  const videoRef = externalVideoRef ?? ownVideoRef
  const audioRef = React.useRef<HTMLAudioElement>(null)
  const [fatalError, setFatalError] = React.useState<string | null>(null)
  const [proxyBroken, setProxyBroken] = React.useState(false)
  const source = streamUrl && asset.asset_type === 'video' ? pickPlaybackSource(streamUrl, proxyBroken ? null : proxyUrl) : null
  const preparing = source?.kind === 'original'
  // Frame 0 (or the last painted frame) stays over the video until the source has a decoded frame, then crossfades away.
  const { covered, image } = useFirstFrame(videoRef, asset.asset_type === 'video' && streamUrl && !streamLoading && !fatalError ? (source?.url ?? null) : null, poster ?? asset.thumbnail_url)

  React.useEffect(() => {
    if (!streamUrl || streamLoading) return

    setFatalError(null)
    const mediaEl = asset.asset_type === 'video' ? videoRef.current : audioRef.current
    if (!mediaEl) return

    const isProxy = source?.kind === 'proxy'
    const isHls = !isProxy && streamUrl.includes('.m3u8')

    // Resolve relative stream URLs against API_URL (backend returns /stream/hls/master.m3u8?token=...)
    const resolvedUrl = isProxy
      ? source!.url
      : streamUrl.startsWith('/')
        ? `${API_URL}${streamUrl}`
        : streamUrl

    let hls: any = null
    let cancelled = false
    let onFullscreen: (() => void) | null = null

    function setupHls() {
      import('hls.js').then(({ default: Hls }) => {
        if (cancelled) return

        if (isHls && Hls.isSupported()) {
          hls = new Hls(REVIEW_HLS_CONFIG)
          hls.loadSource(resolvedUrl)
          hls.attachMedia(mediaEl!)
          // Start on the 540p rung and cap there; fullscreen lifts the cap.
          let reviewLevel = -1
          hls.on(Hls.Events.MANIFEST_PARSED, (_e: any, data: any) => {
            reviewLevel = pickReviewLevel(data.levels)
            if (reviewLevel < 0) return
            hls.startLevel = reviewLevel
            hls.currentLevel = reviewLevel
            hls.autoLevelCapping = reviewLevel
            hls.nextLevel = -1
          })
          onFullscreen = () => {
            if (hls && reviewLevel >= 0) hls.autoLevelCapping = document.fullscreenElement ? -1 : reviewLevel
          }
          document.addEventListener('fullscreenchange', onFullscreen)

          hls.on(Hls.Events.ERROR, (_event: any, data: any) => {
            if (data.fatal) {
              setFatalError(
                data.type === Hls.ErrorTypes.NETWORK_ERROR
                  ? 'Network error loading video'
                  : data.type === Hls.ErrorTypes.MEDIA_ERROR
                    ? 'Media decode error'
                    : `Playback error: ${data.details || data.type}`
              )
              if (hls) {
                hls.destroy()
                hls = null
              }
            }
          })
        } else if (mediaEl!.canPlayType && mediaEl!.canPlayType('application/vnd.apple.mpegurl')) {
          // Safari native HLS
          mediaEl!.src = resolvedUrl
        } else {
          // Browser supports neither MSE (hls.js) nor native HLS playback
          setFatalError('HLS playback is not supported in this browser')
        }
      })
      .catch(() => {
        if (!cancelled) setFatalError('Failed to load video player')
      })
    }

    if (isHls) {
      setupHls()
    } else if (mediaEl) {
      // crossOrigin keeps drawn-frame (canvas capture) working on the cross-origin proxy file.
      if (isProxy) (mediaEl as HTMLVideoElement).crossOrigin = 'anonymous'
      mediaEl.src = isProxy ? withFirstFrameHint(resolvedUrl) : resolvedUrl
    }

    function handleMediaError() {
      // A broken proxy file must never block review: fall back to the HLS ladder.
      if (isProxy) {
        setProxyBroken(true)
        return
      }
      // Tear down hls.js (if it's driving playback) so it doesn't keep fetching
      // segments into the now-detached element once the error UI replaces it.
      if (hls) {
        hls.destroy()
        hls = null
      }
      setFatalError('Media playback failed')
    }
    mediaEl.addEventListener('error', handleMediaError)

    return () => {
      cancelled = true
      mediaEl.removeEventListener('error', handleMediaError)
      if (onFullscreen) document.removeEventListener('fullscreenchange', onFullscreen)
      if (isProxy) { mediaEl.removeAttribute('src'); mediaEl.load() }
      if (hls) {
        hls.destroy()
      }
    }
  }, [streamUrl, streamLoading, asset.asset_type, source?.url, source?.kind])

  return (
    <div className="relative flex-1 flex items-center justify-center bg-[var(--bg-primary)] min-h-0 overflow-hidden">
      {preparing && (
        <p className="pointer-events-none absolute left-3 top-3 z-10 rounded-full bg-black/60 px-3 py-1 text-xs text-zinc-300">
          Preparing faster playback…
        </p>
      )}
      {asset.asset_type === 'video' && (
        <div className="relative w-full h-full flex items-center justify-center">
          {streamLoading ? (
            image ? <FrameLayer covered image={image} /> : <Loader2 className="h-8 w-8 animate-spin text-zinc-500" />
          ) : fatalError ? (
            <div className="flex flex-col items-center gap-2">
              <AlertTriangle className="h-10 w-10 text-red-500" />
              <p className="text-sm text-red-400">{fatalError}</p>
            </div>
          ) : streamUrl ? (
            overlay ? (
              <div className="relative h-full w-full">
                <video ref={videoRef} controls={!bare} className="absolute inset-0 h-full w-full object-contain" preload="metadata" playsInline>
                  Your browser does not support video playback.
                </video>
                <FrameLayer covered={covered} image={image} />
                <VideoFrameConstraint videoRef={videoRef}>{overlay}</VideoFrameConstraint>
              </div>
            ) : (
            <>
              <video
                ref={videoRef}
                controls
                className="max-h-full max-w-full"
                preload="metadata"
                playsInline
              >
                Your browser does not support video playback.
              </video>
              <FrameLayer covered={covered} image={image} />
            </>
            )
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
          ) : fatalError ? (
            <div className="flex flex-col items-center gap-2">
              <AlertTriangle className="h-10 w-10 text-red-500" />
              <p className="text-sm text-red-400">{fatalError}</p>
            </div>
          ) : streamUrl ? (
            <div className="space-y-6">
              <div className="flex flex-col items-center gap-3">
                <div className="h-24 w-24 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center">
                  <Music className="h-10 w-10 text-zinc-500" />
                </div>
                <p className="text-sm font-medium text-zinc-300">{asset.name}</p>
              </div>
              <audio ref={audioRef} controls className="w-full">
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
    <div className="w-full md:w-[360px] h-[48%] md:h-auto min-h-0 flex flex-col border-t md:border-t-0 md:border-l border-white/[0.06] bg-[#141416] shrink-0 max-md:[&_textarea]:text-base">
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
  /** ?embed=1: video-only page inside the Desk's iframe, reports to the parent window. */
  embed?: boolean
  /** The upload request behind this share link; the embed names it in its hand-off events. */
  requestId?: string | null
  /** Folder embed: this asset's place in the folder, the stepper, and what the approve acts on. */
  folder?: { index: number; count: number; approved: boolean; shareSession: string | null; onStep: (d: -1 | 1) => void; onApproved: (v: boolean) => void; /** Parts approved so far, and the comments no Send has closed yet (all parts). */ approvedCount?: number; partsTotal?: number; onParts?: (p: { approved: number; total: number }) => void; unsent?: number; onNoteSaved?: () => void; onSentAll?: () => void; /** The segmented file switcher (components/share/module-tabs.tsx). */ nav?: React.ReactNode }
}

function ShareViewer({
  token,
  asset,
  permission,
  allowDownload,
  branding,
  shareName,
  onBack,
  embed,
  requestId,
  folder,
}: ShareViewerProps) {
  const [streamUrl, setStreamUrl] = React.useState<string | null>(asset.stream_url ?? null)
  const [streamLoading, setStreamLoading] = React.useState(false)
  const [proxyUrl, setProxyUrl] = React.useState<string | null>(null)
  const [poster, setPoster] = React.useState<string | null>(null)
  const [commentKey, setCommentKey] = React.useState(0)
  const [commentTimes, setCommentTimes] = React.useState<number[]>([])
  const [selectedComment, setSelectedComment] = React.useState<string | null>(null)
  const isNarrow = useIsNarrow()
  const [phoneView, setPhoneView] = usePhoneView()
  const videoRef = React.useRef<HTMLVideoElement>(null)
  const [identity, setIdentity] = React.useState<GuestIdentity | null>(null)
  const [askIdentity, setAskIdentity] = React.useState(false)
  const [flowApproved, setFlowApproved] = React.useState(!!folder?.approved)
  React.useEffect(() => { setIdentity(consumeHostIdentity() ?? loadIdentity()) }, [])
  const [sidebarOpen, setSidebarOpen] = React.useState(() => {
    if (SHARE_COMMENTS_COLLAPSED) return false
    return typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches
  })

  // Flag on: the panel starts closed (see SHARE_COMMENTS_COLLAPSED above) and
  // only reveals itself once we learn the asset already has a comment. This
  // fetch is skipped entirely when the flag is off, so it costs nothing
  // unless an instance has opted in.
  React.useEffect(() => {
    if (!SHARE_COMMENTS_COLLAPSED) return
    let cancelled = false
    fetch(`${API_URL}/share/${token}/comments`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data: CommentsResponse) => {
        if (!cancelled && Array.isArray(data) && data.length > 0) setSidebarOpen(true)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [token, asset.id])

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
        setProxyUrl(data?.proxy_url ?? null)
        setPoster(data?.thumbnail_url ?? null)
      })
      .catch(() => null)
      .finally(() => setStreamLoading(false))
  }, [token, asset.asset_type, asset.stream_url, asset.id])

  const displayName = shareName || branding?.custom_title || 'FreeFrame'

  const canComment = permission === 'comment' || permission === 'approve'
  const flow = (embed || isNarrow || phoneView) && asset.asset_type === 'video'
  const flowVideo = () => videoRef.current
  const send = (m: EmbedMessage) => sendToParent({ ...m, asset_id: asset.id })
  const handoff = (event: 'round_sent' | 'approved') => { if (requestId) sendAutoreviewEvent({ event, request_id: requestId, asset_id: asset.id }) }
  const flowApprove = async () => {
    const made = await approveSharedAsset(token, asset.id, { shareSession: folder?.shareSession, headers: authHeaders(await getUsableAccessToken()), onParts: folder?.onParts })
    setFlowApproved(true)
    folder?.onApproved(true)
    // The request is approved only when every part is: until the server hands back the delivery, nothing leaves the embed.
    if (embed && made) { send({ type: 'ar:approved' }); handoff('approved') }
    return made
  }

  // Embed: tell the parent what the video does. The element mounts after the stream URL arrives, so rebind then.
  React.useEffect(() => {
    const v = videoRef.current
    if (!embed || !v) return
    const ready = () => { if (v.videoWidth) send({ type: 'ar:ready', width: v.videoWidth, height: v.videoHeight, duration: v.duration, ...(folder && { index: folder.index + 1, count: folder.count }) }) }
    const on = (type: 'ar:play' | 'ar:pause' | 'ar:ended') => () => send({ type })
    const handlers: [string, () => void][] = [['loadedmetadata', ready], ['play', on('ar:play')], ['pause', on('ar:pause')], ['ended', on('ar:ended')]]
    handlers.forEach(([e, h]) => v.addEventListener(e, h))
    ready()
    return () => handlers.forEach(([e, h]) => v.removeEventListener(e, h))
  }, [embed, streamUrl, streamLoading])

  if (flow && embed) {
    return (
      <div className="absolute inset-0 overflow-hidden bg-[var(--bg-primary)] text-white">
        <FlowView
          embed
          embedNav={folder && folder.count > 1 ? folder.nav : undefined}
          embedComments={(show) => (
            <GuestCommentList token={token} refreshKey={commentKey} assetId={folder ? asset.id : undefined}
              onLoaded={(list) => setCommentTimes(list.map((c) => c.timecode_start).filter((t): t is number => typeof t === 'number'))}
              selectedId={selectedComment}
              onSelect={(c) => { setSelectedComment(c.id); show(c.timecode_start ?? 0, c.annotation?.drawing_data) }} />
          )}
          embedMarkers={commentTimes}
          renderMedia={(ink) => (
            <ShareMediaViewer asset={asset} token={token} streamUrl={streamUrl} streamLoading={streamLoading} proxyUrl={proxyUrl} poster={poster} videoRef={videoRef} overlay={ink} bare />
          )}
          files={[{ id: asset.id, name: asset.name }]}
          currentFileId={asset.id}
          onSelectFile={() => {}}
          getPlayhead={() => flowVideo()?.currentTime ?? 0}
          onPause={() => flowVideo()?.pause()}
          onSeek={(t) => { const v = flowVideo(); if (v) { v.currentTime = t; v.pause() } }}
          canComment={canComment}
          canApprove={permission === 'approve'}
          notePayload={(n) => ({ kind: 'share', token, assetId: asset.id, identity, ...n })}
          canSave={!!identity}
          onNeedSave={() => setAskIdentity(true)}
          onApprove={flowApprove}
          onSent={() => { shareFeedbackDone(token, asset.id); send({ type: 'ar:sent' }); handoff('round_sent'); folder?.onSentAll?.() }}
          onNoteSaved={(t) => { send({ type: 'ar:comment', t }); setCommentKey((k) => k + 1); folder?.onNoteSaved?.() }}
          onUndoApprove={async () => { await undoApproveSharedAsset(token, asset.id, { shareSession: folder?.shareSession }); setFlowApproved(false); folder?.onApproved(false) }}
          sessionKey={token}
          approved={flowApproved}
          parts={folder ? { approved: folder.approvedCount ?? 0, total: folder.partsTotal ?? folder.count } : undefined}
          unsentFeedback={folder?.unsent}
          hasNext={!!folder && folder.index < folder.count - 1}
          onNext={() => folder?.onStep(1)}
          dictate={(audio) => guestDictate(token, audio)}
        />
        {askIdentity && (
          <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center">
            <div className="w-full max-w-sm overflow-hidden rounded-t-2xl bg-bg-primary sm:rounded-2xl" role="dialog" aria-label="Who are you?">
              <IdentityForm onIdentified={(id) => { setIdentity(id); setAskIdentity(false) }} />
              <p className="px-4 pb-4 text-xs text-text-tertiary">Your notes are kept and saved as soon as you continue.</p>
            </div>
          </div>
        )}
      </div>
    )
  }

  if (flow) {
    return (
      <div className="absolute inset-0 flex flex-col bg-zinc-950 text-white overflow-hidden">
        {!isNarrow && (
          <ShareTopBar
            shareName={displayName} assetName={asset.name} allowDownload={allowDownload} downloadUrl={streamUrl}
            token={token} assetId={asset.id} sidebarOpen={false} onToggleSidebar={() => setPhoneView(false)}
            onBack={onBack} branding={branding} phoneView onTogglePhoneView={() => setPhoneView(false)}
          />
        )}
        <div className="flex min-h-0 flex-1 justify-center">
          <div className={isNarrow ? 'h-full w-full max-w-[430px] md:border-x md:border-white/[0.06]' : 'h-full w-full'}>
            <FlowView
              renderMedia={(ink) => (
                <ShareMediaViewer asset={asset} token={token} streamUrl={streamUrl} streamLoading={streamLoading} proxyUrl={proxyUrl} poster={poster} videoRef={videoRef} overlay={ink} />
              )}
              files={[{ id: asset.id, name: asset.name }]}
              currentFileId={asset.id}
              onSelectFile={() => {}}
              getPlayhead={() => flowVideo()?.currentTime ?? 0}
              onPause={() => flowVideo()?.pause()}
              onSeek={(t) => { const v = flowVideo(); if (v) { v.currentTime = t; v.pause() } }}
              canComment={canComment}
              canApprove={permission === 'approve'}
              notePayload={(n) => ({ kind: 'share', token, assetId: asset.id, identity, ...n })}
              canSave={!!identity}
              onNeedSave={() => setAskIdentity(true)}
              onApprove={flowApprove}
              onSent={() => shareFeedbackDone(token, asset.id)}
              onUndoApprove={async () => { await undoApproveSharedAsset(token, asset.id); setFlowApproved(false) }}
              sessionKey={token}
              approved={flowApproved}
              dictate={(audio) => guestDictate(token, audio)}
              onExit={isNarrow ? undefined : () => setPhoneView(false)}
              exitLabel="Classic comments"
              wide={!isNarrow}
            />
          </div>
        </div>
        {askIdentity && (
          <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center">
            <div className="w-full max-w-sm overflow-hidden rounded-t-2xl bg-bg-primary sm:rounded-2xl" role="dialog" aria-label="Who are you?">
              <IdentityForm onIdentified={(id) => { setIdentity(id); setAskIdentity(false) }} />
              <p className="px-4 pb-4 text-xs text-text-tertiary">Your notes are kept and saved as soon as you continue.</p>
            </div>
          </div>
        )}
      </div>
    )
  }

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
        phoneView={false}
        onTogglePhoneView={asset.asset_type === 'video' ? () => setPhoneView(true) : undefined}
      />

      {/* Main content: viewer + sidebar */}
      <div className="relative flex flex-col md:flex-row flex-1 overflow-hidden min-h-0">
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



// ─── Page ─────────────────────────────────────────────────────────────────────

/** ?embed=1 on a folder share: the video-only embed over the folder's videos, newest first, starting at the first not yet approved. */
function FolderEmbed({ token, shareSession, permission, branding, requestId }: { token: string; shareSession: string | null; permission: SharePermission; branding: ProjectBranding | null; requestId: string | null }) {
  const [items, setItems] = React.useState<FolderShareAssetItem[] | null>(null)
  const [index, setIndex] = React.useState(0)
  const [unsent, setUnsent] = React.useState(0)
  // The request's own count of parts (every asset in the folder, whatever its type), then the server's answer after each approve.
  const [parts, setParts] = React.useState<{ approved: number; total: number } | null>(null)
  React.useEffect(() => {
    const ss = shareSession ? `&share_session=${encodeURIComponent(shareSession)}` : ''
    fetch(`${API_URL}/share/${token}/assets?page=1&per_page=500&embed=true${ss}`)
      .then((r) => (r.ok ? (r.json() as Promise<FolderShareAssetsResponse>) : null))
      .then((data) => {
        const videos = inferRoles((data?.assets ?? []).filter((a) => a.asset_type === 'video'))
        const sorted = chainOrder(videos) ?? videos
        const all = data?.assets ?? []
        setParts({ approved: all.filter((a) => a.approved).length, total: all.length })
        setItems(sorted)
        setIndex(Math.max(0, sorted.findIndex((a) => !a.approved)))
        setUnsent(sorted.reduce((n, a) => n + (a.comment_count || 0), 0))
      })
      .catch(() => setItems([]))
  }, [token, shareSession])
  if (!items) return <div className="flex min-h-screen items-center justify-center bg-black"><Loader2 className="h-8 w-8 animate-spin text-zinc-500" /></div>
  const current = items[index]
  if (!current) return <ErrorState />
  const go = (n: number) => {
    if (n === index || n < 0 || n > items.length - 1) return
    setIndex(n)
    sendToParent({ type: 'ar:asset', asset_id: items[n].id, index: n + 1, count: items.length })
  }
  const nav = items.length > 1 && (
    <ModuleTabs items={items.map((a) => ({ id: a.id, name: a.name, role: a.role, order: a.order, count: a.comment_count, approved: !!a.approved }))} selectedId={current.id} onSelect={(id) => go(items.findIndex((a) => a.id === id))} />
  )
  return (
    <ShareViewer
      key={current.id}
      embed
      requestId={requestId}
      token={token}
      asset={{ id: current.id, name: current.name, asset_type: current.asset_type, thumbnail_url: current.thumbnail_url ?? undefined } as unknown as Asset}
      permission={permission}
      allowDownload={false}
      branding={branding}
      folder={{ index, count: items.length, approved: !!current.approved, approvedCount: parts?.approved ?? items.filter((a) => a.approved).length, partsTotal: parts?.total ?? items.length, onParts: setParts, unsent, onNoteSaved: () => setUnsent((n) => n + 1), onSentAll: () => setUnsent(0), shareSession, onStep: (d) => go(index + d), nav: nav || undefined,
        onApproved: (v) => { setItems((prev) => prev && prev.map((a) => (a.id === current.id ? { ...a, approved: v } : a))); if (!v) setParts((p) => p && { ...p, approved: Math.max(0, p.approved - 1) }) } }}
    />
  )
}

export default function SharePage({
  params,
}: {
  params: { token: string }
}) {
  const { token } = params
  // Only mounted after the client-side validate() below, so reading the URL here never hits SSR.
  const embed = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('embed') === '1'

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
  const [requestId, setRequestId] = React.useState<string | null>(null)
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
      const permission = viewerPermission(data.permission, data.viewer_is_staff)

      // Store share session from password-protected link validation
      setRequestId(data.request_id ?? null)
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
          permission,
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
        permission,
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
    if (embed) return <FolderEmbed requestId={requestId} token={token} shareSession={shareSession} permission={state.permission} branding={state.branding} />
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
      embed={embed}
      requestId={requestId}
    />
  )
}
