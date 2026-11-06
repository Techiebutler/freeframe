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

describe('static review voice memo', () => {
  const recorder = () => {
    const stop = vi.fn(async () => new Blob(['a'], { type: 'audio/webm' }))
    const cancel = vi.fn()
    return { stop, cancel, start: vi.fn(async () => ({ stop, cancel })) }
  }

  it('Talk records, a tap pins it, Stop saves the words as a note on that image with that pin, by itself', async () => {
    const r = recorder()
    const dictate = vi.fn(async () => ({ text: 'Make the logo bigger', segments: [] }))
    const { postComment } = setup({ startRecording: r.start, dictate })
    await screen.findByTestId('static-frame')
    fireEvent.click(screen.getByLabelText('Talk'))
    expect(await screen.findByTestId('rec-glow')).toBeInTheDocument()
    const layer = screen.getByTestId('ink-layer')
    layer.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200, right: 200, bottom: 200, x: 0, y: 0, toJSON() {} })
    fireEvent.pointerDown(layer, { clientX: 100, clientY: 40, pointerId: 1 })
    fireEvent.pointerUp(layer, { clientX: 100, clientY: 40, pointerId: 1 })
    fireEvent.click(screen.getByLabelText('Stop recording'))
    await waitFor(() => expect(postComment).toHaveBeenCalledTimes(1))
    const [id, body, drawing] = postComment.mock.calls[0] as unknown as [string, string, { marks: { points: number[][] }[] }]
    expect([id, body]).toEqual(['a1', 'Make the logo bigger'])
    expect(drawing.marks[0].points[0]).toEqual([0.5, 0.2])
    await waitFor(() => expect(screen.getByTestId('memo-status')).toHaveAttribute('data-state', 'saved'))
    expect(screen.queryByTestId('pending-pin')).toBeNull()
  })

  it('one memo across ads: each sentence and drawing lands on the ad that was on screen', async () => {
    let now = 1_000_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const r = recorder()
      const dictate = vi.fn(async () => ({ text: 'x', segments: [{ start: 0.5, end: 1.5, text: 'Headline bigger.' }, { start: 5, end: 6, text: 'Swap the photo.' }] }))
      const { postComment } = setup({ startRecording: r.start, dictate })
      await screen.findByTestId('static-frame')
      fireEvent.click(screen.getByLabelText('Talk'))
      await screen.findByTestId('rec-glow')
      now += 4000
      fireEvent.keyDown(window, { key: 'ArrowRight' })
      now += 1500
      const layer = await screen.findByTestId('ink-layer')
      layer.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON() {} })
      fireEvent.pointerDown(layer, { clientX: 10, clientY: 10, pointerId: 1 })
      fireEvent.pointerMove(layer, { clientX: 60, clientY: 60, pointerId: 1, buttons: 1 })
      fireEvent.pointerUp(layer, { clientX: 60, clientY: 60, pointerId: 1 })
      fireEvent.click(screen.getByLabelText('Stop recording'))
      await waitFor(() => expect(postComment).toHaveBeenCalledTimes(2))
      const calls = postComment.mock.calls as unknown as [string, string, { marks: { k: string }[] } | null][]
      expect(calls.map(c => [c[0], c[1]])).toEqual([['a1', 'Headline bigger.'], ['a2', 'Swap the photo.']])
      expect(calls[0][2]).toBeNull()
      expect(calls[1][2]!.marks[0].k).toBe('stroke')
      await waitFor(() => expect(screen.getByTestId('memo-status')).toHaveTextContent('Memo saved as 2 notes'))
    } finally { clock.mockRestore() }
  })

  it('a memo recorded on one image is saved to that image even after moving on', async () => {
    const r = recorder()
    let release: (v: { text: string; segments: [] }) => void = () => {}
    const dictate = vi.fn(() => new Promise<{ text: string; segments: [] }>(res => { release = res }))
    const { postComment } = setup({ startRecording: r.start, dictate })
    fireEvent.click(screen.getByLabelText('Talk'))
    fireEvent.click(await screen.findByLabelText('Stop recording'))
    await waitFor(() => expect(dictate).toHaveBeenCalled())
    fireEvent.click(screen.getByLabelText('Next image'))
    release({ text: 'Fix the price', segments: [] })
    await waitFor(() => expect(postComment).toHaveBeenCalledWith('a1', 'Fix the price', null))
  })

  it('a memo that fails to save offers Retry, and typed text is untouched', async () => {
    const r = recorder()
    const post = vi.fn().mockRejectedValueOnce(new Error('no')).mockResolvedValue(undefined)
    setup({ startRecording: r.start, dictate: vi.fn(async () => ({ text: 'Too dark', segments: [] })), postComment: post })
    fireEvent.change(screen.getByLabelText('Write a note on this image'), { target: { value: 'typed' } })
    fireEvent.click(screen.getByLabelText('Talk'))
    fireEvent.click(await screen.findByLabelText('Stop recording'))
    fireEvent.click(await screen.findByText('Retry'))
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByTestId('memo-status')).toHaveAttribute('data-state', 'saved'))
    expect(screen.getByLabelText('Write a note on this image')).toHaveValue('typed')
  })

  it('a failed transcription says so and keeps typing available', async () => {
    const r = recorder()
    setup({ startRecording: r.start, dictate: vi.fn(async () => { throw new Error('x') }) })
    fireEvent.click(screen.getByLabelText('Talk'))
    fireEvent.click(await screen.findByLabelText('Stop recording'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not transcribe')
    expect(screen.getByLabelText('Write a note on this image')).toBeInTheDocument()
  })

  it('says when dictation is not set up', async () => {
    const r = recorder()
    setup({ startRecording: r.start, dictate: vi.fn(async () => { throw { detail: 'dictation_unavailable' } }) })
    fireEvent.click(screen.getByLabelText('Talk'))
    fireEvent.click(await screen.findByLabelText('Stop recording'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Dictation is not set up')
  })

  it('a blocked microphone gets a plain message, not a crash', async () => {
    const denied = Object.assign(new Error('denied'), { name: 'NotAllowedError' })
    setup({ startRecording: vi.fn(async () => { throw denied }) })
    fireEvent.click(screen.getByLabelText('Talk'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Microphone is blocked')
    expect(screen.getByLabelText('Talk')).toBeEnabled()
  })

  it('cancel throws the recording away without transcribing', async () => {
    const r = recorder()
    const dictate = vi.fn()
    setup({ startRecording: r.start, dictate })
    fireEvent.click(screen.getByLabelText('Talk'))
    fireEvent.click(await screen.findByLabelText('Cancel recording'))
    expect(r.cancel).toHaveBeenCalled()
    expect(dictate).not.toHaveBeenCalled()
  })
})
