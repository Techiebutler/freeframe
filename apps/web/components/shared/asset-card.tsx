'use client'

import * as React from 'react'
import { Check, Download, Image as ImageIcon, Layers, MessageSquare, Music, Video } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FadeImage } from './fade-image'

export interface SharedAssetCardData {
  id: string
  name: string
  assetType: 'video' | 'audio' | 'image' | 'image_carousel' | string
  thumbnailUrl?: string | null
  commentCount?: number | null
  versionCount?: number | null
  durationSeconds?: number | null
  createdByName?: string | null
  createdAt?: string | null
  fileSize?: number | null
}

interface SharedAssetCardProps {
  asset: SharedAssetCardData
  selected?: boolean
  active?: boolean
  onSelect?: () => void
  onOpen?: () => void
  onToggleSelection?: () => void
  onDownload?: () => void
  draggable?: boolean
  onDragStart?: (event: React.DragEvent<HTMLDivElement>) => void
  actionMenu?: React.ReactNode
  /** Lazily resolves a playable stream when a video thumbnail is hovered. */
  getVideoPreviewUrl?: () => Promise<string | null>
  aspectClass?: string
  thumbnailScale?: 'fit' | 'fill'
  showInfo?: boolean
  showFileSize?: boolean
  showUploader?: boolean
  titleClassName?: string
  className?: string
}

const typeIcons: Record<string, React.ElementType> = {
  video: Video,
  audio: Music,
  image: ImageIcon,
  image_carousel: ImageIcon,
}

