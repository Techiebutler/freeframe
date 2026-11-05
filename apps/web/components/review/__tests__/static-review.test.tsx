import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StaticReview, type StaticComment } from '../static-review'
import { pinDrawing } from '@/lib/static-pin'

class RO { observe() {} disconnect() {} unobserve() {} }
;(globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver = RO

const files = [1, 2, 3].map(n => ({ id: `a${n}`, name: `Ad ${n}` }))

function setup(over: Partial<React.ComponentProps<typeof StaticReview>> = {}, notes: Record<string, StaticComment[]> = {}) {
  const loadImage = vi.fn(async (id: string) => `https://img.test/${id}.png`)
  const loadComments = vi.fn(async (id: string) => notes[id] ?? [])
  const postComment = vi.fn(async () => {})
  render(<StaticReview files={files} startId="a1" canComment loadImage={loadImage} loadComments={loadComments} postComment={postComment} {...over} />)
  return { loadImage, loadComments, postComment }
}

describe('static review', () => {
  it('shows one image with a counter and the file name', async () => {
    setup()
    expect(screen.getByTestId('static-counter')).toHaveTextContent('1 / 3')
    expect(screen.getByRole('heading', { name: 'Ad 1' })).toBeInTheDocument()
    expect(await screen.findByAltText('Ad 1')).toHaveAttribute('src', 'https://img.test/a1.png')
  })

  it('arrow keys move between images, and stop at the ends', async () => {
    setup()
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(screen.getByTestId('static-counter')).toHaveTextContent('2 / 3')
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(screen.getByTestId('static-counter')).toHaveTextContent('3 / 3')
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(screen.getByTestId('static-counter')).toHaveTextContent('2 / 3')
  })

  it('does not steal the arrow keys from the note field', () => {
    setup()
    fireEvent.keyDown(screen.getByLabelText('Write a note on this image'), { key: 'ArrowRight' })
    expect(screen.getByTestId('static-counter')).toHaveTextContent('1 / 3')
  })

  it('a swipe left goes to the next image, a small drag does not', () => {
    setup()
    const stage = screen.getByTestId('static-stage')
    const swipe = (dx: number, dy = 0) => {
      fireEvent.touchStart(stage, { touches: [{ clientX: 200, clientY: 100 }] })
      fireEvent.touchEnd(stage, { changedTouches: [{ clientX: 200 + dx, clientY: 100 + dy }] })
    }
    swipe(-20)
    expect(screen.getByTestId('static-counter')).toHaveTextContent('1 / 3')
    swipe(-120)
    expect(screen.getByTestId('static-counter')).toHaveTextContent('2 / 3')
    swipe(120)
    expect(screen.getByTestId('static-counter')).toHaveTextContent('1 / 3')
  })

  it('prev and next buttons work and are disabled at the ends', () => {
    setup()
    expect(screen.getByLabelText('Previous image')).toBeDisabled()
    fireEvent.click(screen.getByLabelText('Next image'))
    expect(screen.getByTestId('static-counter')).toHaveTextContent('2 / 3')
  })

  it('loads the neighbouring images ahead of time', async () => {
    const { loadImage } = setup()
    await waitFor(() => expect(loadImage.mock.calls.map(c => c[0]).sort()).toEqual(['a1', 'a2', 'a3']))
  })

  it('shows only the notes of the current image', async () => {
    setup({}, { a1: [{ id: 'n1', body: 'Logo too small' }], a2: [{ id: 'n2', body: 'Fix the price' }] })
    expect(await screen.findByText('Logo too small')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Next image'))
    expect(await screen.findByText('Fix the price')).toBeInTheDocument()
    expect(screen.queryByText('Logo too small')).toBeNull()
  })

  it('draws a pin for a note that has a position', async () => {
    setup({}, { a1: [{ id: 'n1', body: 'Move this', annotation: { drawing_data: pinDrawing(0.3, 0.6) } }] })
    const pin = await screen.findByLabelText('Note 1: Move this')
    expect(pin).toHaveStyle({ left: '30%', top: '60%' })
  })

  it('a tap on the image pins the next note to that spot', async () => {
    const { postComment } = setup()
    const frame = await screen.findByTestId('static-frame')
    frame.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200, right: 200, bottom: 200, x: 0, y: 0, toJSON() {} })
    fireEvent.click(frame, { clientX: 50, clientY: 150 })
    expect(screen.getByTestId('pending-pin')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Write a note on this image'), { target: { value: 'Too dark' } })
    fireEvent.click(screen.getByLabelText('Send note'))
    await waitFor(() => expect(postComment).toHaveBeenCalledTimes(1))
    const [id, body, drawing] = postComment.mock.calls[0] as unknown as [string, string, { marks: { points: number[][] }[] }]
    expect([id, body]).toEqual(['a1', 'Too dark'])
    expect(drawing.marks[0].points[0]).toEqual([0.25, 0.75])
  })

  it('a note without a tap is a note on the whole image', async () => {
    const { postComment } = setup()
    fireEvent.change(screen.getByLabelText('Write a note on this image'), { target: { value: 'Good' } })
    fireEvent.click(screen.getByLabelText('Send note'))
    await waitFor(() => expect(postComment).toHaveBeenCalledWith('a1', 'Good', null))
  })

  it('view-only access has no pins and no field', async () => {
    setup({ canComment: false })
    expect(screen.queryByLabelText('Write a note on this image')).toBeNull()
    expect(screen.getByText(/View-only access/)).toBeInTheDocument()
  })
})

describe('static review fit', () => {
  const fitFor = async (w: number, h: number, nw = 1000, nh = 1000) => {
    const cw = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
    const ch = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => w })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => h })
    try {
      setup()
      const img = await screen.findByAltText('Ad 1')
      Object.defineProperty(img, 'naturalWidth', { value: nw })
      Object.defineProperty(img, 'naturalHeight', { value: nh })
      fireEvent.load(img)
      const frame = screen.getByTestId('static-frame')
      await waitFor(() => expect(frame.style.height).not.toBe(''))
      return [parseFloat(frame.style.width), parseFloat(frame.style.height)]
    } finally {
      if (cw) Object.defineProperty(HTMLElement.prototype, 'clientWidth', cw)
      if (ch) Object.defineProperty(HTMLElement.prototype, 'clientHeight', ch)
    }
  }
  it.each([[1464, 653], [1232, 602], [390, 300], [600, 900]])('a 1:1 image fits entirely in %ix%i', async (w, h) => {
    const [fw, fh] = await fitFor(w, h)
    expect(fw).toBeLessThanOrEqual(w)
    expect(fh).toBeLessThanOrEqual(h)
    expect(fw / fh).toBeCloseTo(1, 2)
  })
})
