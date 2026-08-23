import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PdfViewer } from '../pdf-viewer'

const getPage = vi.fn()
const destroyDocument = vi.fn(async () => {})
const destroyLoadingTask = vi.fn(async () => {})
const getDocument = vi.fn(() => ({
  promise: Promise.resolve({ numPages: 3, getPage, destroy: destroyDocument }),
  destroy: destroyLoadingTask,
}))

vi.mock('@/lib/load-pdfjs', () => ({
  loadPdfJs: vi.fn(async () => ({
    GlobalWorkerOptions: { workerSrc: '' },
    getDocument,
  })),
}))

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(async () => ({ url: 'https://files.example.test/demo.pdf' })) },
}))

vi.mock('../review-provider', () => ({
  useReview: () => ({ shareToken: undefined, shareSession: null }),
}))

const asset = { id: 'a1', name: 'Demo.pdf', asset_type: 'pdf' } as never
const version = { id: 'v1', version_number: 1 } as never

let observedWidth = 800
let resizeCallback: ResizeObserverCallback | null = null

function makePage(renderPromise: Promise<void> = Promise.resolve()) {
  const cancel = vi.fn()
  return {
    cancel,
    page: {
      getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
      render: vi.fn(() => ({ promise: renderPromise, cancel })),
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  observedWidth = 800
  resizeCallback = null
  getPage.mockImplementation(async () => makePage().page)

  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.dataset.testid === 'pdf-scroll-viewport' ? observedWidth : 0
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as never)
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resizeCallback = callback }
    observe() {}
    unobserve() {}
    disconnect() {}
  })
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('PdfViewer', () => {
  it('renders only the selected page and mounts annotations inside its page-sized surface', async () => {
    render(
      <PdfViewer
        asset={asset}
        version={version}
        pageNumber={2}
        onPageChange={vi.fn()}
        annotationCanvas={<div data-testid="annotation-slot" />}
      />,
    )

    const annotation = await screen.findByTestId('annotation-slot')
    await waitFor(() => expect(getPage).toHaveBeenCalledWith(2))
    expect(annotation.parentElement).toBe(screen.getByTestId('pdf-page-surface'))
    expect(screen.getByTestId('pdf-page-surface')).toHaveStyle({ width: '768px', height: '1024px' })

    const canvas = screen.getByTestId('pdf-page-canvas') as HTMLCanvasElement
    expect(canvas.width).toBe(1536)
    expect(canvas.height).toBe(2048)
    expect(screen.getByLabelText('PDF page count')).toHaveTextContent('of 3')
  })

  it('clamps the page input and disables navigation at the document bounds', async () => {
    const onPageChange = vi.fn()
    render(<PdfViewer asset={asset} version={version} pageNumber={3} onPageChange={onPageChange} />)

    await screen.findByLabelText('PDF page count')
    expect(screen.getByTitle('Next page')).toBeDisabled()
    fireEvent.change(screen.getByLabelText('PDF page'), { target: { value: '99' } })
    expect(onPageChange).toHaveBeenCalledWith(3)

    fireEvent.click(screen.getByTitle('Previous page'))
    expect(onPageChange).toHaveBeenCalledWith(2)
  })

  it('cancels a stale render and rerenders when the viewport width changes', async () => {
    let resolveFirstRender!: () => void
    const firstRenderPromise = new Promise<void>((resolve) => { resolveFirstRender = resolve })
    const first = makePage(firstRenderPromise)
    const second = makePage()
    getPage
      .mockResolvedValueOnce(first.page)
      .mockResolvedValueOnce(second.page)

    render(<PdfViewer asset={asset} version={version} pageNumber={1} onPageChange={vi.fn()} />)
    await waitFor(() => expect(getPage).toHaveBeenCalledTimes(1))

    observedWidth = 500
    act(() => resizeCallback?.([], {} as ResizeObserver))

    await waitFor(() => expect(first.cancel).toHaveBeenCalled())
    await waitFor(() => expect(getPage).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('pdf-page-surface')).toHaveStyle({ width: '468px', height: '624px' })
    resolveFirstRender()
  })
})
