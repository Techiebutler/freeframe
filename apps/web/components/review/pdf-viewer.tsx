'use client'

import * as React from 'react'
import { ChevronLeft, ChevronRight, FileText, Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import { withBasePath } from '@/lib/base-path'
import { loadPdfJs } from '@/lib/load-pdfjs'
import { useReview } from './review-provider'
import type { Asset, AssetVersion } from '@/types'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist/types/src/display/api'

interface PdfViewerProps {
  asset: Asset
  version: AssetVersion | null
  pageNumber: number
  onPageChange: (page: number) => void
  annotationCanvas?: React.ReactNode
}

interface PageSize {
  width: number
  height: number
}

/**
 * Renders one PDF page into an app-owned canvas. Keeping the PDF bitmap and
 * annotation layers in the same page-sized wrapper makes annotations scroll
 * and resize with the page instead of floating over a browser PDF iframe.
 */
export function PdfViewer({ asset, version, pageNumber, onPageChange, annotationCanvas }: PdfViewerProps) {
  const [url, setUrl] = React.useState<string | null>(null)
  const [document, setDocument] = React.useState<PDFDocumentProxy | null>(null)
  const [totalPages, setTotalPages] = React.useState(0)
  const [pageSize, setPageSize] = React.useState<PageSize | null>(null)
  const [availableWidth, setAvailableWidth] = React.useState(0)
  const [error, setError] = React.useState<string | null>(null)
  const [loadingDocument, setLoadingDocument] = React.useState(true)
  const [renderingPage, setRenderingPage] = React.useState(false)
  const viewportRef = React.useRef<HTMLDivElement>(null)
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const onPageChangeRef = React.useRef(onPageChange)
  const pageNumberRef = React.useRef(pageNumber)
  const { shareToken, shareSession } = useReview()
  const versionId = version?.id

  onPageChangeRef.current = onPageChange
  pageNumberRef.current = pageNumber

  React.useEffect(() => {
    if (!versionId) return
    let cancelled = false
    setLoadingDocument(true)
    setError(null)
    setUrl(null)
    setDocument(null)
    setTotalPages(0)
    setPageSize(null)

    const loadUrl = async () => {
      try {
        if (shareToken) {
          const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'
          const session = shareSession ? `&share_session=${encodeURIComponent(shareSession)}` : ''
          const response = await fetch(`${apiUrl}/share/${shareToken}/stream/${asset.id}?version_id=${versionId}${session}`)
          if (!response.ok) throw new Error('Failed to load PDF')
          const data = await response.json()
          if (!cancelled) setUrl(data.url)
        } else {
          const data = await api.get<{ url: string }>(`/assets/${asset.id}/stream?version_id=${versionId}`)
          if (!cancelled) setUrl(data.url)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load PDF')
          setLoadingDocument(false)
        }
      }
    }

    void loadUrl()
    return () => { cancelled = true }
  }, [asset.id, versionId, shareToken, shareSession])

  React.useEffect(() => {
    if (!url) return

    let cancelled = false
    let loadingTask: ReturnType<typeof import('pdfjs-dist')['getDocument']> | null = null
    let loadedDocument: PDFDocumentProxy | null = null

    const loadDocument = async () => {
      try {
        const assetsBase = withBasePath('/pdfjs')
        const pdfjs = await loadPdfJs(assetsBase)
        if (cancelled) return
        pdfjs.GlobalWorkerOptions.workerSrc = `${assetsBase}/pdf.worker.min.mjs`
        const task = pdfjs.getDocument({
          url,
          cMapUrl: `${assetsBase}/cmaps/`,
          cMapPacked: true,
          standardFontDataUrl: `${assetsBase}/standard_fonts/`,
          wasmUrl: `${assetsBase}/wasm/`,
        })
        loadingTask = task
        loadedDocument = await task.promise
        if (cancelled) return

        setDocument(loadedDocument)
        setTotalPages(loadedDocument.numPages)
        setLoadingDocument(false)

        const requestedPage = pageNumberRef.current
        const clampedPage = Math.min(Math.max(1, requestedPage), loadedDocument.numPages)
        if (clampedPage !== requestedPage) onPageChangeRef.current(clampedPage)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load PDF')
          setLoadingDocument(false)
        }
      }
    }

    void loadDocument()
    return () => {
      cancelled = true
      if (loadedDocument) void loadedDocument.destroy()
      else void loadingTask?.destroy()
    }
  }, [url]) // page changes must not reload the whole document

  React.useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return

    const syncWidth = () => setAvailableWidth(viewport.clientWidth)
    syncWidth()

    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(syncWidth)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [loadingDocument, error])

  React.useEffect(() => {
    if (!document || !availableWidth || !canvasRef.current) return

    let cancelled = false
    let renderTask: RenderTask | null = null
    setRenderingPage(true)
    setError(null)

    const renderPage = async () => {
      try {
        const page = await document.getPage(pageNumber)
        if (cancelled || !canvasRef.current) return

        const baseViewport = page.getViewport({ scale: 1 })
        const cssWidth = Math.max(1, availableWidth - 32)
        const viewport = page.getViewport({ scale: cssWidth / baseViewport.width })
        const outputScale = window.devicePixelRatio || 1
        const canvas = canvasRef.current
        const context = canvas.getContext('2d')
        if (!context) throw new Error('Unable to render PDF page')

        const nextSize = {
          width: Math.floor(viewport.width),
          height: Math.floor(viewport.height),
        }
        setPageSize(nextSize)
        canvas.width = Math.floor(viewport.width * outputScale)
        canvas.height = Math.floor(viewport.height * outputScale)
        canvas.style.width = `${nextSize.width}px`
        canvas.style.height = `${nextSize.height}px`

        renderTask = page.render({
          canvas,
          canvasContext: context,
          viewport,
          transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined,
        })
        await renderTask.promise
        if (!cancelled) setRenderingPage(false)
      } catch (err) {
        if (cancelled || (err as { name?: string })?.name === 'RenderingCancelledException') return
        setError(err instanceof Error ? err.message : 'Failed to render PDF page')
        setRenderingPage(false)
      }
    }

    void renderPage()
    return () => {
      cancelled = true
      renderTask?.cancel()
    }
  }, [document, pageNumber, availableWidth])

  const setPage = (next: number) => {
    const maximum = totalPages || Number.MAX_SAFE_INTEGER
    onPageChange(Math.min(Math.max(1, next), maximum))
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-bg-primary">
      <div className="absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-1 rounded-md border border-border bg-bg-secondary/95 p-1 shadow-lg">
        <button title="Previous page" className="rounded p-1 hover:bg-bg-hover disabled:opacity-40" disabled={pageNumber <= 1 || loadingDocument} onClick={() => setPage(pageNumber - 1)}><ChevronLeft className="h-4 w-4" /></button>
        <label className="flex items-center gap-1 px-1 text-xs text-text-secondary">
          Page
          <input
            aria-label="PDF page"
            className="w-10 rounded border border-border bg-bg-tertiary px-1 py-0.5 text-center text-text-primary"
            min="1"
            max={totalPages || undefined}
            type="number"
            value={pageNumber}
            onChange={(event) => setPage(Number(event.target.value) || 1)}
          />
          {totalPages > 0 && <span aria-label="PDF page count">of {totalPages}</span>}
        </label>
        <button title="Next page" className="rounded p-1 hover:bg-bg-hover disabled:opacity-40" disabled={loadingDocument || (totalPages > 0 && pageNumber >= totalPages)} onClick={() => setPage(pageNumber + 1)}><ChevronRight className="h-4 w-4" /></button>
      </div>

      <div ref={viewportRef} data-testid="pdf-scroll-viewport" className="min-h-0 flex-1 overflow-auto px-4 pb-4 pt-14">
        {error ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-text-tertiary"><FileText className="h-8 w-8" /><span className="text-sm">{error}</span></div>
        ) : (
          <div
            key={`${version?.id ?? 'none'}-${pageNumber}`}
            data-testid="pdf-page-surface"
            className="relative mx-auto bg-white shadow-lg"
            style={pageSize ? { width: pageSize.width, height: pageSize.height } : { width: '100%', minHeight: 1 }}
          >
            <canvas ref={canvasRef} data-testid="pdf-page-canvas" className="block" />
            {pageSize && annotationCanvas}
            {(loadingDocument || renderingPage) && (
              <div className="absolute inset-0 z-20 flex items-center justify-center bg-bg-primary/60"><Loader2 className="h-7 w-7 animate-spin text-text-tertiary" /></div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
