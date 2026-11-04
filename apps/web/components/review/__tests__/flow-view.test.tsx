import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import { FlowView, type FlowViewProps } from '../flow-view'
import { createOutbox, memoryStore } from '@/lib/outbox'
import { resetSession } from '@/lib/flow-session'
import { beforeEach } from 'vitest'

const audio = new Blob(['a'])
const recorder = () => vi.fn().mockResolvedValue({ stop: vi.fn().mockResolvedValue(audio), cancel: vi.fn() })
const rect = () => ({ left: 0, top: 0, width: 200, height: 400, right: 200, bottom: 400, x: 0, y: 0, toJSON: () => ({}) })

function setup(over: Partial<FlowViewProps> & { send?: (p: unknown, id: string) => Promise<void> } = {}) {
  const send = over.send ?? vi.fn().mockResolvedValue(undefined)
  const outbox = createOutbox({ store: memoryStore(), send: send as never, isOnline: () => true, wait: async () => {}, onOnline: () => () => {} })
  const props: FlowViewProps = {
    renderMedia: (overlay) => <div data-testid="media">{overlay}</div>,
    files: [{ id: 'a1', name: 'Hook 1' }, { id: 'a2', name: 'Hook 2' }],
    currentFileId: 'a1',
    onSelectFile: vi.fn(),
    getPlayhead: () => 3.2,
    onPause: vi.fn(),
    onSeek: vi.fn(),
    canComment: true,
    notePayload: (n) => ({ kind: 'project', assetId: 'a1', versionId: 'v1', ...n }),
    outbox,
    onApprove: vi.fn().mockResolvedValue(undefined),
    approved: false,
    dictate: vi.fn().mockResolvedValue({ text: 'Hook too slow', segments: [] }),
    startRecording: recorder(),
    ...over,
  }
  const view = render(<FlowView {...props} />)
  return { props, send: send as ReturnType<typeof vi.fn>, outbox, rerender: (o: Partial<FlowViewProps>) => view.rerender(<FlowView {...props} {...o} />) }
}
afterEach(() => { cleanup(); vi.useRealTimers() })
beforeEach(() => resetSession())
const line = (text: string) => screen.findByText((_, el) => el?.tagName === 'P' && el.getAttribute('data-tone') !== null && el.textContent === text)
const record = async () => {
  fireEvent.click(screen.getByRole('button', { name: /comment/i }))
  fireEvent.click(await screen.findByRole('button', { name: /stop/i }))
}

