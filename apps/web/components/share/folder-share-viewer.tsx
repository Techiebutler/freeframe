'use client'

import * as React from 'react'
import {
  Folder,
  File,
  Download,
  Search,
  ChevronRight,
  ChevronDown,
  Image as ImageIcon,
  Video,
  Music,
  Loader2,
  MessageSquare,
  PanelRightClose,
  PanelRightOpen,
  ArrowLeft,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type {
  SharePermission,
  ShareLinkAppearance,
  FolderShareAssetsResponse,
  FolderShareAssetItem,
  FolderShareSubfolder,
} from '@/types'

// ─── Constants ────────────────────────────────────────────────────────────────

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

// ─── Types ────────────────────────────────────────────────────────────────────

interface FolderShareViewerProps {
  token: string
  folderName: string
  title: string
  description: string | null
  createdByName?: string | null
  viewerName?: string | null
  permission: SharePermission
  allowDownload: boolean
  showVersions: boolean
  appearance: ShareLinkAppearance
  branding: {
    logo_url?: string
    primary_color?: string
    custom_title?: string
    custom_footer?: string
  } | null
  onAssetClick?: (assetId: string) => void
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatFileSize(bytes: number | null): string {
  if (bytes == null) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function formatShortDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function getAssetTypeIcon(assetType: string): React.ElementType {
  switch (assetType) {
    case 'video': return Video
    case 'audio': return Music
    case 'image':
    case 'image_carousel': return ImageIcon
    default: return File
  }
}

function getAssetTypeBadgeLabel(assetType: string): string {
  switch (assetType) {
    case 'image_carousel': return 'Carousel'
    default: return assetType.charAt(0).toUpperCase() + assetType.slice(1)
  }
}

// ─── Download handler ─────────────────────────────────────────────────────────

async function handleDownload(token: string, assetId: string, assetName: string) {
  try {
    const response = await fetch(`${API_URL}/share/${token}/stream/${assetId}`)
    if (!response.ok) return
    const data = await response.json()
    if (data?.url) {
      const a = document.createElement('a')
      a.href = data.url
      a.download = assetName
      a.rel = 'noopener noreferrer'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    }
  } catch {
    // silently fail
  }
}

// ─── Subfolder Card ───────────────────────────────────────────────────────────

interface SubfolderCardProps {
  subfolder: FolderShareSubfolder
  onClick: (subfolder: FolderShareSubfolder) => void
}

function SubfolderCard({ subfolder, onClick }: SubfolderCardProps) {
  const thumbs = subfolder.thumbnail_urls ?? []

  return (
    <button
      className="group flex flex-col rounded-lg border border-border bg-bg-tertiary overflow-hidden text-left transition-all cursor-pointer hover:border-border-focus hover:bg-bg-hover"
      onClick={() => onClick(subfolder)}
    >
      {/* Thumbnail area */}
      <div className="w-full aspect-[16/10] relative overflow-hidden bg-bg-tertiary">
        {thumbs.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <Folder className="h-10 w-10 text-text-tertiary" />
          </div>
        ) : thumbs.length === 1 ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={thumbs[0]}
            alt={subfolder.name}
            className="absolute inset-0 h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
          />
        ) : (
          <div className={cn(
            'absolute inset-0 grid gap-[1px]',
            thumbs.length === 2 && 'grid-cols-2',
            thumbs.length >= 3 && 'grid-cols-2 grid-rows-2',
          )}>
            {thumbs.slice(0, 4).map((url, i) => (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                key={i}
                src={url}
                alt=""
                className={cn(
                  'h-full w-full object-cover',
                  thumbs.length === 3 && i === 0 && 'row-span-2',
                )}
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
              />
            ))}
          </div>
        )}
      </div>

      {/* Info */}
      <div className="px-3 py-2.5">
        <p className="text-sm font-medium text-text-primary truncate">{subfolder.name}</p>
        <p className="text-xs text-text-tertiary mt-0.5">
          {subfolder.item_count} {subfolder.item_count === 1 ? 'Item' : 'Items'}
        </p>
      </div>
    </button>
  )
}

// ─── Asset Grid Card (Frame.io style) ────────────────────────────────────────

interface AssetGridCardProps {
  asset: FolderShareAssetItem
  allowDownload: boolean
  token: string
  isSelected: boolean
  onSelect: (asset: FolderShareAssetItem) => void
  onOpen: (asset: FolderShareAssetItem) => void
  aspectClass?: string
  thumbnailScale?: 'fit' | 'fill'
  showCardInfo?: boolean
}

function AssetGridCard({ asset, allowDownload, token, isSelected, onSelect, onOpen, aspectClass = 'aspect-[16/10]', thumbnailScale = 'fill', showCardInfo = true }: AssetGridCardProps) {
  const TypeIcon = getAssetTypeIcon(asset.asset_type)

  return (
    <div
      className={cn(
        'group flex flex-col rounded-lg border overflow-hidden transition-all cursor-pointer',
        isSelected
          ? 'border-accent/60 ring-1 ring-accent/40'
          : 'border-border hover:border-border-focus',
        'bg-bg-tertiary hover:bg-bg-hover',
      )}
      onClick={() => onSelect(asset)}
      onDoubleClick={() => onOpen(asset)}
    >
      {/* Thumbnail */}
      <div className={cn('w-full relative overflow-hidden bg-bg-tertiary', aspectClass)}>
        {asset.thumbnail_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={asset.thumbnail_url}
            alt={asset.name}
            className={cn('h-full w-full transition-transform duration-200 group-hover:scale-[1.02]', thumbnailScale === 'fill' ? 'object-cover' : 'object-contain')}
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <TypeIcon className="h-10 w-10 text-text-tertiary" />
          </div>
        )}

        {/* Comment count badge — bottom left */}
        {asset.comment_count > 0 && (
          <div className="absolute bottom-2 left-2 flex items-center gap-1 bg-bg-primary/80 backdrop-blur-sm rounded-md px-1.5 py-0.5">
            <MessageSquare className="h-3 w-3 text-text-primary" />
            <span className="text-[10px] font-medium text-text-primary">{asset.comment_count}</span>
          </div>
        )}

        {/* Duration badge — bottom right (video/audio) */}
        {asset.duration_seconds != null && asset.duration_seconds > 0 && (
          <div className="absolute bottom-2 right-2 bg-bg-primary/80 backdrop-blur-sm rounded-md px-1.5 py-0.5">
            <span className="text-[10px] font-medium text-text-primary tabular-nums">
              {formatDuration(asset.duration_seconds)}
            </span>
          </div>
        )}

        {/* Download button overlay */}
        {allowDownload && (
          <button
            className="absolute top-2 right-2 flex items-center justify-center h-6 w-6 rounded-md bg-bg-primary/70 hover:bg-bg-primary/90 text-text-primary backdrop-blur-sm opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={(e) => {
              e.stopPropagation()
              handleDownload(token, asset.id, asset.name)
            }}
            title="Download"
          >
            <Download className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* Info — name, author, date */}
      {showCardInfo && (
        <div className="px-3 py-2.5">
          <p className="text-sm font-medium text-text-primary line-clamp-1">{asset.name}</p>
          <p className="text-xs text-text-tertiary mt-0.5 truncate">
            {asset.created_by_name && <>{asset.created_by_name} &middot; </>}
            {formatShortDate(asset.created_at)}
            {asset.file_size != null && <> &middot; {formatFileSize(asset.file_size)}</>}
          </p>
        </div>
      )}
    </div>
  )
}

