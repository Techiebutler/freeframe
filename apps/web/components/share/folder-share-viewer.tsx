'use client'

import * as React from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  Folder,
  File,
  Download,
  Search,
  ChevronDown,
  Image as ImageIcon,
  Video,
  Music,
  Loader2,
  MessageSquare,
  PanelRightClose,
  PanelRightOpen,
  PanelBottomClose,
  PanelBottomOpen,
  GripHorizontal,
  ArrowLeft,
  CheckCircle2,
  XCircle,
  Globe,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useShareAppearance } from '@/hooks/use-share-appearance'
import { withBasePath } from '@/lib/base-path'
import { accentVars } from '@/lib/accent'
import { buildCommentNumbers } from '@/lib/comment-numbers'
import { getGuestCommentToken, removeGuestCommentToken } from '@/lib/guest-comment-tokens'
import { useReview, type CreateCommentPayload } from '@/components/review/review-provider'
import { useReviewStore } from '@/stores/review-store'
import { useMobileReviewSplit } from '@/hooks/use-mobile-review-split'
import { CommentThreadConnector } from '@/components/comments/comment-thread-connector'
import { SharedAssetCard } from '@/components/shared/asset-card'
import { fetchDownloadUrl, fetchShareDownloadOptions, handleDownload, triggerDownload } from './share-download'
import { DownloadMenu } from '@/components/shared/download-menu'
import { ShareBrandMark } from './share-brand-mark'
import { useBranding } from '@/components/shared/branding-provider'
import { usePageTitle } from '@/hooks/use-page-title'
import { SHARE_ASSETS_PAGE_SIZE } from '@/lib/share-page'
import { Avatar } from '@/components/shared/avatar'
import type {
  SharePermission,
  ShareLinkAppearance,
  FolderShareAssetsResponse,
  FolderShareAssetItem,
  FolderShareSubfolder,
  ShareBranding,
} from '@/types'

// ─── Constants ────────────────────────────────────────────────────────────────

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

// ─── Types ────────────────────────────────────────────────────────────────────

interface FolderShareViewerProps {
  token: string
  shareSession?: string | null
  folderName: string
  title: string
  description: string | null
  createdByName?: string | null
  createdByAvatarUrl?: string | null
  viewerName?: string | null
  viewerAvatarUrl?: string | null
  viewerAvatarColor?: string | null
  permission: SharePermission
  allowDownload: boolean
  showVersions: boolean
  appearance: ShareLinkAppearance
  /** The project's, sent for every link type: header logo, accent and footer. */
  branding: ShareBranding | null
  /** Opens this asset when the share is first loaded, then returns to the same root on back. */
  initialAssetId?: string | null
  onAssetClick?: (assetId: string) => void
  embedded?: boolean
  editableHeader?: boolean
  onTitleCommit?: (title: string) => void
  onDescriptionCommit?: (description: string | null) => void
}

function EditableShareTitle({
  value,
  editable,
  onCommit,
  className,
}: {
  value: string
  editable: boolean
  onCommit?: (value: string) => void
  className: string
}) {
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState(value)

  React.useEffect(() => {
    if (!editing) setDraft(value)
  }, [editing, value])

  const commit = () => {
    const next = draft.trim()
    if (!next) {
      setDraft(value)
    } else if (next !== value) {
      onCommit?.(next)
    }
    setEditing(false)
  }

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          }
          if (event.key === 'Escape') {
            setDraft(value)
            setEditing(false)
          }
        }}
        aria-label="Share link title"
        className={cn(className, 'w-full rounded-sm bg-black/15 px-1 -mx-1 outline-none ring-1 ring-accent')}
      />
    )
  }

  return (
    <h1
      className={cn(className, editable && 'cursor-text rounded-sm transition-colors hover:bg-black/10')}
      onClick={editable ? () => setEditing(true) : undefined}
    >
      {draft}
    </h1>
  )
}

function EditableShareDescription({
  value,
  editable,
  onCommit,
  className,
}: {
  value: string | null
  editable: boolean
  onCommit?: (value: string | null) => void
  className: string
}) {
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState(value ?? '')

  React.useEffect(() => {
    if (!editing) setDraft(value ?? '')
  }, [editing, value])

  const commit = () => {
    const next = draft.trim()
    if (next !== (value ?? '')) onCommit?.(next || null)
    setEditing(false)
  }

  if (!value && !editable) return null
  if (editing) {
    return (
      <textarea
        autoFocus
        rows={2}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setDraft(value ?? '')
            setEditing(false)
          }
        }}
        aria-label="Share link description"
        className={cn(className, 'w-full resize-none rounded-sm bg-black/15 px-1 -mx-1 outline-none ring-1 ring-accent')}
      />
    )
  }

  return (
    <p
      className={cn(
        className,
        editable && 'cursor-text rounded-sm transition-colors hover:bg-black/10',
        !draft && 'text-text-tertiary italic',
      )}
      onClick={editable ? () => setEditing(true) : undefined}
    >
      {draft || 'Add a description…'}
    </p>
  )
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
// triggerDownload / fetchDownloadUrl / handleDownload live in ./share-download.