describe('FlowView', () => {
  it('shows the briefing files across the top and switches file', () => {
    const p = setup().props
    expect(screen.getByRole('button', { name: 'Hook 1' })).toHaveAttribute('aria-current', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Hook 2' }))
    expect(p.onSelectFile).toHaveBeenCalledWith('a2')
  })

  it('Comment captures the playhead without pausing, records, then dictates and saves the note on its own', async () => {
    const { props, send } = setup()
    fireEvent.click(screen.getByRole('button', { name: /comment/i }))
    expect(props.onPause).not.toHaveBeenCalled()
    expect(await screen.findByRole('status', { name: 'Recording' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /stop/i }))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    const [payload, key] = send.mock.calls[0]
    expect(payload).toMatchObject({ kind: 'project', assetId: 'a1', versionId: 'v1', text: 'Hook too slow', t: 3.2, annotation: null })
    expect(typeof key).toBe('string')
    expect(props.dictate).toHaveBeenCalledWith(audio)
  })

  it('tells the reviewer when everything is saved, with no Send step in between', async () => {
    setup()
    await record()
    expect(await line('All saved ✓')).toBeInTheDocument()
  })

  it('shows "N saved · M sending…" while a note is on its way', async () => {
    let release!: () => void
    setup({ send: () => new Promise<void>(r => { release = r }) })
    await record()
    expect(await line('0 saved · 1 sending…')).toBeInTheDocument()
    expect(screen.getByText(/next time you open this/i)).toBeInTheDocument()
    release()
    expect(await line('All saved ✓')).toBeInTheDocument()
  })

  it('a rejected note stays on screen and the status line says so', async () => {
    setup({ send: vi.fn().mockRejectedValue(Object.assign(new Error('nope'), { status: 403, detail: 'This share link does not allow commenting' })) })
    await record()
    expect(await line('0 saved · 1 failed')).toBeInTheDocument()
    expect(screen.getByText('Hook too slow')).toBeInTheDocument()
  })

  it('keeps the audio when dictation fails and Try again re-sends the same recording', async () => {
    const dictate = vi.fn().mockRejectedValueOnce({ detail: 'x' }).mockResolvedValueOnce({ text: 'Second try', segments: [] })
    const { send } = setup({ dictate })
    await record()
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not transcribe/i)
    expect(send).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(dictate).toHaveBeenNthCalledWith(2, audio)
    expect(send.mock.calls[0][0].text).toBe('Second try')
  })

  it('falls back to typing when the microphone is unavailable, and saves once typing is done', async () => {
    const { send } = setup({ startRecording: vi.fn().mockRejectedValue(new Error('denied')) })
    fireEvent.click(screen.getByRole('button', { name: /comment/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/microphone unavailable/i)
    const box = screen.getByRole('textbox')
    fireEvent.change(box, { target: { value: 'Typed note' } })
    expect(send).not.toHaveBeenCalled()
    fireEvent.blur(box)
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(send.mock.calls[0][0].text).toBe('Typed note')
  })

  it('notes wait while the reviewer has not said who they are, then save without being asked again', async () => {
    const onNeedSave = vi.fn()
    const { send, rerender } = setup({ canSave: false, onNeedSave })
    await record()
    await waitFor(() => expect(onNeedSave).toHaveBeenCalled())
    expect(send).not.toHaveBeenCalled()
    rerender({ canSave: true })
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
  })

  it('keeps the video playing while recording, pauses on the first stroke, and saves the ink with the note', async () => {
    const { props, send } = setup()
    fireEvent.click(screen.getByRole('button', { name: /comment/i }))
    expect(props.onPause).not.toHaveBeenCalled()
    await screen.findByRole('button', { name: /stop/i })
    const layer = screen.getByTestId('ink-layer')
    expect(layer).toHaveAttribute('data-on')
    layer.getBoundingClientRect = rect
    fireEvent.pointerDown(layer, { clientX: 100, clientY: 200, pointerId: 1 })
    expect(props.onPause).toHaveBeenCalledTimes(1)
    fireEvent.pointerMove(layer, { clientX: 150, clientY: 300, pointerId: 1 })
    fireEvent.pointerUp(layer, { clientX: 150, clientY: 300, pointerId: 1 })
    fireEvent.click(screen.getByRole('button', { name: /stop/i }))
    await waitFor(() => expect(send).toHaveBeenCalled())
    const sent = send.mock.calls[0][0]
    expect(sent.annotation).toMatchObject({ format: 'ink.v1', marks: [{ k: 'stroke' }] })
    expect(sent.annotation.marks[0].t).toBeGreaterThanOrEqual(3.2)
    expect(sent.annotation.marks[0].points[0]).toEqual([0.5, 0.5])
    expect(typeof sent.annotation.mark_offset_ms).toBe('number')
  })

  it('makes one note per spoken segment at its own time, ink on the sentence it was drawn in', async () => {
    const dictate = vi.fn().mockResolvedValue({ text: 'a b', segments: [{ start: 0, end: 2, text: 'Hook too slow.' }, { start: 4, end: 6, text: 'Cut here.' }] })
    const { send } = setup({ dictate })
    fireEvent.click(screen.getByRole('button', { name: /comment/i }))
    await screen.findByRole('button', { name: /stop/i })
    const layer = screen.getByTestId('ink-layer')
    layer.getBoundingClientRect = rect
    await new Promise(r => setTimeout(r, 30))
    fireEvent.pointerDown(layer, { clientX: 10, clientY: 10, pointerId: 1 })
    fireEvent.pointerUp(layer, { clientX: 10, clientY: 10, pointerId: 1 })
    fireEvent.click(screen.getByRole('button', { name: /stop/i }))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    const sent = send.mock.calls.map(c => c[0])
    expect(sent.map((n: { t: number }) => n.t)).toEqual([3.2, 7.2])
    expect(sent[0].annotation?.marks).toHaveLength(1)
    expect(sent[1].annotation).toBeNull()
  })

  it('a drawing carries the video time it was drawn at, even after the video paused mid-recording', async () => {
    let video!: HTMLVideoElement
    const state = { currentTime: 3.2, paused: false, playbackRate: 1 }
    const { props, send } = setup({ renderMedia: (o) => <div><video ref={(v) => { if (v) { video = v; Object.defineProperties(v, { currentTime: { get: () => state.currentTime, configurable: true }, paused: { get: () => state.paused, configurable: true }, playbackRate: { get: () => state.playbackRate, configurable: true } }) } }} />{o}</div> })
    fireEvent.click(screen.getByRole('button', { name: /comment/i }))
    await screen.findByRole('button', { name: /stop/i })
    await new Promise(r => setTimeout(r, 40))
    state.currentTime = 4; state.paused = true
    video.dispatchEvent(new Event('pause'))
    await new Promise(r => setTimeout(r, 40))
    const layer = screen.getByTestId('ink-layer')
    layer.getBoundingClientRect = rect
    fireEvent.pointerDown(layer, { clientX: 100, clientY: 200, pointerId: 1 })
    fireEvent.pointerMove(layer, { clientX: 150, clientY: 300, pointerId: 1 })
    fireEvent.pointerUp(layer, { clientX: 150, clientY: 300, pointerId: 1 })
    fireEvent.click(screen.getByRole('button', { name: /stop/i }))
    await waitFor(() => expect(send).toHaveBeenCalled())
    expect(send.mock.calls[0][0].annotation.marks[0].t).toBe(4)
    fireEvent.click(await screen.findByRole('button', { name: 'Drawing at 0:04.0' }))
    expect(props.onSeek).toHaveBeenCalledWith(4)
    await waitFor(() => expect(document.querySelector('.ink-line')).not.toBeNull())
  })

  it('recording looks alive: edge glow, level meter, mono timer and a cancel that throws everything away', async () => {
    const cancel = vi.fn()
    const { send, props } = setup({ startRecording: vi.fn().mockResolvedValue({ stop: vi.fn().mockResolvedValue(audio), cancel }) })
    expect(screen.queryByTestId('rec-glow')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /comment/i }))
    await screen.findByRole('button', { name: /stop/i })
    expect(screen.getByTestId('rec-glow')).toBeInTheDocument()
    expect(screen.getByTestId('level-meter')).toBeInTheDocument()
    expect(screen.getByTestId('rec-timer')).toHaveTextContent('0:00')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel recording' }))
    expect(cancel).toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByTestId('rec-glow')).toBeNull())
    expect(screen.queryByTestId('note-chip')).toBeNull()
    expect(props.dictate).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('passes a level callback to the recorder', async () => {
    const startRecording = vi.fn().mockResolvedValue({ stop: vi.fn().mockResolvedValue(audio), cancel: vi.fn() })
    setup({ startRecording })
    fireEvent.click(screen.getByRole('button', { name: /comment/i }))
    await screen.findByRole('button', { name: /stop/i })
    expect(typeof startRecording.mock.calls[0][0]).toBe('function')
  })

  it('hands the player one marker per note', async () => {
    const seen: number[] = []
    setup({ renderMedia: (o, extra) => { seen.push(extra.markers.length); return <div>{o}</div> } })
    expect(seen.at(-1)).toBe(0)
    await record()
    await waitFor(() => expect(seen.at(-1)).toBe(1))
  })

  it('shows each note as a chip that goes clock -> spinner -> check as it is saved', async () => {
    let release!: () => void
    setup({ send: () => new Promise<void>(r => { release = r }) })
    await record()
    await screen.findByRole('img', { name: 'Sending' })
    expect(screen.getByTestId('note-chip')).toHaveAttribute('data-state', 'sending')
    release()
    expect(await screen.findByRole('img', { name: 'Saved' })).toBeInTheDocument()
  })

  it('a rejected note shows a red Retry that sends it again with the same text', async () => {
    const send = vi.fn().mockRejectedValueOnce(Object.assign(new Error('x'), { status: 403, detail: 'No access' })).mockResolvedValue(undefined)
    setup({ send })
    await record()
    const retry = await screen.findByRole('button', { name: /retry sending note/i })
    expect(screen.getByRole('alert')).toHaveTextContent('No access')
    fireEvent.click(retry)
    expect(await screen.findByRole('img', { name: 'Saved' })).toBeInTheDocument()
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1][1]).toBe(send.mock.calls[0][1])
  })

  it('shows a Transcribing placeholder at once after Stop, then fills in the words', async () => {
    let finish!: (v: { text: string; segments: [] }) => void
    setup({ dictate: () => new Promise(r => { finish = r as never }) })
    await record()
    expect(await screen.findByText('Transcribing…')).toBeInTheDocument()
    finish({ text: 'Hook too slow', segments: [] })
    await waitFor(() => expect(screen.getByText('Hook too slow')).toBeInTheDocument())
  })

  it('underlines pointing words; tapping one seeks to the note and replays its drawing', async () => {
    const dictate = vi.fn().mockResolvedValue({ text: 'Cut this part', segments: [] })
    const { props } = setup({ dictate })
    fireEvent.click(screen.getByRole('button', { name: /comment/i }))
    await screen.findByRole('button', { name: /stop/i })
    const layer = screen.getByTestId('ink-layer')
    layer.getBoundingClientRect = rect
    fireEvent.pointerDown(layer, { clientX: 100, clientY: 200, pointerId: 1 })
    fireEvent.pointerMove(layer, { clientX: 150, clientY: 300, pointerId: 1 })
    fireEvent.pointerUp(layer, { clientX: 150, clientY: 300, pointerId: 1 })
    fireEvent.click(screen.getByRole('button', { name: /stop/i }))
    const word = await screen.findByRole('button', { name: 'this' })
    expect(screen.queryByRole('button', { name: 'Cut' })).not.toBeInTheDocument()
    fireEvent.click(word)
    expect(props.onSeek).toHaveBeenCalledWith(3.2)
    await waitFor(() => expect(document.querySelector('.ink-stroke')).not.toBeNull())
  })

  it('shows a small picture of each drawing in its chip', async () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: /comment/i }))
    await screen.findByRole('button', { name: /stop/i })
    const layer = screen.getByTestId('ink-layer')
    layer.getBoundingClientRect = rect
    fireEvent.pointerDown(layer, { clientX: 100, clientY: 200, pointerId: 1 })
    fireEvent.pointerMove(layer, { clientX: 150, clientY: 300, pointerId: 1 })
    fireEvent.pointerUp(layer, { clientX: 150, clientY: 300, pointerId: 1 })
    fireEvent.click(screen.getByRole('button', { name: /stop/i }))
    const chip = await screen.findByRole('button', { name: /^Drawing at/ })
    expect(chip.querySelector('svg polyline')).not.toBeNull()
  })

  it('the ink layer is inert when not recording', () => {
    setup()
    expect(screen.getByTestId('ink-layer')).not.toHaveAttribute('data-on')
  })

  it('with notes the right button closes the round (Send to agent), and waits until everything is saved', async () => {
    let release!: () => void
    const onFinishRound = vi.fn().mockResolvedValue(undefined)
    setup({ send: () => new Promise<void>(r => { release = r }), onFinishRound })
    await record()
    const btn = await screen.findByRole('button', { name: 'Send to agent' })
    expect(btn).toBeDisabled()
    release()
    await waitFor(() => expect(btn).toBeEnabled())
    fireEvent.click(btn)
    await waitFor(() => expect(onFinishRound).toHaveBeenCalled())
  })

  it('without an agent the right button reads Done: the notes are already saved', async () => {
    setup()
    await record()
    expect(await screen.findByRole('button', { name: 'Done' })).toBeInTheDocument()
  })

  it('with no notes the right button is an explicit Approve', async () => {
    const { props } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(props.onApprove).toHaveBeenCalled())
  })

  it('without approve permission the empty Send stays disabled', () => {
    setup({ canApprove: false })
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  })

  it('hides the controls for view-only users', () => {
    setup({ canComment: false })
    expect(screen.queryByRole('button', { name: /comment/i })).not.toBeInTheDocument()
    expect(screen.getByText(/view-only/i)).toBeInTheDocument()
  })

  describe('approve, undo and the closing moments', () => {
    const approve = async () => { fireEvent.click(screen.getByRole('button', { name: 'Approve' })); await screen.findByText('Approved') }

    it('Approve shows Approved with a 5 s Undo, then moves to the next file on its own', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      const onNext = vi.fn()
      setup({ onUndoApprove: vi.fn().mockResolvedValue(undefined), hasNext: true, onNext })
      await approve()
      expect(screen.getByRole('button', { name: 'Undo (5 s)' })).toBeInTheDocument()
      expect(onNext).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(5200)
      expect(onNext).toHaveBeenCalledTimes(1)
    })

    it('Undo within the 5 s takes the approval back and stays on this file', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      const onUndoApprove = vi.fn().mockResolvedValue(undefined)
      const onNext = vi.fn()
      setup({ onUndoApprove, hasNext: true, onNext })
      await approve()
      await vi.advanceTimersByTimeAsync(2000)
      fireEvent.click(screen.getByRole('button', { name: /^Undo/ }))
      await vi.advanceTimersByTimeAsync(10)
      expect(onUndoApprove).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(8000)
      expect(onNext).not.toHaveBeenCalled()
      expect(screen.queryByText('Approved')).toBeNull()
    })

    it('after the last file it ends with "All done · X approved, Y with feedback"', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      setup({ onUndoApprove: vi.fn().mockResolvedValue(undefined), hasNext: false, sessionKey: 'folder' })
      await approve()
      await vi.advanceTimersByTimeAsync(5200)
      expect(await screen.findByText('All done · 1 approved')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Close' }))
      expect(screen.queryByRole('dialog', { name: 'Done' })).toBeNull()
    })

    it('Send to agent ends in a moment that says how many notes the agent has, and offers the next file', async () => {
      const onNext = vi.fn()
      setup({ onFinishRound: vi.fn().mockResolvedValue(undefined), hasNext: true, onNext })
      await record()
      const btn = await screen.findByRole('button', { name: 'Send to agent' })
      await waitFor(() => expect(btn).toBeEnabled())
      fireEvent.click(btn)
      expect(await screen.findByText('1 note with the agent · it replies with the next version')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Next file' }))
      expect(onNext).toHaveBeenCalled()
    })

    it('counts files with feedback in the final numbers', async () => {
      setup({ onFinishRound: vi.fn().mockResolvedValue(undefined), hasNext: false, sessionKey: 'k2' })
      await record()
      const btn = await screen.findByRole('button', { name: 'Send to agent' })
      await waitFor(() => expect(btn).toBeEnabled())
      fireEvent.click(btn)
      expect(await screen.findByText('All done · 1 with feedback')).toBeInTheDocument()
    })

    it('a failed approve says so and keeps the button', async () => {
      setup({ onApprove: vi.fn().mockRejectedValue(new Error('x')) })
      fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
      expect(await screen.findByRole('alert')).toHaveTextContent(/could not approve/i)
      expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled()
    })
  })
})
