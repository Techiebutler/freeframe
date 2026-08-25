'use client'

import * as React from 'react'
import { BookOpen, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { clearDrawingCanvas } from '@/hooks/use-drawing'
import { useReviewStore } from '@/stores/review-store'

interface PdfViewerProps {
  url: string | null
  name: string
  page: number
  onPageChange: (page: number) => void
  spreadRequest?: number
  annotationCanvas?: React.ReactNode
}

/** PDF review surface with optional two-page spread viewing. */
export function PdfViewer({ url, name, page, onPageChange, spreadRequest, annotationCanvas }: PdfViewerProps) {
  const canvasRefs = [React.useRef<HTMLCanvasElement>(null), React.useRef<HTMLCanvasElement>(null)]
  const viewportRef = React.useRef<HTMLDivElement>(null)
  const [pdf, setPdf] = React.useState<any>(null)
  const [pageCount, setPageCount] = React.useState(0)
  const [size, setSize] = React.useState({ width: 0, height: 0 })
  const [error, setError] = React.useState<string | null>(null)
  const [spread, setSpread] = React.useState(false)
  React.useEffect(() => { if (spreadRequest) setSpread(true) }, [spreadRequest])
  const { isDrawingMode, setActiveAnnotation, setFocusedCommentId, setPendingAnnotation } = useReviewStore()

  const changePage = React.useCallback((nextPage: number) => {
    // The Fabric canvas is shared across review surfaces. A page navigation must
    // never let an unsaved mark bleed onto a different PDF page.
    clearDrawingCanvas()
    setPendingAnnotation(null)
    setActiveAnnotation(null)
    setFocusedCommentId(null)
    onPageChange(nextPage)
  }, [onPageChange, setActiveAnnotation, setFocusedCommentId, setPendingAnnotation])

  React.useEffect(() => {
    if (!url) return
    let cancelled = false
    setPdf(null); setPageCount(0); setError(null)
    import('pdfjs-dist').then(async ({ getDocument, GlobalWorkerOptions }) => {
      GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'
      const document = await getDocument(url).promise
      if (!cancelled) { setPdf(document); setPageCount(document.numPages) }
    }).catch(() => { if (!cancelled) setError('Unable to load PDF') })
    return () => { cancelled = true }
  }, [url])

  React.useEffect(() => {
    if (!viewportRef.current) return
    const observer = new ResizeObserver(() => setSize({ width: viewportRef.current!.clientWidth, height: viewportRef.current!.clientHeight }))
    observer.observe(viewportRef.current)
    return () => observer.disconnect()
  }, [])

  React.useEffect(() => {
    if (!pdf || !size.width || !size.height) return
    let cancelled = false
    const tasks: any[] = []
    const pages = spread && page < pageCount ? [page, page + 1] : [page]
    Promise.all(pages.map(async (pageNumber, index) => {
      const canvas = canvasRefs[index].current
      if (!canvas) return
      const pdfPage = await pdf.getPage(pageNumber)
      if (cancelled) return
      const natural = pdfPage.getViewport({ scale: 1 })
      const availableWidth = spread ? (size.width - 48) / 2 : size.width - 32
      const scale = Math.min(availableWidth / natural.width, (size.height - 64) / natural.height)
      const viewport = pdfPage.getViewport({ scale: Math.max(scale, 0.1) })
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      const task = pdfPage.render({ canvasContext: canvas.getContext('2d')!, viewport })
      tasks.push(task)
      await task.promise
    })).catch(() => { if (!cancelled) setError('Unable to render PDF page') })
    return () => { cancelled = true; tasks.forEach((task) => task.cancel()) }
  }, [pdf, page, pageCount, size, spread])

  React.useEffect(() => {
    if (pageCount && page > pageCount) changePage(pageCount)
  }, [changePage, page, pageCount])

  if (error) return <div className="flex flex-1 items-center justify-center text-sm text-status-error">{error}</div>

  return (
    <div ref={viewportRef} className="relative flex flex-1 min-h-0 items-center justify-center overflow-auto bg-bg-primary p-4" onClick={() => {
      if (!isDrawingMode) { setFocusedCommentId(null); setActiveAnnotation(null) }
    }}>
      {!pdf && <Loader2 className="h-8 w-8 animate-spin text-text-tertiary" />}
      <div className={cn('relative flex items-center gap-4', spread && 'max-w-full', !pdf && 'hidden')}>
        {[page, ...(spread && page < pageCount ? [page + 1] : [])].map((pageNumber, index) => (
          <div key={pageNumber} className="relative shrink-0 shadow-lg">
            <canvas ref={canvasRefs[index]} aria-label={`${name}, page ${pageNumber}`} className="block max-w-full" />
          </div>
        ))}
        {annotationCanvas && <div className={isDrawingMode ? 'pointer-events-auto absolute inset-0' : 'pointer-events-none absolute inset-0'}>{annotationCanvas}</div>}
      </div>
      {pageCount > 0 && <div className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-md border border-border bg-bg-elevated/90 px-2 py-1 text-xs shadow backdrop-blur-sm">
        <button type="button" aria-label="Previous PDF page" disabled={page <= 1} onClick={(e) => { e.stopPropagation(); changePage(Math.max(1, page - (spread ? 2 : 1))) }} className="rounded p-1 hover:bg-bg-hover disabled:opacity-30"><ChevronLeft className="h-4 w-4" /></button>
        <span className="tabular-nums">{spread && page < pageCount ? `Pages ${page}–${page + 1}` : `Page ${page}`} of {pageCount}</span>
        <button type="button" aria-label="Next PDF page" disabled={page >= pageCount || (spread && page + 1 >= pageCount)} onClick={(e) => { e.stopPropagation(); changePage(Math.min(pageCount, page + (spread ? 2 : 1))) }} className="rounded p-1 hover:bg-bg-hover disabled:opacity-30"><ChevronRight className="h-4 w-4" /></button>
        <button type="button" aria-label={spread ? 'Use single-page PDF view' : 'Use spread PDF view'} aria-pressed={spread} onClick={(e) => { e.stopPropagation(); setSpread((value) => !value) }} className={cn('rounded p-1 hover:bg-bg-hover', spread && 'bg-bg-hover text-text-primary')}><BookOpen className="h-4 w-4" /></button>
      </div>}
    </div>
  )
}