function formatDuration(seconds: number): string {
  const total = Math.floor(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function formatDate(value?: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days}d ago`
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/**
 * The canonical asset card for project and shared-link grids.
 * Context-specific controls are passed as optional slots so the card's visual
 * structure and media metadata never diverge between the two experiences.
 */
export function SharedAssetCard({
  asset,
  selected = false,
  active = false,
  onSelect,
  onOpen,
  onToggleSelection,
  onDownload,
  draggable = false,
  onDragStart,
  actionMenu,
  getVideoPreviewUrl,
  aspectClass = 'aspect-[16/10]',
  thumbnailScale = 'fill',
  showInfo = true,
  showFileSize = true,
  showUploader = true,
  titleClassName,
  className,
}: SharedAssetCardProps) {
  const Icon = typeIcons[asset.assetType] ?? Video
  const [imageFailed, setImageFailed] = React.useState(false)
  const date = formatDate(asset.createdAt)

  return (
    <div
      draggable={draggable}
      onDragStart={onDragStart}
      className={cn(
        'group flex flex-col overflow-hidden rounded-lg border bg-bg-tertiary transition-all',
        onSelect && 'cursor-pointer hover:bg-bg-hover',
        selected || active ? 'border-accent' : 'border-border hover:border-border-focus',
        className,
      )}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onPointerUp={(event) => {
        if (event.pointerType === 'touch') onOpen?.()
      }}
    >
      <div className={cn('relative w-full overflow-hidden bg-bg-tertiary', aspectClass)}>
        {asset.assetType === 'video' && asset.thumbnailUrl && !imageFailed && getVideoPreviewUrl ? (
          <ScrubbableVideoThumbnail
            thumbnailUrl={asset.thumbnailUrl}
            name={asset.name}
            thumbnailScale={thumbnailScale}
            getVideoPreviewUrl={getVideoPreviewUrl}
            onThumbnailError={() => setImageFailed(true)}
          />
        ) : asset.thumbnailUrl && !imageFailed ? (
          <FadeImage
            src={asset.thumbnailUrl}
            alt={asset.name}
            onError={() => setImageFailed(true)}
            className={cn(
              'h-full w-full transition-[transform,opacity] duration-200 group-hover:scale-[1.02]',
              thumbnailScale === 'fill' ? 'object-cover' : 'object-contain',
            )}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-hover text-text-secondary">
              <Icon className="h-7 w-7" />
            </div>
          </div>
        )}

        {onToggleSelection && (
          <button
            type="button"
            aria-label={selected ? `Deselect ${asset.name}` : `Select ${asset.name}`}
            onClick={(event) => {
              event.stopPropagation()
              onToggleSelection()
            }}
            className={cn(
              'absolute left-2 top-2 z-10 flex h-5 w-5 items-center justify-center rounded transition-all',
              selected
                ? 'bg-accent text-text-inverse'
                : 'bg-black/60 text-transparent backdrop-blur-sm group-hover:text-white/70',
            )}
          >
            <Check className="h-3.5 w-3.5" />
          </button>
        )}

        {(asset.commentCount ?? 0) > 0 && (
          <span className="absolute bottom-2 left-2 z-10 inline-flex h-6 min-w-11 items-center justify-center gap-1 rounded-md bg-black/85 px-1.5 text-[10px] font-medium text-white">
            <MessageSquare className="h-3 w-3" />
            {asset.commentCount}
          </span>
        )}

        {asset.durationSeconds != null && asset.durationSeconds > 0 && (
          <span className="absolute bottom-2 right-2 z-10 inline-flex h-6 min-w-11 items-center justify-center rounded-md bg-black/85 px-1.5 text-[10px] font-medium tabular-nums text-white">
            {formatDuration(asset.durationSeconds)}
          </span>
        )}

        {((asset.versionCount ?? 1) > 1 || onDownload) && (
          <div className="absolute right-2 top-2 z-10 flex items-center gap-1.5">
            {onDownload && (
              <button
                type="button"
                title="Download"
                onClick={(event) => {
                  event.stopPropagation()
                  onDownload()
                }}
                className="flex h-6 w-6 items-center justify-center rounded-md bg-black/85 text-white opacity-0 transition-opacity hover:bg-black group-hover:opacity-100"
              >
                <Download className="h-3 w-3" />
              </button>
            )}
            {(asset.versionCount ?? 1) > 1 && (
              <span className="inline-flex h-6 min-w-11 items-center justify-center gap-1 rounded-md bg-black/85 px-1.5 text-[10px] font-medium text-white">
                <Layers className="h-3 w-3" />
                {asset.versionCount}
              </span>
            )}
          </div>
        )}
      </div>

      {showInfo && (
        <div className="px-3 py-2.5">
          <div className="flex items-start gap-1">
            <p className={cn('min-w-0 flex-1 text-sm font-medium leading-tight text-text-primary line-clamp-1', titleClassName)}>
              {asset.name}
            </p>
            {actionMenu}
          </div>
          <p className="mt-0.5 truncate text-xs text-text-tertiary">
            {showUploader && asset.createdByName && <>{asset.createdByName} &middot; </>}
            {date}
            {showFileSize && asset.fileSize != null && <>&middot; {formatFileSize(asset.fileSize)}</>}
          </p>
        </div>
      )}
    </div>
  )
}

export function ScrubbableVideoThumbnail({
  thumbnailUrl,
  name,
  thumbnailScale,
  getVideoPreviewUrl,
  onThumbnailError,
}: {
  thumbnailUrl: string
  name: string
  thumbnailScale: 'fit' | 'fill'
  getVideoPreviewUrl: () => Promise<string | null>
  onThumbnailError: () => void
}) {
  const [hovering, setHovering] = React.useState(false)
  const [ready, setReady] = React.useState(false)
  const [ratio, setRatio] = React.useState(0)
  const videoRef = React.useRef<HTMLVideoElement>(null)
  const hlsRef = React.useRef<{ destroy: () => void } | null>(null)
  const seekFrameRef = React.useRef<number | null>(null)
  const queuedRatioRef = React.useRef(0)
  const streamUrlRef = React.useRef<string | null>(null)

  const teardown = React.useCallback(() => {
    if (seekFrameRef.current !== null) cancelAnimationFrame(seekFrameRef.current)
    seekFrameRef.current = null
    hlsRef.current?.destroy()
    hlsRef.current = null
    const video = videoRef.current
    if (video) {
      video.pause()
      video.removeAttribute('src')
      video.load()
    }
    setReady(false)
    setRatio(0)
  }, [])

  React.useEffect(() => {
    if (!hovering) {
      teardown()
      return
    }

    let cancelled = false
    const loadPreview = async () => {
      try {
        const streamUrl = streamUrlRef.current ?? await getVideoPreviewUrl()
        if (!streamUrl) return
        streamUrlRef.current = streamUrl
        const video = videoRef.current
        if (cancelled || !video) return

        if (!streamUrl.includes('.m3u8')) {
          video.src = streamUrl
          video.load()
          return
        }

        const { default: Hls } = await import('hls.js')
        if (cancelled || !videoRef.current) return
        if (Hls.isSupported()) {
          const hls = new Hls({ enableWorker: false, startLevel: 0, capLevelToPlayerSize: true })
          hls.loadSource(streamUrl)
          hls.attachMedia(videoRef.current)
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (!cancelled) setReady(true)
          })
          hlsRef.current = hls
        } else {
          videoRef.current.src = streamUrl
          videoRef.current.load()
        }
      } catch {
        // A static thumbnail remains usable if a preview stream is unavailable.
      }
    }
    void loadPreview()
    return () => { cancelled = true }
  }, [getVideoPreviewUrl, hovering, teardown])

  React.useEffect(() => () => teardown(), [teardown])

  const seekToRatio = (nextRatio: number) => {
    queuedRatioRef.current = nextRatio
    if (seekFrameRef.current !== null) return
    seekFrameRef.current = requestAnimationFrame(() => {
      seekFrameRef.current = null
      const video = videoRef.current
      if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return
      const nextTime = queuedRatioRef.current * video.duration
      try {
        if ('fastSeek' in video && typeof video.fastSeek === 'function') video.fastSeek(nextTime)
        else video.currentTime = nextTime
      } catch {}
    })
  }

  return (
    <div
      className="absolute inset-0 cursor-ew-resize"
      onPointerEnter={(event) => { if (event.pointerType === 'mouse') setHovering(true) }}
      onPointerLeave={() => setHovering(false)}
      onPointerMove={(event) => {
        if (event.pointerType !== 'mouse') return
        const bounds = event.currentTarget.getBoundingClientRect()
        const nextRatio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width))
        setRatio(nextRatio)
        if (ready) seekToRatio(nextRatio)
      }}
    >
      <FadeImage
        src={thumbnailUrl}
        alt={name}
        className={cn(
          'h-full w-full transition-[transform,opacity] duration-200 group-hover:scale-[1.02]',
          thumbnailScale === 'fill' ? 'object-cover' : 'object-contain',
          ready && 'opacity-0',
        )}
        onError={onThumbnailError}
      />
      {hovering && (
        <video
          ref={videoRef}
          muted
          playsInline
          preload="metadata"
          onLoadedMetadata={() => setReady(true)}
          className={cn(
            'absolute inset-0 h-full w-full bg-bg-tertiary opacity-0 transition-opacity duration-100',
            thumbnailScale === 'fill' ? 'object-cover' : 'object-contain',
            ready && 'opacity-100',
          )}
        />
      )}
      {hovering && ready && <span className="pointer-events-none absolute inset-y-0 z-0 w-px bg-accent" style={{ left: `${ratio * 100}%` }} />}
    </div>
  )
}