async function fetchSharePreviewUrl(token: string, assetId: string, shareSession?: string | null): Promise<string | null> {
  const params = new URLSearchParams({ _: '1' })
  if (shareSession) params.set('share_session', shareSession)
  const headers: Record<string, string> = {}
  try {
    const accessToken = localStorage.getItem('ff_access_token')
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`
  } catch {}

  const response = await fetch(`${API_URL}/share/${token}/stream/${assetId}?${params}`, { headers })
  if (!response.ok) return null
  const data = await response.json() as { url?: string }
  if (!data.url) return null
  return data.url.startsWith('/') ? `${API_URL}${data.url}` : data.url
}

async function collectAllAssetsRecursive(
  token: string,
  folderId: string | null,
  shareSession?: string | null,
): Promise<{ id: string; name: string }[]> {
  // Fetch assets + subfolders at this level, then recurse into subfolders.
  const sp = shareSession ? `&share_session=${encodeURIComponent(shareSession)}` : ''
  const folderParam = folderId ? `folder_id=${folderId}&` : ''
  try {
    const res = await fetch(`${API_URL}/share/${token}/assets?${folderParam}page=1&per_page=500${sp}`)
    if (!res.ok) return []
    const data = await res.json() as { assets?: { id: string; name: string }[]; subfolders?: { id: string }[] }
    const items: { id: string; name: string }[] = (data.assets ?? []).map((a) => ({ id: a.id, name: a.name }))
    const subfolders = data.subfolders ?? []
    for (const sub of subfolders) {
      const nested = await collectAllAssetsRecursive(token, sub.id, shareSession)
      items.push(...nested)
    }
    return items
  } catch {
    return []
  }
}

async function handleDownloadAll(
  token: string,
  folderId: string | null,
  shareSession?: string | null,
) {
  // Recursively collect all assets (including those in subfolders),
  // pre-fetch presigned URLs in parallel, then trigger downloads
  // sequentially with a delay so the browser doesn't block them. Same rule as
  // bulk download on the project page: originals when the instance allows them,
  // transcodes otherwise.
  const allAssets = await collectAllAssetsRecursive(token, folderId, shareSession)
  const urls = await Promise.all(
    allAssets.map((a) => fetchDownloadUrl(token, a.id, shareSession, undefined, true)),
  )
  for (const url of urls) {
    if (!url) continue
    triggerDownload(url)
    await new Promise((r) => setTimeout(r, 800))
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
      className="group flex flex-col rounded-lg border border-border bg-bg-tertiary overflow-hidden text-left transition-all cursor-pointer [@media(hover:hover)]:hover:border-border-focus [@media(hover:hover)]:hover:bg-bg-hover"
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
            className="absolute inset-0 h-full w-full object-cover transition-transform duration-200 [@media(hover:hover)]:group-hover:scale-[1.03]"
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

// ─── List row thumbnail with error fallback ───────────────────────────────────

function ListRowThumb({ asset, TypeIcon }: { asset: FolderShareAssetItem; TypeIcon: React.ElementType }) {
  const [imgError, setImgError] = React.useState(false)
  return (
    <div className="h-14 w-14 shrink-0 rounded-md overflow-hidden bg-bg-tertiary flex items-center justify-center">
      {asset.thumbnail_url && !imgError ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={asset.thumbnail_url} alt={asset.name} className="h-full w-full object-cover" onError={() => setImgError(true)} />
      ) : (
        <TypeIcon className="h-6 w-6 text-text-tertiary/60" />
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
  actions?: React.ReactNode
}

function SectionHeader({ label, count, totalSize, expanded, onToggle, actions }: SectionHeaderProps) {
  return (
    <div className="flex items-center gap-3 py-2">
      <button className="flex flex-1 items-center gap-2 text-left group" onClick={onToggle}>
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
      {actions}
    </div>
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

export interface GuestComment {
  id: string
  body: string
  guest_name: string
  guest_email: string
  author_name?: string
  author?: { id: string; name: string; avatar_url?: string | null; avatar_color?: string | null } | null
  guest_author?: { id: string; name: string; email: string } | null
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
    // The grid preview has no version switcher — scope to the latest ready version
    // so it doesn't mix comments from every version.
    fetch(`${API_URL}/share/${token}/comments?asset_id=${selectedAsset.id}&latest_only=true`)
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

/** Exported for tests. */
export function ShareCommentList({ comments, loading, canComment, onReply }: ShareCommentListProps) {
  const commentNumbers = React.useMemo(() => buildCommentNumbers(comments), [comments])

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
    <div className="space-y-2 px-3 py-3">
      {comments.map((comment) => {
        const name = comment.author?.name || comment.guest_author?.name || comment.guest_name || comment.author_name || 'User'
        const color = getAvatarColor(name)
        return (
          <CommentThreadConnector key={comment.id} active={Boolean(comment.replies?.length)}>
          <div className="relative rounded-lg border border-white/[0.06] bg-bg-primary/30 px-3 transition-colors hover:border-white/15 hover:bg-white/[0.02]">
            {/* Comment header */}
            <div className="relative z-[1] flex items-start gap-2.5 py-3">
              {/* Their picture, else initials on their own circle colour. The
                  wrapper is the anchor the thread connector measures. */}
              <span data-comment-thread-avatar className="inline-flex shrink-0">
                <Avatar
                  src={comment.author?.avatar_url}
                  name={name}
                  color={comment.author?.avatar_color}
                  className={cn('font-bold', color)}
                />
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-semibold text-text-primary">{name}</span>
                  <span className="text-[11px] text-text-tertiary">{formatShortDate(comment.created_at)}</span>
                  <span className="ml-auto text-2xs text-text-tertiary">#{commentNumbers.get(comment.id)}</span>
                  <Globe className="h-3.5 w-3.5 text-text-tertiary" />
                </div>
                {comment.timecode_start != null && (
                  <span className="inline-flex items-center gap-1 mt-1.5 text-[11px] text-amber-400 font-mono bg-amber-500/20 px-1.5 py-0.5 rounded-md">
                    {Math.floor(comment.timecode_start / 60)}:{String(Math.floor(comment.timecode_start % 60)).padStart(2, '0')}
                  </span>
                )}
                <p className="mt-1.5 text-[13px] leading-relaxed text-text-secondary">{comment.body}</p>
                {canComment && onReply && (
                  <button onClick={() => onReply(comment.id)} className="block mt-2 text-xs text-text-tertiary hover:text-text-primary transition-colors">
                    Reply
                  </button>
                )}
              </div>
            </div>

            {/* Nested replies */}
            {comment.replies && comment.replies.length > 0 && (
              <div className="mt-0.5">
                {comment.replies.map((r) => {
                  const rName = r.author?.name || r.guest_author?.name || r.guest_name || r.author_name || 'User'
                  const rColor = getAvatarColor(rName)
                  return (
                    <div key={r.id} className="relative z-[1] flex items-start gap-2.5 py-3">
                      <span data-comment-thread-avatar className="mt-0.5 inline-flex shrink-0">
                        <Avatar
                          src={r.author?.avatar_url}
                          name={rName}
                          color={r.author?.avatar_color}
                          className={cn('text-[11px] font-bold', rColor)}
                        />
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-[13px] font-semibold text-text-primary">{rName}</span>
                          <span className="text-[11px] text-text-tertiary">{formatShortDate(r.created_at)}</span>
                          <Globe className="ml-auto h-3.5 w-3.5 text-text-tertiary" />
                        </div>
                        <p className="mt-1 text-[13px] leading-relaxed text-text-secondary">{r.body}</p>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
          </CommentThreadConnector>
        )
      })}
    </div>
  )
}

// ─── Asset Viewer (full-screen media viewer for shared assets) ───────────────

interface AssetViewerProps {
  token: string
  shareSession?: string | null
  asset: FolderShareAssetItem
  permission: SharePermission
  allowDownload: boolean
  showVersions: boolean
  parentPath?: string
  theme: 'dark' | 'light'
  projectLogoUrl: string | null
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

function AssetViewer({ token, shareSession, asset, permission, allowDownload, showVersions, parentPath, theme, projectLogoUrl, onBack }: AssetViewerProps) {
  // Use the same ReviewProvider as the project review page, but with shareToken
  // This gives us the same video player, image viewer, comment panel, etc.
  return (
    <div className="fixed inset-0 z-50">
      <ShareReviewScreen
        token={token}
        shareSession={shareSession}
        assetId={asset.id}
        assetName={asset.name}
        permission={permission}
        allowDownload={allowDownload}
        showVersions={showVersions}
        parentPath={parentPath}
        theme={theme}
        projectLogoUrl={projectLogoUrl}
        onBack={onBack}
      />
    </div>
  )
}

/**
 * The review screen a share link shows for one asset.
 *
 * Upstream moved this into share-review-screen.tsx (#117, #123) with a mobile
 * bottom sheet. This fork keeps it here because it carries fork-only behaviour:
 * the resizable mobile split (useMobileReviewSplit), the folder path in the top
 * bar, guest comment edit/delete via the guest edit token, and the approve /
 * reject actions. Upstream's fixes are ported in: the share brand mark in the
 * header, the download menu, no comment export or Internal toggle for guests,
 * and replies that keep their text until the guest has named themselves.
 */
export function ShareReviewScreen({
  token, shareSession, assetId, assetName, permission, allowDownload, showVersions, parentPath, theme = 'dark', projectLogoUrl, onBack,
}: {
  token: string; shareSession?: string | null; assetId: string; assetName: string; permission: SharePermission; allowDownload: boolean; showVersions: boolean; parentPath?: string
  /** The link's theme, which the page renders in; picks the logo variant. Dark, the share pages' default, when not given. */
  theme?: 'dark' | 'light'
  /** The project's logo from the link's branding, shown ahead of the instance's. */
  projectLogoUrl?: string | null
  onBack?: () => void
}) {
  const [ReviewProvider, setProvider] = React.useState<any>(null)
  const [VideoPlayer, setVideoPlayer] = React.useState<any>(null)
  const [ImageViewer, setImageViewer] = React.useState<any>(null)
  const [AudioPlayer, setAudioPlayer] = React.useState<any>(null)
  const [CommentPanel, setCommentPanel] = React.useState<any>(null)
  const [CommentInput, setCommentInput] = React.useState<any>(null)
  const [VersionSwitcher, setVersionSwitcher] = React.useState<any>(null)
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
      import('@/components/review/version-switcher'),
    ]).then(([provider, video, image, audio, comments, input, versionSwitcher]) => {
      setProvider(() => provider.ReviewProvider)
      setVideoPlayer(() => video.VideoPlayer)
      setImageViewer(() => image.ImageViewer)
      setAudioPlayer(() => audio.AudioPlayer)
      setCommentPanel(() => comments.CommentPanel)
      setCommentInput(() => input.CommentInput)
      setVersionSwitcher(() => versionSwitcher.VersionSwitcher)
      setLoaded(true)
    })
  }, [])

  if (!loaded || !ReviewProvider) {
    return <div className="flex items-center justify-center h-dvh bg-bg-primary"><Loader2 className="h-8 w-8 animate-spin text-text-tertiary" /></div>
  }

  return (
    <ReviewProvider assetId={assetId} shareToken={token} shareSession={shareSession}>
      <ShareReviewInner
        token={token}
        shareSession={shareSession}
        assetName={assetName}
        permission={permission}
        allowDownload={allowDownload}
        showVersions={showVersions}
        parentPath={parentPath}
        theme={theme}
        projectLogoUrl={projectLogoUrl}
        onBack={onBack}
        VideoPlayer={VideoPlayer}
        ImageViewer={ImageViewer}
        AudioPlayer={AudioPlayer}
        CommentPanel={CommentPanel}
        CommentInput={CommentInput}
        VersionSwitcher={VersionSwitcher}
      />
    </ReviewProvider>
  )
}

/** Signed in, or a guest who has already given a name and email. */
function hasIdentity(): boolean {
  try {
    return !!localStorage.getItem('ff_access_token') || !!localStorage.getItem('ff_guest_identity')
  } catch {
    return false
  }
}

function ShareReviewInner({
  token, shareSession, assetName, permission, allowDownload, showVersions, parentPath, theme, projectLogoUrl, onBack,
  VideoPlayer, ImageViewer, AudioPlayer, CommentPanel, CommentInput, VersionSwitcher,
}: any) {
  const { asset, versions, isLoading, comments, refetchComments, addComment } = useReview()
  const { currentVersion, isDrawingMode, focusedCommentId } = useReviewStore()
  // An asset opens on its comments: that pane is the reason an asset link
  // exists. On small screens the comments panel is part of the page flow,
  // below the media, rather than a hidden overlay. Desktop keeps the
  // collapsible sidebar.
  const [sidebarOpen, setSidebarOpen] = React.useState(true)
  const mobileSplit = useMobileReviewSplit()
  const [activeTab, setActiveTab] = React.useState<'comments' | 'fields'>('comments')
  const [AnnotationOverlay, setAnnotationOverlay] = React.useState<any>(null)
  const [AnnotationCanvas, setAnnotationCanvas] = React.useState<any>(null)

  React.useEffect(() => {
    Promise.all([
      import('@/components/review/annotation-overlay'),
      import('@/components/review/annotation-canvas'),
    ]).then(([overlayMod, canvasMod]) => {
      setAnnotationOverlay(() => overlayMod.AnnotationOverlay)
      setAnnotationCanvas(() => canvasMod.AnnotationCanvas)
    })
  }, [])

  const canComment = permission === 'comment' || permission === 'approve'
  const versionReady = currentVersion?.processing_status === 'ready'

  // Guest identity flow for non-authenticated users
  const [guestIdentity, setGuestIdentity] = React.useState<{ name: string; email: string } | null>(null)
  const [showGuestPrompt, setShowGuestPrompt] = React.useState(false)
  // What was typed before the guest had a name. A reply also carries its parent
  // and the promise its InlineReplyInput is waiting on, so the typed text stays
  // in the box until it is really sent (or the prompt is dismissed).
  const pendingCommentRef = React.useRef<{
    body: string; timecodeStart?: number; timecodeEnd?: number; annotationData?: Record<string, unknown>
    parentId?: string
    settle?: { resolve: () => void; reject: (e: Error) => void }
  } | null>(null)
  React.useEffect(() => {
    try {
      const stored = localStorage.getItem('ff_guest_identity')
      if (stored) setGuestIdentity(JSON.parse(stored))
    } catch {}
  }, [])
  const isLoggedIn = typeof window !== 'undefined' && !!localStorage.getItem('ff_access_token')

  const submitComment = React.useCallback(async (body: string, timecodeStart?: number, timecodeEnd?: number, annotationData?: Record<string, unknown>, parentId?: string) => {
    const payload: CreateCommentPayload = { body }
    if (currentVersion?.id) payload.version_id = currentVersion.id
    if (parentId) payload.parent_id = parentId
    if (timecodeStart != null) payload.timecode_start = timecodeStart
    if (timecodeEnd != null) payload.timecode_end = timecodeEnd
    if (annotationData) payload.annotation = { drawing_data: annotationData }
    await addComment(payload)
    // The optimistic append only ever shows top-level rows (CommentPanel renders
    // replies from their parent), so a reply is not on screen until the refetch.
    if (parentId) await refetchComments().catch(() => {})
    else refetchComments().catch(() => {})
  }, [addComment, currentVersion, refetchComments])

  const submitWithIdentity = React.useCallback(async (body: string, timecodeStart?: number, timecodeEnd?: number, annotationData?: Record<string, unknown>, parentId?: string) => {
    if (!hasIdentity()) {
      pendingCommentRef.current = { body, timecodeStart, timecodeEnd, annotationData, parentId }
      setShowGuestPrompt(true)
      return
    }
    await submitComment(body, timecodeStart, timecodeEnd, annotationData, parentId)
  }, [submitComment])

  const submitReply = React.useCallback(async (parentId: string, body: string) => {
    if (!hasIdentity()) {
      // Resolved once the guest names themselves and the reply is sent; until
      // then the reply box keeps what was typed.
      return new Promise<void>((resolve, reject) => {
        pendingCommentRef.current = { body, parentId, settle: { resolve, reject } }
        setShowGuestPrompt(true)
      })
    }
    await submitComment(body, undefined, undefined, undefined, parentId)
  }, [submitComment])

  const handleGuestIdentitySave = React.useCallback(async (name: string, email: string) => {
    const identity = { name, email }
    setGuestIdentity(identity)
    localStorage.setItem('ff_guest_identity', JSON.stringify(identity))
    setShowGuestPrompt(false)

    // Auto-submit the pending comment
    if (pendingCommentRef.current) {
      const { body, timecodeStart, timecodeEnd, annotationData, parentId, settle } = pendingCommentRef.current
      pendingCommentRef.current = null
      setTimeout(() => {
        submitComment(body, timecodeStart, timecodeEnd, annotationData, parentId)
          .then(() => settle?.resolve())
          .catch((e) => settle?.reject(e instanceof Error ? e : new Error('Failed to post comment')))
      }, 50)
    }
  }, [submitComment])

  if (isLoading || !asset) {
    return <div className="flex items-center justify-center h-dvh bg-bg-primary"><Loader2 className="h-8 w-8 animate-spin text-text-tertiary" /></div>
  }

  return (
    <div className="flex flex-col h-dvh bg-bg-primary text-text-primary pl-safe pr-safe">
      {/* Top bar — same style as project review */}
      <div className="flex items-center justify-between border-b border-border px-3 h-12 bg-bg-secondary shrink-0">
        <div className="flex items-center gap-1 sm:gap-2 min-w-0 flex-1">
          {onBack && (
            <button onClick={onBack} className="flex items-center justify-center h-7 w-7 rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors shrink-0">
              <ArrowLeft className="h-4 w-4" />
            </button>
          )}
          <ShareBrandMark theme={theme} projectLogoUrl={projectLogoUrl} />
          {/* The name gives way last: the logo shrinks first (ShareBrandMark),
              and Download is icon-only on a phone. */}
          <span className="text-[13px] font-medium text-text-primary truncate min-w-[4rem]">
            {parentPath && <span className="text-text-secondary">{parentPath} <span className="px-1 text-text-tertiary">/</span></span>}
            {assetName}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {showVersions && VersionSwitcher && versions.length > 0 && (
            <>
              <div className="md:hidden">
                <VersionSwitcher versions={versions} compact />
              </div>
              <div className="hidden md:block">
                <VersionSwitcher versions={versions} />
              </div>
            </>
          )}
          {allowDownload && (
            <DownloadMenu
              load={() => fetchShareDownloadOptions(token, asset.id, shareSession)}
              onPick={(rendition) => handleDownload(token, asset.id, shareSession, rendition)}
            >
              <button aria-label="Download" className="flex items-center gap-1.5 h-7 px-2 sm:px-3 rounded-md text-xs font-medium text-text-inverse bg-accent hover:bg-accent-hover transition-colors">
                <Download className="h-3 w-3" /> <span className="hidden sm:inline">Download</span>
                <ChevronDown className="h-3 w-3 opacity-70" />
              </button>
            </DownloadMenu>
          )}
          <button
            onClick={() => setSidebarOpen(v => !v)}
            title={sidebarOpen ? 'Hide panel' : 'Show panel'}
            className={cn(
              'mobile-touch-target flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-bg-hover',
              sidebarOpen ? 'text-accent hover:text-accent' : 'text-text-secondary hover:text-text-primary',
            )}
          >
            {mobileSplit.isMobile
              ? sidebarOpen ? <PanelBottomClose className="h-4 w-4" /> : <PanelBottomOpen className="h-4 w-4" />
              : sidebarOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {/* Main: viewer + sidebar */}
      <div ref={mobileSplit.containerRef} className="relative flex flex-1 min-h-0 flex-col overflow-hidden md:flex-row">
        {/* Media viewer — reuses project components */}
        <div
          className={cn('flex min-h-[220px] flex-col bg-bg-primary overflow-hidden min-w-0 md:min-h-0 md:flex-1', sidebarOpen ? 'flex-none' : 'flex-1')}
          style={mobileSplit.isMobile && sidebarOpen ? { height: `${mobileSplit.mediaPercent}%` } : undefined}
        >
          {asset.asset_type === 'video' && versionReady && VideoPlayer ? (
            <VideoPlayer
              assetId={asset.id}
              comments={comments}
              className="flex-1"
              initialStreamUrl={(asset as any).stream_url}
              overlay={
                <>
                  {AnnotationOverlay && <AnnotationOverlay key={focusedCommentId ?? 'none'} />}
                  {isDrawingMode && AnnotationCanvas && <AnnotationCanvas />}
                </>
              }
            />
          ) : asset.asset_type === 'audio' && versionReady && AudioPlayer ? (
            <AudioPlayer asset={asset} version={currentVersion} comments={comments} className="flex-1" />
          ) : (asset.asset_type === 'image' || asset.asset_type === 'image_carousel') && versionReady && ImageViewer ? (
            <div className="relative flex-1 flex items-center justify-center p-4 overflow-hidden">
              <ImageViewer
                asset={asset}
                version={currentVersion}
                annotationCanvas={
                  <>
                    {AnnotationOverlay && <AnnotationOverlay key={focusedCommentId ?? 'none'} />}
                    {isDrawingMode && AnnotationCanvas && <AnnotationCanvas />}
                  </>
                }
              />
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-text-tertiary" />
            </div>
          )}
        </div>

        {sidebarOpen && (
          <div className="relative z-10 h-0 shrink-0 md:hidden">
            <div
              role="separator"
              aria-label="Resize media and comments"
              aria-orientation="horizontal"
              className="absolute -top-4 left-0 flex h-8 w-full touch-none cursor-row-resize items-center justify-center"
              onPointerDown={mobileSplit.onPointerDown}
              onPointerMove={mobileSplit.onPointerMove}
              onPointerUp={mobileSplit.onPointerUp}
              onPointerCancel={mobileSplit.onPointerCancel}
            >
              <span className="pointer-events-none flex h-3 w-8 items-center justify-center rounded-full bg-accent text-text-tertiary">
                <GripHorizontal className="h-2.5 w-3.5" />
              </span>
            </div>
          </div>
        )}

        {/* Right sidebar — reuses project comment panel */}
        {sidebarOpen && (
          <div
            className="w-full min-h-0 flex flex-col border-t border-border bg-bg-secondary shrink-0 md:w-[360px] md:min-h-0 md:border-t-0 md:border-l"
            style={mobileSplit.isMobile ? { height: `${100 - mobileSplit.mediaPercent}%` } : undefined}
          >
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
                  // A guest has no access token, and `exportComments` sends
                  // nothing else, so the control could only ever 401 here.
                  canExport={false}
                  onResolve={() => {}}
                  canManageComment={(comment: any) => !!getGuestCommentToken(token, comment.id)}
                  onUpdate={async (commentId: string, body: string) => {
                    const guestEditToken = getGuestCommentToken(token, commentId)
                    if (!guestEditToken) throw new Error('Not authorized to edit this comment')
                    const session = shareSession ? `?share_session=${encodeURIComponent(shareSession)}` : ''
                    const response = await fetch(`${API_URL}/share/${token}/comments/${commentId}${session}`, {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json', 'X-Guest-Comment-Token': guestEditToken },
                      body: JSON.stringify({ body }),
                    })
                    if (!response.ok) throw new Error('Failed to edit comment')
                    await refetchComments()
                  }}
                  onDelete={async (commentId: string) => {
                    const guestEditToken = getGuestCommentToken(token, commentId)
                    if (!guestEditToken) throw new Error('Not authorized to delete this comment')
                    const session = shareSession ? `?share_session=${encodeURIComponent(shareSession)}` : ''
                    const response = await fetch(`${API_URL}/share/${token}/comments/${commentId}${session}`, {
                      method: 'DELETE',
                      headers: { 'X-Guest-Comment-Token': guestEditToken },
                    })
                    if (!response.ok) throw new Error('Failed to delete comment')
                    removeGuestCommentToken(token, commentId)
                    await refetchComments()
                  }}
                  onAddReaction={() => {}}
                  onRemoveReaction={() => {}}
                  onReply={() => {}}
                  // Undefined on a view-only link, which also hides Reply (#439).
                  onSubmitReply={canComment ? submitReply : undefined}
                  disableAttachments
                />
                {permission === 'approve' && (
                  <ShareApprovalActions token={token} assetId={asset.id} shareSession={shareSession} />
                )}
                {canComment && CommentInput && (
                  <CommentInput
                    assetId={asset.id}
                    projectId=""
                    assetType={asset.asset_type}
                    // An internal comment is team-only: the share listing never
                    // returns one and the API refuses one from a guest.
                    allowInternal={false}
                    onSubmit={async (body: string, timecodeStart?: number, timecodeEnd?: number, annotationData?: Record<string, unknown>, parentId?: string) => submitWithIdentity(body, timecodeStart, timecodeEnd, annotationData, parentId)}
                    allowAttachments={false}
                  />
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Guest identity prompt */}
      {showGuestPrompt && (
        <GuestIdentityPrompt
          onSave={handleGuestIdentitySave}
          onCancel={() => {
            setShowGuestPrompt(false)
            // A quiet abort: the reply box keeps its text and shows no error.
            pendingCommentRef.current?.settle?.reject(new Error(''))
            pendingCommentRef.current = null
          }}
        />
      )}
    </div>
  )
}

function ShareApprovalActions({ token, assetId, shareSession }: { token: string; assetId: string; shareSession?: string | null }) {
  const [status, setStatus] = React.useState<'idle' | 'approved' | 'rejected'>('idle')
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const decide = async (decision: 'approved' | 'rejected') => {
    setLoading(true)
    setError(null)
    try {
      const session = shareSession ? `?share_session=${encodeURIComponent(shareSession)}` : ''
      const response = await fetch(`${API_URL}/share/${token}/${decision === 'approved' ? 'approve' : 'reject'}${session}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ asset_id: assetId }),
      })
      if (!response.ok) throw new Error('Failed to submit decision')
      setStatus(decision)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Failed to submit decision')
    } finally {
      setLoading(false)
    }
  }

  if (status === 'approved') {
    return <div className="mx-3 mb-2 flex items-center gap-2 rounded-lg border border-green-500/20 bg-green-500/10 px-4 py-2"><CheckCircle2 className="h-4 w-4 text-green-400" /><span className="text-sm font-medium text-green-400">Approved</span></div>
  }
  if (status === 'rejected') {
    return <div className="mx-3 mb-2 flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-2"><XCircle className="h-4 w-4 text-red-400" /><span className="text-sm font-medium text-red-400">Rejected</span></div>
  }

  return (
    <div className="flex gap-2 px-3 pb-2">
      {error && <span className="self-center text-xs text-red-400">{error}</span>}
      <button onClick={() => decide('rejected')} disabled={loading} className="flex-1 rounded-md border border-red-500/30 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/10 disabled:opacity-50">Reject</button>
      <button onClick={() => decide('approved')} disabled={loading} className="flex-1 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-text-inverse hover:bg-accent-hover disabled:opacity-50">Approve</button>
    </div>
  )
}

