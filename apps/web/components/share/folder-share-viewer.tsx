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
      className="group flex flex-col rounded-lg border border-white/[0.08] bg-white/[0.02] overflow-hidden text-left transition-all cursor-pointer hover:border-white/[0.15] hover:bg-white/[0.04]"
      onClick={() => onClick(subfolder)}
    >
      {/* Thumbnail area */}
      <div className="w-full aspect-[16/10] relative overflow-hidden bg-zinc-900/50">
        {thumbs.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <Folder className="h-10 w-10 text-zinc-600" />
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
        {/* Download icon */}
        <div className="absolute bottom-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
          <div className="flex items-center justify-center h-6 w-6 rounded-md bg-black/60 backdrop-blur-sm">
            <Download className="h-3 w-3 text-white" />
          </div>
        </div>
      </div>

      {/* Info */}
      <div className="px-3 py-2.5">
        <p className="text-sm font-medium text-white truncate">{subfolder.name}</p>
        <p className="text-xs text-zinc-500 mt-0.5">
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
}

function AssetGridCard({ asset, allowDownload, token, isSelected, onSelect }: AssetGridCardProps) {
  const TypeIcon = getAssetTypeIcon(asset.asset_type)

  return (
    <div
      className={cn(
        'group flex flex-col rounded-lg border overflow-hidden transition-all cursor-pointer',
        isSelected
          ? 'border-indigo-500/60 ring-1 ring-indigo-500/40'
          : 'border-white/[0.08] hover:border-white/[0.15]',
        'bg-white/[0.02] hover:bg-white/[0.04]',
      )}
      onClick={() => onSelect(asset)}
    >
      {/* Thumbnail */}
      <div className="w-full aspect-[16/10] relative overflow-hidden bg-zinc-900/50">
        {asset.thumbnail_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={asset.thumbnail_url}
            alt={asset.name}
            className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <TypeIcon className="h-10 w-10 text-zinc-600" />
          </div>
        )}

        {/* Comment count badge — bottom left */}
        {asset.comment_count > 0 && (
          <div className="absolute bottom-2 left-2 flex items-center gap-1 bg-black/70 backdrop-blur-sm rounded-md px-1.5 py-0.5">
            <MessageSquare className="h-3 w-3 text-white" />
            <span className="text-[10px] font-medium text-white">{asset.comment_count}</span>
          </div>
        )}

        {/* Duration badge — bottom right (video/audio) */}
        {asset.duration_seconds != null && asset.duration_seconds > 0 && (
          <div className="absolute bottom-2 right-2 bg-black/70 backdrop-blur-sm rounded-md px-1.5 py-0.5">
            <span className="text-[10px] font-medium text-white tabular-nums">
              {formatDuration(asset.duration_seconds)}
            </span>
          </div>
        )}

        {/* Download button overlay */}
        {allowDownload && (
          <button
            className="absolute top-2 right-2 flex items-center justify-center h-6 w-6 rounded-md bg-black/60 hover:bg-black/80 text-white backdrop-blur-sm opacity-0 group-hover:opacity-100 transition-opacity"
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
      <div className="px-3 py-2.5">
        <p className="text-sm font-medium text-white line-clamp-1">{asset.name}</p>
        <p className="text-xs text-zinc-500 mt-0.5 truncate">
          {asset.created_by_name && <>{asset.created_by_name} &middot; </>}
          {formatShortDate(asset.created_at)}
          {asset.file_size != null && <> &middot; {formatFileSize(asset.file_size)}</>}
        </p>
      </div>
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
        className={cn('h-4 w-4 shrink-0 transition-transform text-zinc-500', !expanded && '-rotate-90')}
      />
      <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
        {count} {label}
      </span>
      {totalSize && (
        <span className="text-xs text-zinc-600">&middot; {totalSize}</span>
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
}

interface GuestComment {
  id: string
  body: string
  guest_name: string
  guest_email: string
  created_at: string
  timecode_start?: number | null
}

function RightPanel({ selectedAsset, token, permission, allowDownload }: RightPanelProps) {
  const [comments, setComments] = React.useState<GuestComment[]>([])
  const [loadingComments, setLoadingComments] = React.useState(false)

  React.useEffect(() => {
    if (!selectedAsset) {
      setComments([])
      return
    }
    setLoadingComments(true)
    fetch(`${API_URL}/share/${token}/comments?asset_id=${selectedAsset.id}`)
      .then((r) => (r.ok ? r.json() : Promise.resolve({ comments: [] })))
      .then((data) => setComments(data.comments ?? []))
      .catch(() => setComments([]))
      .finally(() => setLoadingComments(false))
  }, [selectedAsset?.id, token])

  if (!selectedAsset) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
        <div className="h-14 w-14 rounded-full bg-white/5 flex items-center justify-center mb-3">
          <MessageSquare className="h-7 w-7 text-zinc-600" />
        </div>
        <p className="text-sm font-medium text-zinc-300">Select an asset to view details</p>
      </div>
    )
  }

  const TypeIcon = getAssetTypeIcon(selectedAsset.asset_type)

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Asset info header */}
      <div className="px-4 py-4 border-b border-white/[0.06] shrink-0">
        <div className="flex items-center gap-2 mb-2">
          <TypeIcon className="h-4 w-4 text-zinc-400 shrink-0" />
          <span className="text-xs text-zinc-400 uppercase font-medium">
            {getAssetTypeBadgeLabel(selectedAsset.asset_type)}
          </span>
        </div>
        <h3 className="text-sm font-semibold text-white leading-snug">{selectedAsset.name}</h3>
        <div className="mt-2 space-y-1">
          {selectedAsset.created_by_name && (
            <p className="text-xs text-zinc-500">By {selectedAsset.created_by_name}</p>
          )}
          <p className="text-xs text-zinc-500">
            {formatDate(selectedAsset.created_at)}
            {selectedAsset.file_size != null && <> &middot; {formatFileSize(selectedAsset.file_size)}</>}
            {selectedAsset.duration_seconds != null && selectedAsset.duration_seconds > 0 && (
              <> &middot; {formatDuration(selectedAsset.duration_seconds)}</>
            )}
          </p>
        </div>

        {/* Download button */}
        {allowDownload && (
          <button
            className="mt-3 flex items-center gap-2 text-xs font-medium text-zinc-300 hover:text-white transition-colors"
            onClick={() => handleDownload(token, selectedAsset.id, selectedAsset.name)}
          >
            <Download className="h-3.5 w-3.5" />
            Download
          </button>
        )}
      </div>

      {/* Comments section */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-4 py-3 border-b border-white/[0.06]">
          <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
            Comments ({comments.length})
          </h4>
        </div>

        {loadingComments ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-zinc-500" />
          </div>
        ) : comments.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 px-6 text-center">
            <MessageSquare className="h-8 w-8 text-zinc-700 mb-2" />
            <p className="text-xs text-zinc-500">No comments yet</p>
          </div>
        ) : (
          <div className="px-4 py-3 space-y-2.5">
            {comments.map((comment) => (
              <div
                key={comment.id}
                className="rounded-lg bg-white/[0.03] border border-white/5 px-3 py-2.5"
              >
                <div className="flex items-center gap-2 mb-1.5">
                  <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-purple-500/20 text-[10px] font-medium text-purple-400">
                    {comment.guest_name.charAt(0).toUpperCase()}
                  </div>
                  <span className="text-xs font-medium text-zinc-200">{comment.guest_name}</span>
                  {comment.timecode_start != null && (
                    <span className="text-[10px] text-zinc-500 font-mono bg-white/5 px-1.5 py-0.5 rounded">
                      {Math.floor(comment.timecode_start / 60)}:
                      {String(Math.floor(comment.timecode_start % 60)).padStart(2, '0')}
                    </span>
                  )}
                  <span className="ml-auto text-[10px] text-zinc-600">
                    {formatShortDate(comment.created_at)}
                  </span>
                </div>
                <p className="text-sm text-zinc-300 leading-relaxed">{comment.body}</p>
              </div>
            ))}
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
  const [selectedAsset, setSelectedAsset] = React.useState<FolderShareAssetItem | null>(null)

  const [assets, setAssets] = React.useState<FolderShareAssetItem[]>([])
  const [subfolders, setSubfolders] = React.useState<FolderShareSubfolder[]>([])
  const [total, setTotal] = React.useState(0)
  const [page, setPage] = React.useState(1)
  const [loading, setLoading] = React.useState(true)
  const [loadingMore, setLoadingMore] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const accentColor = appearance.accent_color ?? branding?.primary_color ?? '#6366f1'
  const perPage = 24

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

  return (
    <div className="flex-1 min-h-screen flex flex-col bg-[#0d0d0f] text-white">
      {/* ─── Top Bar (Frame.io style) ─────────────────────────────────── */}
      <header className="flex items-center justify-between border-b border-white/[0.06] px-4 h-12 bg-[#111113] shrink-0">
        {/* Left: avatar + breadcrumb */}
        <div className="flex items-center gap-3 min-w-0 flex-1">
          {/* Project avatar */}
          {branding?.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={branding.logo_url}
              alt=""
              className="h-7 w-7 rounded-full object-cover shrink-0"
            />
          ) : (
            <div
              className="flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-bold text-white shrink-0"
              style={{ backgroundColor: accentColor }}
            >
              {(branding?.custom_title ?? folderName ?? 'FF').substring(0, 2).toUpperCase()}
            </div>
          )}

          {/* Breadcrumb */}
          <span className="text-[13px] font-medium text-white truncate">{currentTitle}</span>
        </div>

        {/* Right: Download All + panel toggle */}
        <div className="flex items-center gap-2 shrink-0">
          {allowDownload && (
            <button
              className="flex items-center gap-1.5 h-7 px-3 rounded-md text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 transition-colors"
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
            className="flex items-center justify-center h-7 w-7 rounded-md text-zinc-400 hover:text-white hover:bg-white/10 transition-colors"
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
          <div className="border-b border-white/[0.06] px-5 py-4">
            <h1 className="text-lg font-bold text-white leading-tight">{title || folderName}</h1>
            {!loading && (
              <p className="mt-0.5 text-sm text-zinc-500">
                {createdByName && <>Created by {createdByName} &middot; </>}
                {summaryText || 'Empty folder'}
              </p>
            )}

            {/* Breadcrumb + Search row */}
            <div className="flex items-center gap-3 mt-3 flex-wrap">
              <nav className="flex items-center gap-1 text-sm flex-1 min-w-0">
                <button
                  className={cn(
                    'shrink-0 font-medium hover:underline text-zinc-400 hover:text-white',
                    breadcrumbs.length === 0 && 'text-white pointer-events-none',
                  )}
                  onClick={() => navigateToBreadcrumb(-1)}
                >
                  Root
                </button>
                {breadcrumbs.map((crumb, i) => (
                  <React.Fragment key={crumb.id}>
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
                    <button
                      className={cn(
                        'truncate max-w-[160px] hover:underline',
                        i === breadcrumbs.length - 1
                          ? 'text-white font-medium pointer-events-none'
                          : 'text-zinc-400 hover:text-white',
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
                <Search className="absolute left-2.5 h-3.5 w-3.5 pointer-events-none text-zinc-500" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search assets…"
                  className="h-8 w-52 pl-8 pr-3 rounded-md text-sm border bg-zinc-900/50 border-white/[0.08] text-white placeholder:text-zinc-600 focus:outline-none focus:border-white/[0.15]"
                />
              </div>
            </div>
          </div>

          {/* Main scrollable content */}
          <div className="flex-1 overflow-y-auto px-5 py-5">
            {loading ? (
              <div className="flex items-center justify-center py-24">
                <Loader2 className="h-8 w-8 animate-spin text-zinc-500" />
              </div>
            ) : error ? (
              <div className="flex items-center justify-center py-24">
                <p className="text-sm text-zinc-500">{error}</p>
              </div>
            ) : filteredSubfolders.length === 0 && filteredAssets.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-24 gap-3">
                <Folder className="h-12 w-12 text-zinc-700" />
                <p className="text-sm text-zinc-500">
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
                      <div className="grid gap-3 mt-2 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
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
                        <div className="grid gap-3 mt-2 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                          {filteredAssets.map((asset) => (
                            <AssetGridCard
                              key={asset.id}
                              asset={asset}
                              allowDownload={allowDownload}
                              token={token}
                              isSelected={selectedAsset?.id === asset.id}
                              onSelect={setSelectedAsset}
                            />
                          ))}
                        </div>

                        {/* Load more */}
                        {hasMore && (
                          <div className="flex justify-center mt-6">
                            <button
                              onClick={loadMore}
                              disabled={loadingMore}
                              className="flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-medium border border-white/10 text-zinc-300 hover:bg-white/5 hover:border-white/20 disabled:opacity-50 transition-colors"
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
          <footer className="border-t border-white/[0.06] px-5 py-3 shrink-0">
            <div className="flex items-center justify-between">
              {branding?.custom_footer ? (
                <p className="text-xs text-zinc-600">{branding.custom_footer}</p>
              ) : (
                <span />
              )}
              {!loading && (
                <p className="text-xs tabular-nums text-zinc-600">
                  {assets.length + subfolders.length} item{assets.length + subfolders.length === 1 ? '' : 's'}
                </p>
              )}
            </div>
          </footer>
        </div>

        {/* ─── Right Panel ───────────────────────────────────────────── */}
        {panelOpen && (
          <div className="w-[320px] shrink-0 border-l border-white/[0.06] bg-[#111113] flex flex-col overflow-hidden">
            <RightPanel
              selectedAsset={selectedAsset}
              token={token}
              permission={permission}
              allowDownload={allowDownload}
            />
          </div>
        )}
      </div>
    </div>
  )
}