// ─── Section Header ──────────────────────────────────────────────────────────

interface SectionHeaderProps {
  label: string
  count: number
  totalSize: string | null
  expanded: boolean
  onToggle: () => void
}

function SectionHeader({ label, count, totalSize, expanded, onToggle }: SectionHeaderProps) {
  return (
    <button className="flex items-center gap-2 py-2 w-full text-left group" onClick={onToggle}>
      <ChevronDown
        className={cn('h-4 w-4 shrink-0 transition-transform text-text-tertiary', !expanded && '-rotate-90')}
      />
      <span className="text-xs font-semibold uppercase tracking-wider text-text-secondary">
        {count} {label}
      </span>
      {totalSize && (
        <span className="text-xs text-text-tertiary">&middot; {totalSize}</span>
      )}
    </button>
  )
}

// ─── Right Panel: Asset Details + Comments ───────────────────────────────────

interface RightPanelProps {
  selectedAsset: FolderShareAssetItem | null
  token: string
  permission: SharePermission
  allowDownload: boolean
  onOpenAsset?: (asset: FolderShareAssetItem) => void
}

interface GuestComment {
  id: string
  body: string
  guest_name: string
  guest_email: string
  author_name?: string
  created_at: string
  timecode_start?: number | null
  replies?: GuestComment[]
}

function RightPanel({ selectedAsset, token, permission, allowDownload, onOpenAsset }: RightPanelProps) {
  const [comments, setComments] = React.useState<GuestComment[]>([])
  const [loadingComments, setLoadingComments] = React.useState(false)
  const [commentRefresh, setCommentRefresh] = React.useState(0)
  const canComment = permission === 'comment' || permission === 'approve'

  React.useEffect(() => {
    if (!selectedAsset) {
      setComments([])
      return
    }
    setLoadingComments(true)
    fetch(`${API_URL}/share/${token}/comments?asset_id=${selectedAsset.id}`)
      .then((r) => (r.ok ? r.json() : Promise.resolve([])))
      .then((data) => setComments(Array.isArray(data) ? data : (data.comments ?? [])))
      .catch(() => setComments([]))
      .finally(() => setLoadingComments(false))
  }, [selectedAsset?.id, token, commentRefresh])

  if (!selectedAsset) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
        <div className="h-14 w-14 rounded-full bg-bg-tertiary flex items-center justify-center mb-3">
          <MessageSquare className="h-7 w-7 text-text-tertiary" />
        </div>
        <p className="text-sm font-medium text-text-primary">Select an asset to view comments</p>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Asset name header — minimal */}
      <div className="px-4 py-3 border-b border-border shrink-0">
        <h3 className="text-sm font-semibold text-text-primary truncate">{selectedAsset.name}</h3>
      </div>

      {/* Comments section */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <h4 className="text-xs font-semibold text-text-tertiary uppercase tracking-wider">
            Comments ({comments.length})
          </h4>
        </div>
        <ShareCommentList comments={comments} loading={loadingComments} canComment={canComment} />
      </div>

      {/* Comment input — only in asset viewer, not in folder preview */}
    </div>
  )
}