// ─── Guest Identity Prompt ───────────────────────────────────────────────────

function GuestIdentityPrompt({ onSave, onCancel }: { onSave: (name: string, email: string) => void; onCancel: () => void }) {
  const [name, setName] = React.useState('')
  const [email, setEmail] = React.useState('')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-xl border border-border bg-bg-secondary p-5 shadow-xl">
        <h3 className="text-sm font-semibold text-text-primary mb-1">Leave a comment</h3>
        <p className="text-xs text-text-tertiary mb-4">Enter your name and email to comment on this shared asset.</p>
        <div className="space-y-3">
          <input
            type="text"
            placeholder="Your name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-[16px] [@media(hover:hover)]:text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent"
            autoFocus
          />
          <input
            type="email"
            placeholder="Email address"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-[16px] [@media(hover:hover)]:text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent"
          />
        </div>
        <div className="flex items-center justify-end gap-2 mt-4">
          <button onClick={onCancel} className="px-3 py-1.5 text-xs text-text-tertiary hover:text-text-primary transition-colors">
            Cancel
          </button>
          <button
            disabled={!name.trim() || !email.trim()}
            onClick={() => onSave(name.trim(), email.trim())}
            className="px-4 py-1.5 rounded-md bg-accent text-xs font-medium text-text-inverse hover:bg-accent/90 disabled:opacity-50 transition-colors"
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Document-level effects (share page only) ────────────────────────────────

/**
 * The link's theme and accent on the whole document, and the tab title.
 *
 * Only the share page mounts this. The embedded preview in the dashboard
 * (share-link detail) leaves the document alone and relies on the scoped
 * `data-theme` and accent variables on its own root instead.
 */
function ShareDocumentEffects({ title, accentColor, isDark }: { title: string; accentColor: string | null | undefined; isDark: boolean }) {
  // Re-applied once branding loads and when React remounts the metadata title.
  usePageTitle(title)
  useShareAppearance(accentColor, isDark)
  return null
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function FolderShareViewer({
  token,
  shareSession,
  folderName,
  title,
  description,
  createdByName,
  createdByAvatarUrl,
  viewerName,
  viewerAvatarUrl,
  viewerAvatarColor,
  permission,
  allowDownload,
  showVersions,
  appearance,
  branding,
  initialAssetId = null,
  onAssetClick,
  embedded = false,
  editableHeader = false,
  onTitleCommit,
  onDescriptionCommit,
}: FolderShareViewerProps) {
  // Build share_session query param for all API calls
  const sessionParam = shareSession ? `&share_session=${encodeURIComponent(shareSession)}` : ''
  const [currentSubfolderId, setCurrentSubfolderId] = React.useState<string | null>(null)
  const [breadcrumbs, setBreadcrumbs] = React.useState<{ id: string; name: string }[]>([])
  const [searchQuery, setSearchQuery] = React.useState('')
  const [foldersExpanded, setFoldersExpanded] = React.useState(true)
  const [assetsExpanded, setAssetsExpanded] = React.useState(true)
  // The comments pane starts closed. A guest following a link came to look at
  // the media, and on a laptop the pane took a third of the grid before they
  // had picked anything — it showed "Select an asset to view comments". The
  // panel belongs to the asset viewer, where ShareReviewScreen opens its own
  // sidebar by default; here it stays behind the header toggle.
  const [panelOpen, setPanelOpen] = React.useState(false)
  const [viewingAsset, setViewingAsset] = React.useState<FolderShareAssetItem | null>(null)
  const pendingInitialAssetId = React.useRef(initialAssetId)
  const headerAppearance = {
    key: appearance.header_banner_key,
    url: appearance.header_banner_url ?? null,
    positionX: appearance.header_banner_position_x ?? 50,
    positionY: appearance.header_banner_position_y ?? 50,
    zoom: appearance.header_banner_zoom ?? 1,
  }

  // Page title: set by ShareDocumentEffects below, which the embedded preview
  // does not mount so it never replaces the dashboard's browser title.
  const [selectedAsset, setSelectedAsset] = React.useState<FolderShareAssetItem | null>(null)

  const [assets, setAssets] = React.useState<FolderShareAssetItem[]>([])
  const [subfolders, setSubfolders] = React.useState<FolderShareSubfolder[]>([])
  const [total, setTotal] = React.useState(0)
  const [page, setPage] = React.useState(1)
  const [loading, setLoading] = React.useState(true)
  const [loadingMore, setLoadingMore] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const accentColor = appearance.accent_color ?? branding?.primary_color
  // No fallback: a link with no accent of its own, on an instance with no
  // accent of its own, keeps the stylesheet's. Substituting a colour here
  // would repaint every share link that already exists.
  const isDark = appearance.theme !== 'light'
  // The same theme and accent, scoped to this subtree, so the embedded preview
  // in the dashboard shows the link's look without repainting the dashboard.
  // The scoped `data-theme` redefines --accent to the palette's stock colour,
  // which would hide the instance accent the document carries (BrandingHead),
  // so with no link or project accent the subtree restates the instance's.
  // Still no fallback beyond that: an unbranded instance keeps the palette's.
  const { primaryColor: instanceAccent } = useBranding()
  const previewThemeStyle = React.useMemo(
    () => (accentVars(accentColor ?? instanceAccent) ?? {}) as React.CSSProperties,
    [accentColor, instanceAccent],
  )
  const cardSize = appearance.card_size ?? 'm'
  const aspectRatio = appearance.aspect_ratio ?? 'landscape'
  const thumbnailScale = appearance.thumbnail_scale ?? 'fill'
  const showCardInfo = appearance.show_card_info !== false
  const isGridLayout = appearance.layout !== 'list'
  const perPage = SHARE_ASSETS_PAGE_SIZE

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

  // On the share page itself, the link's theme and accent also apply to the
  // document (portalled menus included) and hold the tab title.
  const documentEffects = embedded ? null : (
    <ShareDocumentEffects title={title} accentColor={accentColor} isDark={isDark} />
  )

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
      `${API_URL}/share/${token}/assets?${currentSubfolderId ? `folder_id=${currentSubfolderId}&` : ''}page=1&per_page=${perPage}${sessionParam}`,
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
        if (!currentSubfolderId && pendingInitialAssetId.current) {
          const initialAsset = data.assets?.find((asset) => asset.id === pendingInitialAssetId.current)
          if (initialAsset) setViewingAsset(initialAsset)
          pendingInitialAssetId.current = null
        }
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
        `${API_URL}/share/${token}/assets?${currentSubfolderId ? `folder_id=${currentSubfolderId}&` : ''}page=${nextPage}&per_page=${perPage}${sessionParam}`,
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

  // Client-side search filter + sort
  const sortBy = appearance.sort_by ?? 'created_at'
  const filteredAssets = React.useMemo(() => {
    const list = searchQuery.trim()
      ? assets.filter((a) => a.name.toLowerCase().includes(searchQuery.toLowerCase().trim()))
      : [...assets]
    list.sort((a, b) => {
      if (sortBy === 'name') return a.name.localeCompare(b.name)
      if (sortBy === 'file_size') return (b.file_size ?? 0) - (a.file_size ?? 0)
      // default: created_at desc
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    })
    return list
  }, [assets, searchQuery, sortBy])

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

  const locationItems = [
    { id: null as string | null, name: title || folderName },
    ...breadcrumbs,
  ]
  const assetParentPath = locationItems.map((item) => item.name).join(' / ')

  // One search box. It sits in the Assets header, or in the Folders header
  // when no asset matches, or above the empty state.
  const searchBox = (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-tertiary" />
      <input
        type="text"
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        placeholder="Search assets…"
        aria-label="Search assets"
        className="h-8 w-52 rounded-md border border-border bg-bg-tertiary pl-8 pr-3 text-[16px] [@media(hover:hover)]:text-sm text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
      />
    </div>
  )


  // Asset viewer overlay
  if (viewingAsset) {
    return (
      <>
        {documentEffects}
        <div
          data-theme={isDark ? 'dark' : 'light'}
          style={previewThemeStyle}
          className={cn('bg-bg-primary text-text-primary', embedded ? 'h-full min-h-0' : 'min-h-screen')}
        >
          <AssetViewer
            token={token}
            shareSession={shareSession}
            asset={viewingAsset}
            permission={permission}
            allowDownload={allowDownload}
            showVersions={showVersions}
            parentPath={assetParentPath}
            theme={isDark ? 'dark' : 'light'}
            projectLogoUrl={branding?.logo_url ?? null}
            onBack={() => setViewingAsset(null)}
          />
        </div>
      </>
    )
  }

  return (
    <>
    {documentEffects}
    <div
      data-theme={isDark ? 'dark' : 'light'}
      style={previewThemeStyle}
      className={cn('flex flex-col bg-bg-primary text-text-primary', embedded ? 'h-full min-h-0 w-full' : 'flex-1 min-h-screen')}
    >
      {/* ─── Top Bar (Frame.io style) ─────────────────────────────────── */}
      <header className="flex items-center justify-between border-b border-border px-4 h-12 bg-bg-secondary shrink-0">
        {/* Left: viewer profile + breadcrumb */}
        <div className="flex items-center gap-3 min-w-0 flex-1">
          {/* Viewer avatar (logged-in user) or project avatar */}
          {createdByAvatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={createdByAvatarUrl}
              alt={createdByName ? `Profile photo of ${createdByName}` : ''}
              className="h-7 w-7 rounded-full object-cover shrink-0"
            />
          ) : viewerName ? (
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button className="shrink-0 rounded-full [@media(hover:hover)]:hover:ring-2 [@media(hover:hover)]:hover:ring-green-400/50 transition-all outline-none">
                  {/* Their picture, else initials on their own circle colour */}
                  <Avatar
                    src={viewerAvatarUrl}
                    name={viewerName}
                    color={viewerAvatarColor}
                    className="h-7 w-7 text-[10px] font-bold bg-green-600"
                  />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="start"
                  sideOffset={4}
                  className="z-50 w-56 rounded-lg border border-border bg-bg-elevated shadow-xl py-1 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
                >
                  <div className="px-3 py-2 border-b border-border">
                    <p className="text-sm font-medium text-text-primary">{viewerName}</p>
                  </div>
                  <DropdownMenu.Item
                    onSelect={() => {
                      // Ensure cookie is set from localStorage before navigating
                      if (typeof window !== 'undefined') {
                        const token = localStorage.getItem('ff_access_token')
                        if (token) {
                          document.cookie = `ff_access_token=${token}; path=/; max-age=${60 * 60 * 24 * 7}; SameSite=Lax`
                        }
                        window.location.href = withBasePath('/projects')
                      }
                    }}
                    className="flex items-center gap-2 px-3 py-2 text-sm text-text-primary hover:bg-bg-tertiary cursor-pointer outline-none transition-colors"
                  >
                    Back to Dashboard
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    onSelect={() => {
                      if (typeof window !== 'undefined') {
                        localStorage.removeItem('ff_access_token')
                        localStorage.removeItem('ff_refresh_token')
                        document.cookie = 'ff_access_token=; path=/; max-age=0'
                        window.location.href = withBasePath('/login')
                      }
                    }}
                    className="flex items-center gap-2 px-3 py-2 text-sm text-red-400 hover:bg-red-500/10 cursor-pointer outline-none transition-colors"
                  >
                    Log out
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          ) : (
            // The same mark the asset view shows once one is opened (#308).
            <ShareBrandMark theme={isDark ? 'dark' : 'light'} projectLogoUrl={branding?.logo_url} />
          )}

          {/* Location breadcrumb */}
          <nav className="flex min-w-0 items-center text-[13px] font-medium">
            {locationItems.map((item, index) => {
              const isCurrent = index === locationItems.length - 1
              return (
                <React.Fragment key={item.id ?? 'root'}>
                  {index > 0 && <span className="px-1.5 text-text-tertiary">/</span>}
                  <button
                    onClick={() => !isCurrent && navigateToBreadcrumb(index - 1)}
                    className={cn(
                      'truncate',
                      isCurrent
                        ? 'pointer-events-none text-text-primary'
                        : 'text-text-secondary hover:text-text-primary hover:underline',
                    )}
                  >
                    {item.name}
                  </button>
                </React.Fragment>
              )
            })}
          </nav>
        </div>

        {/* Right: Download All + panel toggle */}
        <div className="flex items-center gap-2 shrink-0">
          {allowDownload && (
            <button
              className="flex items-center gap-1.5 h-7 px-3 rounded-md text-xs font-medium text-text-inverse bg-accent hover:bg-accent-hover transition-colors"
              onClick={() => handleDownloadAll(token, currentSubfolderId ?? null, shareSession)}
            >
              <Download className="h-3 w-3" />
              Download All
            </button>
          )}
            <button
              onClick={() => setPanelOpen((v) => !v)}
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-bg-hover',
                panelOpen ? 'text-accent hover:text-accent' : 'text-text-secondary hover:text-text-primary',
              )}
              title={panelOpen ? 'Hide panel' : 'Show panel'}
          >
            {panelOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
          </button>
        </div>
      </header>

      {/* ─── Content area ──────────────────────────────────────────────── */}
      <div className="relative flex flex-1 overflow-hidden">
        {/* ─── Left: folder contents ─────────────────────────────────── */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Sub-header: title, summary, breadcrumb, search */}
          <div>
            {breadcrumbs.length === 0 && headerAppearance.url ? (
              <div className="relative mb-4 aspect-[16/4] min-h-24 overflow-hidden bg-bg-tertiary sm:min-h-28">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={headerAppearance.url}
                  alt=""
                  className="absolute inset-0 h-full w-full object-cover transition-transform duration-150"
                  style={{
                    objectPosition: `${headerAppearance.positionX}% ${headerAppearance.positionY}%`,
                    transform: `scale(${headerAppearance.zoom})`,
                    transformOrigin: `${headerAppearance.positionX}% ${headerAppearance.positionY}%`,
                  }}
                />
                <div
                  className={cn(
                    'absolute inset-0 bg-gradient-to-t',
                    isDark
                      ? 'from-bg-primary via-bg-primary/65 to-black/10'
                      : 'from-bg-primary via-bg-primary/80 to-bg-primary/10',
                  )}
                />
                <div className="absolute inset-x-0 bottom-0 p-4 sm:p-5">
                  <EditableShareTitle
                    value={title || folderName}
                    editable={editableHeader}
                    onCommit={onTitleCommit}
                    className="text-2xl font-bold leading-tight text-text-primary sm:text-3xl"
                  />
                  {!loading && (
                    <p className="mt-1.5 text-xs text-text-secondary">
                      {createdByName && <>Created by {createdByName} &middot; </>}
                      {summaryText || 'Empty folder'}
                    </p>
                  )}
                  <EditableShareDescription
                    value={description}
                    editable={editableHeader}
                    onCommit={onDescriptionCommit}
                    className="mt-1 max-w-2xl line-clamp-2 text-sm text-text-secondary"
                  />
                </div>
              </div>
            ) : (
              <div className="relative px-5 pt-4">
                <EditableShareTitle
                  value={title || folderName}
                  editable={editableHeader}
                  onCommit={onTitleCommit}
                  className="text-lg font-bold leading-tight text-text-primary"
                />
                <EditableShareDescription
                  value={description}
                  editable={editableHeader}
                  onCommit={onDescriptionCommit}
                  className="mt-1 text-sm text-text-secondary line-clamp-2"
                />
              </div>
            )}
            {!loading && !headerAppearance.url && (
              <div className="px-5 pt-3">
              <p className="mt-0.5 text-sm text-text-tertiary">
                {createdByName && <>Created by {createdByName} &middot; </>}
                {summaryText || 'Empty folder'}
              </p>
              </div>
            )}
          </div>

          {/* Main scrollable content */}
          <div className="flex-1 overflow-y-auto px-5 pb-5 pt-0">
            {loading ? (
              <div className="flex items-center justify-center py-24">
                <Loader2 className="h-8 w-8 animate-spin text-text-tertiary" />
              </div>
            ) : error ? (
              <div className="flex items-center justify-center py-24">
                <p className="text-sm text-text-tertiary">{error}</p>
              </div>
            ) : subfolders.length === 0 && assets.length === 0 ? (
              <>
                <div className="flex justify-end py-2">{searchBox}</div>
                <div className="flex flex-col items-center justify-center py-24 gap-3">
                  <Folder className="h-12 w-12 text-text-tertiary" />
                  <p className="text-sm text-text-tertiary">
                    {searchQuery.trim() ? 'No results found' : 'This folder is empty'}
                  </p>
                </div>
              </>
            ) : (
              <>
                {/* Where the search box sits depends only on what the folder
                    holds, never on what the query matches, so typing a query
                    that matches nothing does not remount (and blur) the box:
                    the Assets header, or the Folders header when the folder
                    holds no assets. */}
                {/* Subfolders section */}
                {subfolders.length > 0 && (filteredSubfolders.length > 0 || assets.length === 0) && (
                  <section className="mb-6">
                    <SectionHeader
                      label={filteredSubfolders.length === 1 ? 'Folder' : 'Folders'}
                      count={filteredSubfolders.length}
                      totalSize={totalFolderSize}
                      expanded={foldersExpanded}
                      onToggle={() => setFoldersExpanded((v) => !v)}
                      actions={assets.length === 0 ? searchBox : undefined}
                    />
                    {foldersExpanded && filteredSubfolders.length === 0 && (
                      <p className="py-8 text-center text-sm text-text-tertiary">No results found</p>
                    )}
                    {foldersExpanded && filteredSubfolders.length > 0 && (
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
                {assets.length > 0 && (
                  <section>
                    <SectionHeader
                      label={filteredAssets.length === 1 ? 'Asset' : 'Assets'}
                      count={filteredAssets.length}
                      totalSize={totalAssetSize}
                      expanded={assetsExpanded}
                      onToggle={() => setAssetsExpanded((v) => !v)}
                      actions={searchBox}
                    />

                    {assetsExpanded && (
                      <>
                        {filteredAssets.length === 0 ? (
                          <p className="py-8 text-center text-sm text-text-tertiary">No results found</p>
                        ) : isGridLayout ? (
                          <div className={cn('grid gap-3 mt-2', gridCols)}>
                            {filteredAssets.map((asset) => (
                              <SharedAssetCard
                                key={asset.id}
                                asset={{
                                  id: asset.id,
                                  name: asset.name,
                                  assetType: asset.asset_type,
                                  thumbnailUrl: asset.thumbnail_url,
                                  commentCount: asset.comment_count,
                                  versionCount: asset.version_count,
                                  durationSeconds: asset.duration_seconds,
                                  createdByName: asset.created_by_name,
                                  createdAt: asset.created_at,
                                  fileSize: asset.file_size,
                                }}
                                selected={selectedAsset?.id === asset.id}
                                onSelect={() => setSelectedAsset(asset)}
                                onOpen={openInViewer ? () => setViewingAsset(asset) : undefined}
                                onDownload={allowDownload ? () => handleDownload(token, asset.id, shareSession) : undefined}
                                aspectClass={aspectClass}
                                thumbnailScale={thumbnailScale}
                                showInfo={showCardInfo}
                                getVideoPreviewUrl={asset.asset_type === 'video'
                                  ? () => fetchSharePreviewUrl(token, asset.id, shareSession)
                                  : undefined}
                              />
                            ))}
                          </div>
                        ) : (
                          <div className="mt-2 rounded-lg border border-border overflow-hidden">
                            {/* Column headers */}
                            <div className="flex items-center gap-4 px-1 py-2 border-b border-border bg-bg-secondary/50 text-[10px] text-text-tertiary font-medium uppercase tracking-wider">
                              <div className="h-14 w-14 shrink-0" />
                              <div className="flex-1 min-w-0">Name</div>
                              <div className="hidden sm:block w-24 text-right shrink-0">Size</div>
                              <div className="hidden sm:block w-28 shrink-0">Date</div>
                              {allowDownload && <div className="w-7 shrink-0" />}
                            </div>
                            {filteredAssets.map((asset, i) => {
                              const TypeIcon = getAssetTypeIcon(asset.asset_type)
                              return (
                                <div
                                  key={asset.id}
                                  className={cn(
                                    'group flex items-center gap-4 py-2 px-1 cursor-pointer transition-colors [@media(hover:hover)]:hover:bg-bg-hover',
                                    selectedAsset?.id === asset.id && 'bg-accent/5',
                                    i !== filteredAssets.length - 1 && 'border-b border-border',
                                  )}
                                  onClick={() => setSelectedAsset(asset)}
                                  onDoubleClick={() => openInViewer && setViewingAsset(asset)}
                                  onPointerUp={(event) => {
                                    if (event.pointerType === 'touch' && openInViewer) setViewingAsset(asset)
                                  }}
                                >
                                  {/* Square thumbnail */}
                                  <ListRowThumb asset={asset} TypeIcon={TypeIcon} />
                                  {/* Name + meta */}
                                  <div className="flex-1 min-w-0">
                                    <p className="text-sm font-medium text-text-primary truncate leading-snug">{asset.name}</p>
                                    <p className="text-xs text-text-tertiary mt-0.5 truncate">
                                      {asset.created_by_name && <>{asset.created_by_name} &middot; </>}
                                      {formatShortDate(asset.created_at)}
                                    </p>
                                  </div>
                                  {/* File size */}
                                  <span className="hidden sm:block w-24 text-right text-sm text-text-tertiary tabular-nums shrink-0">
                                    {asset.file_size != null ? formatFileSize(asset.file_size) : '—'}
                                  </span>
                                  {/* Date */}
                                  <span className="hidden sm:block w-28 text-xs text-text-tertiary shrink-0">
                                    {formatDate(asset.created_at)}
                                  </span>
                                  {/* Download */}
                                  {allowDownload && (
                                    <DownloadMenu
                                      load={() => fetchShareDownloadOptions(token, asset.id, shareSession)}
                                      onPick={(rendition) => handleDownload(token, asset.id, shareSession, rendition)}
                                    >
                                      <button
                                        className="w-7 shrink-0 flex items-center justify-center h-7 rounded text-text-tertiary opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:hover:text-text-primary data-[state=open]:opacity-100 transition-all"
                                        onClick={(e) => e.stopPropagation()}
                                        onPointerUp={(e) => e.stopPropagation()}
                                        title="Download"
                                      >
                                        <Download className="h-4 w-4" />
                                      </button>
                                    </DownloadMenu>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                        )}

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

          {/* The project's footer text (branding, sent for every link type).
              This fork dropped the item-count footer, so the bar only shows
              when the project has footer text. */}
          {branding?.custom_footer && (
            <footer className="border-t border-border px-5 py-3 shrink-0">
              <p className="text-xs text-text-tertiary">{branding.custom_footer}</p>
            </footer>
          )}
        </div>

        {/* ─── Right Panel ───────────────────────────────────────────── */}
        {panelOpen && (
          <div className="w-full md:w-[320px] absolute inset-y-0 right-0 z-20 md:static md:inset-auto flex flex-col border-l-0 md:border-l border-border bg-bg-secondary shrink-0 overflow-hidden">
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
    </>
  )
}
