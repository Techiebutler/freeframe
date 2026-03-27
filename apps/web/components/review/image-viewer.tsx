'use client'

import * as React from 'react'
import Image from 'next/image'
import {
  TransformWrapper,
  TransformComponent,
  useControls,
} from 'react-zoom-pan-pinch'
import {
  ZoomIn,
  ZoomOut,
  Maximize2,
  Scan,
  ChevronLeft,
  ChevronRight,
  Loader2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { useReviewStore } from '@/stores/review-store'
import type { Asset, AssetVersion, MediaFile } from '@/types'

// ─── Types ────────────────────────────────────────────────────────────────────

interface StreamResponse {
  url: string
}

// AssetVersion already has files?: MediaFile[]
type VersionWithFiles = AssetVersion

// ─── Zoom Controls ────────────────────────────────────────────────────────────

function ZoomControls() {
  const { zoomIn, zoomOut, resetTransform, centerView } = useControls()

  return (
    <div className="absolute bottom-4 right-4 z-10 flex flex-col gap-1">
      <button
        onClick={() => zoomIn()}
        className="flex h-8 w-8 items-center justify-center rounded bg-bg-elevated/90 text-text-secondary backdrop-blur-sm transition-colors hover:bg-bg-hover hover:text-text-primary border border-border"
        title="Zoom in"
      >
        <ZoomIn className="h-4 w-4" />
      </button>
      <button
        onClick={() => zoomOut()}
        className="flex h-8 w-8 items-center justify-center rounded bg-bg-elevated/90 text-text-secondary backdrop-blur-sm transition-colors hover:bg-bg-hover hover:text-text-primary border border-border"
        title="Zoom out"
      >
        <ZoomOut className="h-4 w-4" />
      </button>
      <button
        onClick={() => centerView(1)}
        className="flex h-8 w-8 items-center justify-center rounded bg-bg-elevated/90 text-text-secondary backdrop-blur-sm transition-colors hover:bg-bg-hover hover:text-text-primary border border-border"
        title="Actual size"
      >
        <Scan className="h-4 w-4" />
      </button>
      <button
        onClick={() => resetTransform()}
        className="flex h-8 w-8 items-center justify-center rounded bg-bg-elevated/90 text-text-secondary backdrop-blur-sm transition-colors hover:bg-bg-hover hover:text-text-primary border border-border"
        title="Fit to screen"
      >
        <Maximize2 className="h-4 w-4" />
      </button>
    </div>
  )
}

// ─── Single Image View ─────────────────────────────────────────────────────────

interface SingleImageProps {
  url: string
  alt: string
  containerRef: React.RefObject<HTMLDivElement>
  onImageLoad: (width: number, height: number) => void
}

function SingleImage({ url, alt, containerRef, onImageLoad, annotationOverlay, isDrawingMode }: SingleImageProps & { annotationOverlay?: React.ReactNode; isDrawingMode?: boolean }) {
  const imgRef = React.useRef<HTMLImageElement>(null)

  const handleLoad = () => {
    const img = imgRef.current
    if (img) {
      onImageLoad(img.naturalWidth, img.naturalHeight)
    }
  }

  return (
    <div ref={containerRef} className="relative inline-flex items-center justify-center">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={imgRef}
        src={url}
        alt={alt}
        onLoad={handleLoad}
        className="max-w-full max-h-full object-contain select-none"
        draggable={false}
      />
      {/* Annotation overlay — positioned on top of the image, moves with zoom/pan */}
      {annotationOverlay && (
        <div
          className="absolute inset-0"
          style={{ pointerEvents: isDrawingMode ? 'auto' : 'none' }}
        >
          {annotationOverlay}
        </div>
      )}
    </div>
  )
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

function ImageSkeleton() {
  return (
    <div className="flex h-full w-full items-center justify-center bg-bg-secondary">
      <div className="flex flex-col items-center gap-3">
        <Loader2 className="h-8 w-8 animate-spin text-text-tertiary" />
        <p className="text-sm text-text-tertiary">Loading image…</p>
      </div>
    </div>
  )
}

// ─── Main Component ────────────────────────────────────────────────────────────

interface ImageViewerProps {
  asset: Asset
  version: VersionWithFiles | null
  className?: string
  /** Optional: rendered on top of the image for annotations */
  annotationCanvas?: React.ReactNode
}

export function ImageViewer({ asset, version, className, annotationCanvas }: ImageViewerProps) {
  const { isDrawingMode, setFocusedCommentId, setActiveAnnotation } = useReviewStore()

  const handleImageClick = () => {
    if (!isDrawingMode) {
      setFocusedCommentId(null)
      setActiveAnnotation(null)
    }
  }

  // For carousel: track current position
  const [carouselIndex, setCarouselIndex] = React.useState(0)

  // Presigned stream URLs indexed by media_file id (or 'single')
  const [imageUrls, setImageUrls] = React.useState<Record<string, string>>({})
  const [isLoading, setIsLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  // Displayed image natural dimensions (used to size the annotation canvas)
  const [imageDimensions, setImageDimensions] = React.useState<{ w: number; h: number } | null>(
    null,
  )

  const containerRef = React.useRef<HTMLDivElement>(null)

  // Sorted carousel media files
  const mediaFiles = React.useMemo<MediaFile[]>(() => {
    if (!version?.files) return []
    return [...version.files].sort((a, b) => (a.sequence_order ?? 0) - (b.sequence_order ?? 0))
  }, [version])

  const isCarousel = asset.asset_type === 'image_carousel'
  const totalImages = isCarousel ? mediaFiles.length : 1

  // Fetch stream URL(s)
  React.useEffect(() => {
    if (!version) return

    let cancelled = false

    const fetchUrls = async () => {
      setIsLoading(true)
      setError(null)

      try {
        if (isCarousel) {
          // Fetch a presigned URL for each carousel image
          const entries = await Promise.all(
            mediaFiles.map(async (mf) => {
              const data = await api.get<StreamResponse>(
                `/assets/${asset.id}/stream?media_file_id=${mf.id}&version_id=${version.id}`,
              )
              return [mf.id, data.url] as [string, string]
            }),
          )
          if (!cancelled) {
            setImageUrls(Object.fromEntries(entries))
          }
        } else {
          const data = await api.get<StreamResponse>(`/assets/${asset.id}/stream?version_id=${version.id}`)
          if (!cancelled) {
            setImageUrls({ single: data.url })
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load image')
        }
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    fetchUrls()
    return () => {
      cancelled = true
    }
  }, [asset.id, version, isCarousel, mediaFiles])

  // Reset carousel index when version changes
  React.useEffect(() => {
    setCarouselIndex(0)
  }, [version?.id])

  // Current URL to display
  const currentUrl = React.useMemo(() => {
    if (isCarousel) {
      const file = mediaFiles[carouselIndex]
      return file ? imageUrls[file.id] : undefined
    }
    return imageUrls['single']
  }, [isCarousel, mediaFiles, carouselIndex, imageUrls])

  const handlePrev = () => setCarouselIndex((i) => Math.max(0, i - 1))
  const handleNext = () => setCarouselIndex((i) => Math.min(totalImages - 1, i + 1))

  const handleImageLoad = (w: number, h: number) => {
    setImageDimensions({ w, h })
  }

  if (isLoading) {
    return <ImageSkeleton />
  }

  if (error) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-bg-secondary">
        <p className="text-sm text-status-error">{error}</p>
      </div>
    )
  }

  if (!currentUrl) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-bg-secondary">
        <p className="text-sm text-text-tertiary">No image available</p>
      </div>
    )
  }

  return (
    <div className={cn('relative flex h-full w-full flex-col overflow-hidden bg-bg-primary', className)}>
      {/* Zoom/pan area — click to deselect comment & hide annotation */}
      <div className="relative flex-1 overflow-hidden" onClick={handleImageClick}>
        <TransformWrapper
          key={currentUrl}
          initialScale={1}
          minScale={0.1}
          maxScale={10}
          centerOnInit
          wheel={{ step: 0.08 }}
          pinch={{ step: 5 }}
          disabled={isDrawingMode}
        >
          {() => (
            <>
              <TransformComponent
                wrapperStyle={{ width: '100%', height: '100%' }}
                contentStyle={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                <SingleImage
                  url={currentUrl}
                  alt={asset.name}
                  containerRef={containerRef}
                  onImageLoad={handleImageLoad}
                  annotationOverlay={annotationCanvas}
                  isDrawingMode={isDrawingMode}
                />
              </TransformComponent>

              <ZoomControls />
            </>
          )}
        </TransformWrapper>
      </div>

      {/* Carousel navigation */}
      {isCarousel && totalImages > 1 && (
        <div className="flex shrink-0 items-center justify-center gap-3 border-t border-border bg-bg-secondary px-4 py-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={handlePrev}
            disabled={carouselIndex === 0}
            className="h-7 w-7 p-0"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>

          <span className="text-sm text-text-secondary tabular-nums">
            {carouselIndex + 1} / {totalImages}
          </span>

          <Button
            variant="ghost"
            size="sm"
            onClick={handleNext}
            disabled={carouselIndex === totalImages - 1}
            className="h-7 w-7 p-0"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>

          {/* Dot indicators */}
          <div className="flex gap-1">
            {Array.from({ length: totalImages }).map((_, i) => (
              <button
                key={i}
                onClick={() => setCarouselIndex(i)}
                className={cn(
                  'h-1.5 w-1.5 rounded-full transition-colors',
                  i === carouselIndex ? 'bg-accent' : 'bg-bg-hover hover:bg-text-tertiary',
                )}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