// ─── Share Comment List (matches project review panel style) ─────────────────

const AVATAR_COLORS = [
  'bg-purple-500', 'bg-blue-500', 'bg-green-500', 'bg-orange-500',
  'bg-pink-500', 'bg-cyan-500', 'bg-indigo-500', 'bg-rose-500',
]

function getAvatarColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash)
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
}

interface ShareCommentListProps {
  comments: GuestComment[]
  loading: boolean
  canComment: boolean
  onReply?: (commentId: string) => void
}

function ShareCommentList({ comments, loading, canComment, onReply }: ShareCommentListProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-text-tertiary" />
      </div>
    )
  }

  if (comments.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 px-6 text-center">
        <MessageSquare className="h-8 w-8 text-text-tertiary mb-2" />
        <p className="text-sm font-medium text-text-primary">No comments yet</p>
        {canComment && <p className="text-xs text-text-tertiary mt-1">Be the first to leave feedback</p>}
      </div>
    )
  }

  return (
    <div className="px-4 py-3 space-y-1">
      {comments.map((comment, i) => {
        const name = comment.guest_name || comment.author_name || 'User'
        const color = getAvatarColor(name)
        return (
          <div key={comment.id} className="py-3 border-b border-border last:border-0">
            {/* Comment header */}
            <div className="flex items-start gap-3">
              <div className={cn('h-8 w-8 rounded-full flex items-center justify-center text-xs font-bold text-text-primary shrink-0', color)}>
                {name.charAt(0).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-text-primary">{name}</span>
                  <span className="text-2xs text-text-tertiary">{formatShortDate(comment.created_at)}</span>
                  <span className="ml-auto text-2xs text-text-tertiary">#{i + 1}</span>
                </div>
                <p className="text-sm text-text-secondary mt-1 leading-relaxed">{comment.body}</p>
                {comment.timecode_start != null && (
                  <span className="inline-flex items-center gap-1 mt-1 text-[10px] text-accent font-mono bg-accent/10 px-1.5 py-0.5 rounded">
                    {Math.floor(comment.timecode_start / 60)}:{String(Math.floor(comment.timecode_start % 60)).padStart(2, '0')}
                  </span>
                )}
                {canComment && onReply && (
                  <button onClick={() => onReply(comment.id)} className="block mt-1.5 text-xs text-text-tertiary hover:text-text-primary transition-colors">
                    Reply
                  </button>
                )}
              </div>
            </div>

            {/* Nested replies */}
            {comment.replies && comment.replies.length > 0 && (
              <div className="ml-11 mt-2 space-y-2 border-l-2 border-border pl-3">
                {comment.replies.map((r) => {
                  const rName = r.guest_name || r.author_name || 'User'
                  const rColor = getAvatarColor(rName)
                  return (
                    <div key={r.id} className="flex items-start gap-2.5 py-1">
                      <div className={cn('h-6 w-6 rounded-full flex items-center justify-center text-[10px] font-bold text-text-primary shrink-0', rColor)}>
                        {rName.charAt(0).toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium text-text-primary">{rName}</span>
                          <span className="text-2xs text-text-tertiary">{formatShortDate(r.created_at)}</span>
                        </div>
                        <p className="text-xs text-text-secondary mt-0.5">{r.body}</p>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ─── Share Comment Input ─────────────────────────────────────────────────────

interface ShareCommentInputProps {
  token: string
  assetId: string
  onCommentPosted: () => void
}

function ShareCommentInput({ token, assetId, onCommentPosted }: ShareCommentInputProps) {
  const [body, setBody] = React.useState('')
  const [guestName, setGuestName] = React.useState('')
  const [guestEmail, setGuestEmail] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // Check if user is logged in
  const isLoggedIn = typeof window !== 'undefined' && !!localStorage.getItem('ff_access_token')

  async function handleSubmit() {
    if (!body.trim()) return
    if (!isLoggedIn && (!guestName.trim() || !guestEmail.trim())) {
      setError('Please enter your name and email')
      return
    }

    setSubmitting(true)
    setError(null)
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      const accessToken = localStorage.getItem('ff_access_token')
      if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`

      const payload: Record<string, unknown> = { body: body.trim(), asset_id: assetId }
      if (!isLoggedIn) {
        payload.guest_name = guestName.trim()
        payload.guest_email = guestEmail.trim()
      }

      const res = await fetch(`${API_URL}/share/${token}/comment`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.detail || 'Failed to post comment')
      }
      setBody('')
      onCommentPosted()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to post')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="border-t border-border p-3 shrink-0 space-y-2">
      {!isLoggedIn && (
        <div className="flex gap-2">
          <input
            type="text"
            value={guestName}
            onChange={(e) => setGuestName(e.target.value)}
            placeholder="Your name"
            className="flex-1 h-8 rounded-md border border-border bg-bg-hover px-2.5 text-xs text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent/50"
          />
          <input
            type="email"
            value={guestEmail}
            onChange={(e) => setGuestEmail(e.target.value)}
            placeholder="Email"
            className="flex-1 h-8 rounded-md border border-border bg-bg-hover px-2.5 text-xs text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent/50"
          />
        </div>
      )}
      <div className="flex gap-2">
        <input
          type="text"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit() } }}
          placeholder="Leave a comment…"
          disabled={submitting}
          className="flex-1 h-8 rounded-md border border-border bg-bg-hover px-2.5 text-sm text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent/50"
        />
        <button
          onClick={handleSubmit}
          disabled={submitting || !body.trim()}
          className="h-8 px-3 rounded-md bg-accent text-text-primary text-xs font-medium hover:bg-accent/90 disabled:opacity-50 transition-colors shrink-0"
        >
          {submitting ? '...' : 'Post'}
        </button>
      </div>
      {error && <p className="text-2xs text-red-400">{error}</p>}
    </div>
  )
}

// ─── Asset Viewer (full-screen media viewer for shared assets) ───────────────

interface AssetViewerProps {
  token: string
  asset: FolderShareAssetItem
  permission: SharePermission
  allowDownload: boolean
  onBack: () => void
}

function HlsVideo({ src, className }: { src: string; className?: string }) {
  const videoRef = React.useRef<HTMLVideoElement>(null)

  React.useEffect(() => {
    const video = videoRef.current
    if (!video || !src) return

    if (src.includes('.m3u8')) {
      // HLS stream — use HLS.js
      import('hls.js').then(({ default: Hls }) => {
        if (Hls.isSupported()) {
          const hls = new Hls()
          hls.loadSource(src)
          hls.attachMedia(video)
          hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}))
          return () => hls.destroy()
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = src
          video.play().catch(() => {})
        }
      })
    } else {
      video.src = src
      video.play().catch(() => {})
    }
  }, [src])

  return <video ref={videoRef} controls className={className} />
}

function AssetViewer({ token, asset, permission, allowDownload, onBack }: AssetViewerProps) {
  // Use the same ReviewProvider as the project review page, but with shareToken
  // This gives us the same video player, image viewer, comment panel, etc.
  return (
    <div className="fixed inset-0 z-50">
      <ShareReviewScreen
        token={token}
        assetId={asset.id}
        assetName={asset.name}
        permission={permission}
        allowDownload={allowDownload}
        onBack={onBack}
      />
    </div>
  )
}

/** Lazy-imported review components to avoid circular deps */
function ShareReviewScreen({
  token, assetId, assetName, permission, allowDownload, onBack,
}: {
  token: string; assetId: string; assetName: string; permission: SharePermission; allowDownload: boolean; onBack: () => void
}) {
  const [ReviewProvider, setProvider] = React.useState<any>(null)
  const [VideoPlayer, setVideoPlayer] = React.useState<any>(null)
  const [ImageViewer, setImageViewer] = React.useState<any>(null)
  const [AudioPlayer, setAudioPlayer] = React.useState<any>(null)
  const [CommentPanel, setCommentPanel] = React.useState<any>(null)
  const [CommentInput, setCommentInput] = React.useState<any>(null)
  const [loaded, setLoaded] = React.useState(false)

  React.useEffect(() => {
    // Dynamic import to avoid SSR issues
    Promise.all([
      import('@/components/review/review-provider'),
      import('@/components/review/video-player'),
      import('@/components/review/image-viewer'),
      import('@/components/review/audio-player'),
      import('@/components/review/comment-panel'),
      import('@/components/review/comment-input'),
    ]).then(([provider, video, image, audio, comments, input]) => {
      setProvider(() => provider.ReviewProvider)
      setVideoPlayer(() => video.VideoPlayer)
      setImageViewer(() => image.ImageViewer)
      setAudioPlayer(() => audio.AudioPlayer)
      setCommentPanel(() => comments.CommentPanel)
      setCommentInput(() => input.CommentInput)
      setLoaded(true)
    })
  }, [])

  if (!loaded || !ReviewProvider) {
    return <div className="flex items-center justify-center h-screen bg-bg-primary"><Loader2 className="h-8 w-8 animate-spin text-text-tertiary" /></div>
  }

  return (
    <ReviewProvider assetId={assetId} shareToken={token}>
      <ShareReviewInner
        token={token}
        assetName={assetName}
        permission={permission}
        allowDownload={allowDownload}
        onBack={onBack}
        VideoPlayer={VideoPlayer}
        ImageViewer={ImageViewer}
        AudioPlayer={AudioPlayer}
        CommentPanel={CommentPanel}
        CommentInput={CommentInput}
      />
    </ReviewProvider>
  )
}

function ShareReviewInner({
  token, assetName, permission, allowDownload, onBack,
  VideoPlayer, ImageViewer, AudioPlayer, CommentPanel, CommentInput,
}: any) {
  // Import hooks from the review system
  const { useReview } = require('@/components/review/review-provider')
  const { useReviewStore } = require('@/stores/review-store')
  const { useComments } = require('@/hooks/use-comments')

  const { asset, versions, isLoading, comments, refetchComments } = useReview()
  const { currentVersion, isDrawingMode } = useReviewStore()
  const [sidebarOpen, setSidebarOpen] = React.useState(true)
  const [activeTab, setActiveTab] = React.useState<'comments' | 'fields'>('comments')

  const canComment = permission === 'comment' || permission === 'approve'
  const versionReady = currentVersion?.processing_status === 'ready'

  if (isLoading || !asset) {
    return <div className="flex items-center justify-center h-screen bg-bg-primary"><Loader2 className="h-8 w-8 animate-spin text-text-tertiary" /></div>
  }

  return (
    <div className="flex flex-col h-screen bg-bg-primary text-text-primary">
      {/* Top bar — same style as project review */}
      <div className="flex items-center justify-between border-b border-border px-3 h-12 bg-bg-secondary shrink-0">
        <div className="flex items-center gap-1 min-w-0 flex-1">
          <button onClick={onBack} className="flex items-center justify-center h-7 w-7 rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors shrink-0">
            <ArrowLeft className="h-4 w-4" />
          </button>
          <span className="text-[13px] font-medium text-text-primary truncate">{assetName}</span>
        </div>
        <div className="flex items-center gap-2">
          {allowDownload && (
            <button className="flex items-center gap-1.5 h-7 px-3 rounded-md text-xs font-medium text-text-inverse bg-accent hover:bg-accent-hover transition-colors" onClick={() => handleDownload(token, asset.id, assetName)}>
              <Download className="h-3 w-3" /> Download
            </button>
          )}
          <button onClick={() => setSidebarOpen(v => !v)} className="flex items-center justify-center h-8 w-8 rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors">
            {sidebarOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {/* Main: viewer + sidebar */}
      <div className="flex flex-1 overflow-hidden min-h-0">
        {/* Media viewer — reuses project components */}
        <div className="flex-1 flex flex-col bg-bg-primary overflow-hidden min-w-0">
          {asset.asset_type === 'video' && versionReady && VideoPlayer ? (
            <VideoPlayer asset={asset} version={currentVersion} comments={comments} className="flex-1" />
          ) : asset.asset_type === 'audio' && versionReady && AudioPlayer ? (
            <AudioPlayer asset={asset} version={currentVersion} comments={comments} className="flex-1" />
          ) : (asset.asset_type === 'image' || asset.asset_type === 'image_carousel') && versionReady && ImageViewer ? (
            <div className="relative flex-1 flex items-center justify-center p-4 overflow-hidden">
              <ImageViewer asset={asset} version={currentVersion} />
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-text-tertiary" />
            </div>
          )}
        </div>

        {/* Right sidebar — reuses project comment panel */}
        {sidebarOpen && (
          <div className="w-[360px] flex flex-col border-l border-border bg-bg-secondary shrink-0">
            <div className="px-4 pt-3 pb-2 shrink-0">
              <div className="flex items-center bg-bg-tertiary rounded-lg p-0.5">
                <button onClick={() => setActiveTab('comments')} className={`flex-1 py-1.5 text-[13px] font-medium rounded-md transition-all ${activeTab === 'comments' ? 'bg-bg-hover text-text-primary shadow-sm' : 'text-text-tertiary'}`}>
                  Comments
                </button>
                <button onClick={() => setActiveTab('fields')} className={`flex-1 py-1.5 text-[13px] font-medium rounded-md transition-all ${activeTab === 'fields' ? 'bg-bg-hover text-text-primary shadow-sm' : 'text-text-tertiary'}`}>
                  Fields
                </button>
              </div>
            </div>

            {activeTab === 'comments' && CommentPanel && (
              <>
                <CommentPanel
                  comments={comments}
                  onResolve={() => {}}
                  onDelete={() => {}}
                  onAddReaction={() => {}}
                  onRemoveReaction={() => {}}
                  onReply={() => {}}
                  onSubmitReply={async () => {}}
                />
                {canComment && CommentInput && (
                  <CommentInput
                    assetId={asset.id}
                    projectId={asset.project_id || ''}
                    assetType={asset.asset_type}
                    onSubmit={async (body: string) => {
                      const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'
                      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
                      try { const t = localStorage.getItem('ff_access_token'); if (t) headers['Authorization'] = `Bearer ${t}` } catch {}
                      await fetch(`${API_URL}/share/${token}/comment`, { method: 'POST', headers, body: JSON.stringify({ body, asset_id: asset.id }) })
                      refetchComments()
                    }}
                  />
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function FolderShareViewer({
  token,
  folderName,
  title,
  description,
  createdByName,
  viewerName,
  permission,
  allowDownload,
  showVersions: _showVersions,
  appearance,
  branding,
  onAssetClick,
}: FolderShareViewerProps) {
  const [currentSubfolderId, setCurrentSubfolderId] = React.useState<string | null>(null)
  const [breadcrumbs, setBreadcrumbs] = React.useState<{ id: string; name: string }[]>([])
  const [searchQuery, setSearchQuery] = React.useState('')
  const [foldersExpanded, setFoldersExpanded] = React.useState(true)
  const [assetsExpanded, setAssetsExpanded] = React.useState(true)
  const [panelOpen, setPanelOpen] = React.useState(true)
  const [viewingAsset, setViewingAsset] = React.useState<FolderShareAssetItem | null>(null)

  // Set page title
  React.useEffect(() => {
    document.title = title ? `${title} – FreeFrame` : 'FreeFrame'
    return () => { document.title = 'FreeFrame' }
  }, [title])
  const [selectedAsset, setSelectedAsset] = React.useState<FolderShareAssetItem | null>(null)

  const [assets, setAssets] = React.useState<FolderShareAssetItem[]>([])
  const [subfolders, setSubfolders] = React.useState<FolderShareSubfolder[]>([])
  const [total, setTotal] = React.useState(0)
  const [page, setPage] = React.useState(1)
  const [loading, setLoading] = React.useState(true)
  const [loadingMore, setLoadingMore] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const accentColor = appearance.accent_color ?? branding?.primary_color ?? '#6366f1'
  const isDark = appearance.theme !== 'light'
  const cardSize = appearance.card_size ?? 'm'
  const aspectRatio = appearance.aspect_ratio ?? 'landscape'
  const thumbnailScale = appearance.thumbnail_scale ?? 'fill'
  const showCardInfo = appearance.show_card_info !== false
  const isGridLayout = appearance.layout !== 'list'
  const perPage = 24

  // Grid column classes based on card_size
  const gridCols = cardSize === 's'
    ? 'grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7'
    : cardSize === 'l'
    ? 'grid-cols-1 sm:grid-cols-2 md:grid-cols-3'
    : 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5'

  // Aspect ratio class
  const aspectClass = aspectRatio === 'square'
    ? 'aspect-square'
    : aspectRatio === 'portrait'
    ? 'aspect-[3/4]'
    : 'aspect-[16/10]'

  // Apply share link theme (overrides user's global theme on the share page)
  React.useEffect(() => {
    const theme = isDark ? 'dark' : 'light'
    document.documentElement.setAttribute('data-theme', theme)
    return () => {
      // Restore user's theme when leaving share page
      try {
        const stored = JSON.parse(localStorage.getItem('ff-theme') || '{}')
        const userTheme = stored?.state?.theme || 'dark'
        const resolved = userTheme === 'system'
          ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
          : userTheme
        document.documentElement.setAttribute('data-theme', resolved)
      } catch {
        document.documentElement.setAttribute('data-theme', 'dark')
      }
    }
  }, [isDark])

  // Whether clicking opens viewer
  const openInViewer = appearance.open_in_viewer !== false

  // Compute total size of assets
  const totalAssetSize = React.useMemo(() => {
    const sum = assets.reduce((acc, a) => acc + (a.file_size ?? 0), 0)
    return sum > 0 ? formatFileSize(sum) : null
  }, [assets])

  // Compute total size of subfolders (approximate from asset sizes)
  const totalFolderSize = React.useMemo(() => {
    // We don't have individual subfolder sizes from the API,
    // just show item count info instead
    return null
  }, [])

  // Fetch assets for current folder/page
  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setPage(1)
    setAssets([])
    setSubfolders([])
    setSelectedAsset(null)

    fetch(
      `${API_URL}/share/${token}/assets?${currentSubfolderId ? `folder_id=${currentSubfolderId}&` : ''}page=1&per_page=${perPage}`,
    )
      .then((r) => {
        if (!r.ok) throw new Error('Failed to load assets')
        return r.json() as Promise<FolderShareAssetsResponse>
      })
      .then((data) => {
        if (cancelled) return
        setAssets(data.assets ?? [])
        setSubfolders(data.subfolders ?? [])
        setTotal(data.total ?? 0)
        setPage(1)
      })
      .catch(() => {
        if (!cancelled) setError('Failed to load contents')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [token, currentSubfolderId])

  async function loadMore() {
    const nextPage = page + 1
    setLoadingMore(true)
    try {
      const r = await fetch(
        `${API_URL}/share/${token}/assets?${currentSubfolderId ? `folder_id=${currentSubfolderId}&` : ''}page=${nextPage}&per_page=${perPage}`,
      )
      if (!r.ok) throw new Error('Failed to load more')
      const data = (await r.json()) as FolderShareAssetsResponse
      setAssets((prev) => [...prev, ...(data.assets ?? [])])
      setPage(nextPage)
    } catch {
      // silently fail
    } finally {
      setLoadingMore(false)
    }
  }

  function navigateToSubfolder(subfolder: FolderShareSubfolder) {
    setBreadcrumbs((prev) => [...prev, { id: subfolder.id, name: subfolder.name }])
    setCurrentSubfolderId(subfolder.id)
    setSearchQuery('')
  }

  function navigateToBreadcrumb(index: number) {
    if (index === -1) {
      setBreadcrumbs([])
      setCurrentSubfolderId(null)
    } else {
      const crumb = breadcrumbs[index]
      setBreadcrumbs((prev) => prev.slice(0, index + 1))
      setCurrentSubfolderId(crumb.id)
    }
    setSearchQuery('')
  }

  // Client-side search filter
  const filteredAssets = searchQuery.trim()
    ? assets.filter((a) => a.name.toLowerCase().includes(searchQuery.toLowerCase().trim()))
    : assets

  const filteredSubfolders = searchQuery.trim()
    ? subfolders.filter((f) => f.name.toLowerCase().includes(searchQuery.toLowerCase().trim()))
    : subfolders

  const hasMore = assets.length < total && !searchQuery.trim()

  // Summary text
  const summaryParts: string[] = []
  if (subfolders.length > 0) {
    summaryParts.push(`${subfolders.length} Folder${subfolders.length === 1 ? '' : 's'}`)
  }
  if (assets.length > 0) {
    summaryParts.push(`${assets.length} Asset${assets.length === 1 ? '' : 's'}`)
  }
  const summaryText = summaryParts.join(', ')

  // Current folder name for breadcrumb display
  const currentTitle = breadcrumbs.length > 0
    ? breadcrumbs[breadcrumbs.length - 1].name
    : (title || folderName)

  // Asset viewer overlay
  if (viewingAsset) {
    return (
      <AssetViewer
        token={token}
        asset={viewingAsset}
        permission={permission}
        allowDownload={allowDownload}
        onBack={() => setViewingAsset(null)}
      />
    )
  }

  return (
    <div className="flex-1 min-h-screen flex flex-col bg-bg-primary text-text-primary">
      {/* ─── Top Bar (Frame.io style) ─────────────────────────────────── */}
      <header className="flex items-center justify-between border-b border-border px-4 h-12 bg-bg-secondary shrink-0">
        {/* Left: viewer profile + breadcrumb */}
        <div className="flex items-center gap-3 min-w-0 flex-1">
          {/* Viewer avatar (logged-in user) or project avatar */}
          {viewerName ? (
            <div className="relative group shrink-0">
              <button className="flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-bold text-text-primary bg-green-600 hover:ring-2 hover:ring-green-400/50 transition-all">
                {viewerName.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase()}
              </button>
              {/* Dropdown */}
              <div className="hidden group-hover:block absolute left-0 top-full mt-1 z-50 w-56 rounded-lg border border-border bg-bg-elevated shadow-xl py-1">
                <div className="px-3 py-2 border-b border-border">
                  <p className="text-sm font-medium text-text-primary">{viewerName}</p>
                </div>
                <button
                  onClick={() => {
                    // Ensure cookie is set from localStorage before navigating
                    if (typeof window !== 'undefined') {
                      const token = localStorage.getItem('ff_access_token')
                      if (token) {
                        document.cookie = `ff_access_token=${token}; path=/; max-age=${60 * 60 * 24 * 7}; SameSite=Lax`
                      }
                      window.location.href = '/'
                    }
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm text-text-primary hover:bg-bg-tertiary transition-colors"
                >
                  Back to Dashboard
                </button>
                <button
                  onClick={() => {
                    if (typeof window !== 'undefined') {
                      localStorage.removeItem('ff_access_token')
                      localStorage.removeItem('ff_refresh_token')
                      document.cookie = 'ff_access_token=; path=/; max-age=0'
                      window.location.href = '/login'
                    }
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm text-red-400 hover:bg-red-500/10 transition-colors"
                >
                  Log out
                </button>
              </div>
            </div>
          ) : branding?.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={branding.logo_url}
              alt=""
              className="h-7 w-7 rounded-full object-cover shrink-0"
            />
          ) : (
            <div
              className="flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-bold text-text-primary shrink-0"
              style={{ backgroundColor: accentColor }}
            >
              {(branding?.custom_title ?? folderName ?? 'FF').substring(0, 2).toUpperCase()}
            </div>
          )}

          {/* Breadcrumb */}
          <span className="text-[13px] font-medium text-text-primary truncate">{currentTitle}</span>
        </div>

        {/* Right: Download All + panel toggle */}
        <div className="flex items-center gap-2 shrink-0">
          {allowDownload && (
            <button
              className="flex items-center gap-1.5 h-7 px-3 rounded-md text-xs font-medium text-text-primary bg-indigo-600 hover:bg-indigo-500 transition-colors"
              onClick={() => {
                // Download all visible assets
                filteredAssets.forEach((a) => handleDownload(token, a.id, a.name))
              }}
            >
              <Download className="h-3 w-3" />
              Download All
            </button>
          )}
          <button
            onClick={() => setPanelOpen((v) => !v)}
            className="flex items-center justify-center h-7 w-7 rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
            title={panelOpen ? 'Hide panel' : 'Show panel'}
          >
            {panelOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
          </button>
        </div>
      </header>

      {/* ─── Content area ──────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">
        {/* ─── Left: folder contents ─────────────────────────────────── */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Sub-header: title, summary, breadcrumb, search */}
          <div className="border-b border-border px-5 py-4">
            <h1 className="text-lg font-bold text-text-primary leading-tight">{title || folderName}</h1>
            {!loading && (
              <p className="mt-0.5 text-sm text-text-tertiary">
                {createdByName && <>Created by {createdByName} &middot; </>}
                {summaryText || 'Empty folder'}
              </p>
            )}

            {/* Breadcrumb + Search row */}
            <div className="flex items-center gap-3 mt-3 flex-wrap">
              <nav className="flex items-center gap-1 text-sm flex-1 min-w-0">
                <button
                  className={cn(
                    'shrink-0 font-medium hover:underline text-text-secondary hover:text-text-primary',
                    breadcrumbs.length === 0 && 'text-text-primary pointer-events-none',
                  )}
                  onClick={() => navigateToBreadcrumb(-1)}
                >
                  Root
                </button>
                {breadcrumbs.map((crumb, i) => (
                  <React.Fragment key={crumb.id}>
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
                    <button
                      className={cn(
                        'truncate max-w-[160px] hover:underline',
                        i === breadcrumbs.length - 1
                          ? 'text-text-primary font-medium pointer-events-none'
                          : 'text-text-secondary hover:text-text-primary',
                      )}
                      onClick={() => navigateToBreadcrumb(i)}
                      title={crumb.name}
                    >
                      {crumb.name}
                    </button>
                  </React.Fragment>
                ))}
              </nav>

              {/* Search */}
              <div className="relative flex items-center shrink-0">
                <Search className="absolute left-2.5 h-3.5 w-3.5 pointer-events-none text-text-tertiary" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search assets…"
                  className="h-8 w-52 pl-8 pr-3 rounded-md text-sm border bg-bg-tertiary border-border text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-border-focus"
                />
              </div>
            </div>
          </div>

          {/* Main scrollable content */}
          <div className="flex-1 overflow-y-auto px-5 py-5">
            {loading ? (
              <div className="flex items-center justify-center py-24">
                <Loader2 className="h-8 w-8 animate-spin text-text-tertiary" />
              </div>
            ) : error ? (
              <div className="flex items-center justify-center py-24">
                <p className="text-sm text-text-tertiary">{error}</p>
              </div>
            ) : filteredSubfolders.length === 0 && filteredAssets.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-24 gap-3">
                <Folder className="h-12 w-12 text-text-tertiary" />
                <p className="text-sm text-text-tertiary">
                  {searchQuery.trim() ? 'No results found' : 'This folder is empty'}
                </p>
              </div>
            ) : (
              <>
                {/* Subfolders section */}
                {filteredSubfolders.length > 0 && (
                  <section className="mb-6">
                    <SectionHeader
                      label={filteredSubfolders.length === 1 ? 'Folder' : 'Folders'}
                      count={filteredSubfolders.length}
                      totalSize={totalFolderSize}
                      expanded={foldersExpanded}
                      onToggle={() => setFoldersExpanded((v) => !v)}
                    />
                    {foldersExpanded && (
                      <div className={cn('grid gap-3 mt-2', gridCols)}>
                        {filteredSubfolders.map((subfolder) => (
                          <SubfolderCard
                            key={subfolder.id}
                            subfolder={subfolder}
                            onClick={navigateToSubfolder}
                          />
                        ))}
                      </div>
                    )}
                  </section>
                )}

                {/* Assets section */}
                {filteredAssets.length > 0 && (
                  <section>
                    <SectionHeader
                      label={filteredAssets.length === 1 ? 'Asset' : 'Assets'}
                      count={filteredAssets.length}
                      totalSize={totalAssetSize}
                      expanded={assetsExpanded}
                      onToggle={() => setAssetsExpanded((v) => !v)}
                    />

                    {assetsExpanded && (
                      <>
                        <div className={cn('grid gap-3 mt-2', gridCols)}>
                          {filteredAssets.map((asset) => (
                            <AssetGridCard
                              key={asset.id}
                              asset={asset}
                              allowDownload={allowDownload}
                              token={token}
                              isSelected={selectedAsset?.id === asset.id}
                              onSelect={setSelectedAsset}
                              onOpen={openInViewer ? setViewingAsset : () => {}}
                              aspectClass={aspectClass}
                              thumbnailScale={thumbnailScale}
                              showCardInfo={showCardInfo}
                            />
                          ))}
                        </div>

                        {/* Load more */}
                        {hasMore && (
                          <div className="flex justify-center mt-6">
                            <button
                              onClick={loadMore}
                              disabled={loadingMore}
                              className="flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-medium border border-border text-text-primary hover:bg-bg-tertiary hover:border-border-focus disabled:opacity-50 transition-colors"
                            >
                              {loadingMore && <Loader2 className="h-4 w-4 animate-spin" />}
                              {loadingMore ? 'Loading…' : 'Load more'}
                            </button>
                          </div>
                        )}
                      </>
                    )}
                  </section>
                )}
              </>
            )}
          </div>

          {/* Footer */}
          <footer className="border-t border-border px-5 py-3 shrink-0">
            <div className="flex items-center justify-between">
              {branding?.custom_footer ? (
                <p className="text-xs text-text-tertiary">{branding.custom_footer}</p>
              ) : (
                <span />
              )}
              {!loading && (
                <p className="text-xs tabular-nums text-text-tertiary">
                  {assets.length + subfolders.length} item{assets.length + subfolders.length === 1 ? '' : 's'}
                </p>
              )}
            </div>
          </footer>
        </div>

        {/* ─── Right Panel ───────────────────────────────────────────── */}
        {panelOpen && (
          <div className="w-[320px] shrink-0 border-l border-border bg-bg-secondary flex flex-col overflow-hidden">
            <RightPanel
              selectedAsset={selectedAsset}
              token={token}
              permission={permission}
              allowDownload={allowDownload}
              onOpenAsset={setViewingAsset}
            />
          </div>
        )}
      </div>
    </div>
  )
}
