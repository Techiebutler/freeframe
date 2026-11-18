import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import { FlowView, tabLabels, type FlowViewProps } from '../flow-view'
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

describe('FlowView embed', () => {
  it('renders the video with Comment and Approve only: no files bar, no notes list, no column', () => {
    setup({ embed: true })
    expect(screen.getByTestId('flow-view')).toHaveAttribute('data-layout', 'embed')
    expect(screen.getByTestId('media')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /comment/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: /files/i })).toBeNull()
    expect(screen.queryByLabelText('Feedback')).toBeNull()
    expect(screen.queryByLabelText('Your notes')).toBeNull()
  })
  it('shows the file navigation in the embed column', () => {
    setup({ embed: true, embedNav: <div data-testid="nav">2 / 7</div> })
    expect(screen.getByTestId('nav')).toBeInTheDocument()
  })
  it('has the glass bar: seek, play/pause, mute, fullscreen, mono time and comment markers', () => {
    setup({ embed: true, embedMarkers: [1, 2] })
    expect(screen.getByTestId('embed-bar')).toBeInTheDocument()
    expect(screen.getByRole('slider', { name: 'Seek' })).toBeInTheDocument()
    for (const n of ['Play', 'Mute', 'Fullscreen']) expect(screen.getByRole('button', { name: n })).toBeInTheDocument()
  })
  it('space plays and pauses, arrows seek one second', () => {
    setup({ embed: true })
    const root = screen.getByTestId('flow-view')
    const v = document.createElement('video')
    Object.defineProperty(v, 'duration', { value: 30, configurable: true })
    const play = vi.fn().mockResolvedValue(undefined)
    v.play = play
    root.appendChild(v)
    fireEvent.keyDown(root, { key: ' ' })
    expect(play).toHaveBeenCalled()
    v.currentTime = 10
    fireEvent.keyDown(root, { key: 'ArrowRight' })
    expect(v.currentTime).toBe(11)
    fireEvent.keyDown(root, { key: 'ArrowLeft' })
    expect(v.currentTime).toBe(10)
  })
  it('a comment in the list goes to its time and plays its drawing', () => {
    const { props } = setup({
      embed: true,
      embedComments: (show) => <button onClick={() => show(7, { format: 'ink.v1', mark_offset_ms: 0, marks: [{ k: 'dot', points: [[0.5, 0.5]], t: 7, offset_ms: 0 }] })}>c7</button>,
    })
    fireEvent.click(screen.getByRole('button', { name: 'c7' }))
    expect(props.onSeek).toHaveBeenCalledWith(7)
  })
  it('lets the comments of a narrow frame be opened and closed', () => {
    setup({ embed: true, embedComments: () => <p>list</p> })
    const toggle = screen.getByRole('button', { name: /comments/i })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
  })
  it('announces a note once it is saved, with its time', async () => {
    const onNoteSaved = vi.fn()
    setup({ embed: true, onNoteSaved })
    await record()
    await waitFor(() => expect(onNoteSaved).toHaveBeenCalledWith(3.2))
    expect(onNoteSaved).toHaveBeenCalledTimes(1)
  })
})

describe('FlowView embed: pause = talk, play = silence', () => {
  const withVideo = (over: Partial<FlowViewProps> = {}) => setup({ embed: true, renderMedia: (overlay) => <div data-testid="media"><video data-testid="vid" />{overlay}</div>, ...over })
  // jsdom's <video> is always paused: say what it does, then let the event through.
  const fire = (name: string) => {
    const v = screen.getByTestId('vid')
    Object.defineProperty(v, 'paused', { configurable: true, value: name !== 'play' })
    fireEvent(v, new Event(name))
  }
  const now = vi.spyOn(Date, 'now')
  afterEach(() => now.mockReset())

  it('pausing starts the mic, playing again closes it and saves the spoken note', async () => {
    let t = 1000
    now.mockImplementation(() => t)
    const startRecording = recorder()
    const { props, send } = withVideo({ startRecording })
    fire('play')
    expect(startRecording).not.toHaveBeenCalled() // playing = silence, and no prompt on load
    fire('pause')
    expect(await screen.findByRole('status', { name: 'Recording' })).toBeInTheDocument()
    expect(startRecording).toHaveBeenCalledTimes(1)
    t += 3000
    fire('play')
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(props.dictate).toHaveBeenCalledWith(audio)
    expect(screen.queryByRole('status', { name: 'Recording' })).toBeNull()
  })
  it('a pause that nothing was said in saves no note', async () => {
    now.mockImplementation(() => 1000)
    const { props, send } = withVideo()
    fire('play'); fire('pause')
    await screen.findByRole('status', { name: 'Recording' })
    fire('play')
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Recording' })).toBeNull())
    expect(props.dictate).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })
  it('Comment while playing pauses the video and starts the mic', async () => {
    const { props } = withVideo()
    fire('play')
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }))
    expect(props.onPause).toHaveBeenCalled()
    expect(await screen.findByRole('status', { name: 'Recording' })).toBeInTheDocument()
  })
  it('no microphone: one hint, the comment box is focused, nothing is left half-recording', async () => {
    withVideo({ startRecording: vi.fn().mockRejectedValue(new Error('denied')) })
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }))
    expect(await screen.findByText(/Microphone not available/)).toBeInTheDocument()
    expect(screen.getByLabelText(/type a note at/i)).toHaveFocus()
    expect(screen.queryByRole('status', { name: 'Recording' })).toBeNull()
  })
  it('typing mode (no mic): strokes drawn while paused are saved as a note when the video plays again', async () => {
    const { send } = withVideo({ startRecording: vi.fn().mockRejectedValue(new Error('denied')) })
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }))
    await screen.findByText(/Microphone not available/)
    const ink = screen.getByTestId('ink-layer')
    ink.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 400, right: 200, bottom: 400, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    ink.setPointerCapture = () => {}
    ink.releasePointerCapture = () => {}
    fireEvent.pointerDown(ink, { pointerId: 1, clientX: 50, clientY: 50, button: 0 })
    fireEvent.pointerUp(ink, { pointerId: 1, clientX: 50, clientY: 50 })
    expect(send).not.toHaveBeenCalled()
    fire('play')
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    const payload = send.mock.calls[0][0] as { text: string; annotation: { marks: unknown[] } | null }
    expect(payload.text).toBe('Drawing')
    expect(payload.annotation?.marks.length).toBeGreaterThan(0)
  })
  it('while dictating the column is one row, Cancel and Stop: no typing field; Cancel leaves the idle row without one', async () => {
    withVideo()
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }))
    await screen.findByRole('status', { name: 'Recording' })
    expect(screen.queryByLabelText(/type a note at/i)).toBeNull()
    expect(screen.getByRole('button', { name: 'Stop recording' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel recording' }))
    expect(await screen.findByRole('button', { name: 'Type a note' })).toBeInTheDocument()
    expect(screen.queryByLabelText(/type a note at/i)).toBeNull() // the field only exists in typing mode
  })
  it('idle: a round keyboard button sits between Comment and Approve; dictating shows none', async () => {
    withVideo()
    const labels = Array.from(document.querySelectorAll('.ep-actions > button')).map(b => b.getAttribute('aria-label') ?? b.textContent)
    expect(labels.slice(0, 3)).toEqual(['Comment', 'Type a note', 'Approve'])
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }))
    await screen.findByRole('status', { name: 'Recording' })
    expect(screen.queryByRole('button', { name: 'Type a note' })).toBeNull()
  })
  it('keyboard: typing mode shows the notes with their second (tap jumps); Play saves the typed note; Comment goes back to dictation', async () => {
    const { send, props } = withVideo()
    fireEvent.click(screen.getByRole('button', { name: 'Type a note' }))
    const field = await screen.findByLabelText(/type a note at/i)
    await waitFor(() => expect(field).toHaveFocus())
    fireEvent.change(field, { target: { value: 'First typed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }))
    const list = await screen.findByRole('list', { name: 'Your notes' })
    expect(list).toHaveTextContent('First typed')
    fireEvent.click(screen.getByRole('button', { name: /^Go to / }))
    expect(props.onSeek).toHaveBeenCalledWith(3.2)
    fireEvent.change(field, { target: { value: 'Typed on play' } })
    fire('play')
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    fire('pause')
    expect(screen.queryByRole('status', { name: 'Recording' })).toBeNull() // typing stays through pause
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }))
    expect(await screen.findByRole('status', { name: 'Recording' })).toBeInTheDocument()
  })
  it('typed notes work when not dictating', async () => {
    const { send } = withVideo()
    expect(screen.queryByLabelText(/type a note at/i)).toBeNull() // idle: no field until the keyboard button
    fireEvent.click(screen.getByRole('button', { name: 'Type a note' }))
    fireEvent.change(await screen.findByLabelText(/type a note at/i), { target: { value: 'Cut the intro' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(send.mock.calls[0][0]).toMatchObject({ text: 'Cut the intro', t: 3.2 })
  })
})

describe('FlowView', () => {
  it('keeps the phone Comment label whole: the button never shrinks below its label and the finish button yields', () => {
    setup({ finishLabel: 'An den Agenten senden' })
    const comment = screen.getByRole('button', { name: /comment/i })
    expect(comment).toHaveClass('whitespace-nowrap', 'min-w-[7.5rem]')
    expect(comment.className).not.toMatch(/\bmin-w-0\b/)
    expect(screen.getByRole('button', { name: /approve/i })).toHaveClass('shrink')
  })
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

    describe('delivery', () => {
      const made = { token: 'tok', share_url: 'https://feedback.test/d/tok' }
      const copy = vi.fn().mockResolvedValue(undefined)
      beforeEach(() => {
        copy.mockClear()
        Object.defineProperty(navigator, 'clipboard', { value: { writeText: copy }, configurable: true })
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
        vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }))
      })
      afterEach(() => vi.unstubAllGlobals())

      it('Approve bursts confetti and offers Copy share link; copying hands the delivery on', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true })
        setup({ onApprove: vi.fn().mockResolvedValue(made), onUndoApprove: vi.fn().mockResolvedValue(undefined) })
        await approve()
        expect(screen.getByTestId('confetti')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Copy share link' }))
        await vi.advanceTimersByTimeAsync(10)
        expect(copy).toHaveBeenCalledWith(made.share_url)
        expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/deliveries/tok/handed-on'), { method: 'POST' })
        expect(await screen.findByText('Link copied')).toBeInTheDocument()
        await vi.advanceTimersByTimeAsync(1500)
        expect(screen.queryByTestId('confetti')).toBeNull()
      })

      it('Undo before copying means no hand-on, and the moment never offers the link', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true })
        setup({ onApprove: vi.fn().mockResolvedValue(made), onUndoApprove: vi.fn().mockResolvedValue(undefined) })
        await approve()
        fireEvent.click(screen.getByRole('button', { name: /^Undo/ }))
        await vi.advanceTimersByTimeAsync(7000)
        expect(screen.queryByRole('button', { name: 'Copy share link' })).toBeNull()
        expect(fetch).not.toHaveBeenCalled()
      })

      it('after the 5 s the link is still the one main action', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true })
        setup({ onApprove: vi.fn().mockResolvedValue(made), onUndoApprove: vi.fn().mockResolvedValue(undefined) })
        await approve()
        await vi.advanceTimersByTimeAsync(5200)
        expect(screen.getByRole('dialog', { name: 'Done' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Copy share link' })).toBeInTheDocument()
      })

      it('shows no confetti under reduced motion', async () => {
        vi.stubGlobal('matchMedia', (q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} }))
        setup({ onApprove: vi.fn().mockResolvedValue(made) })
        await approve()
        expect(screen.queryByTestId('confetti')).toBeNull()
        expect(screen.getByRole('button', { name: 'Copy share link' })).toBeInTheDocument()
      })
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

describe('tabLabels', () => {
  it('names the iteration, not the shared concept (Alan 2026-11-16)', () => {
    expect(tabLabels(['Black Friday UGC 3 – Hook 5', 'Black Friday UGC 3 – Hook 1'])).toEqual(['Hook 5', 'Hook 1'])
  })
  it('keeps whole words and leaves unrelated or single names alone', () => {
    expect(tabLabels(['Hook 10', 'Hook 1'])).toEqual(['Hook 10', 'Hook 1'])
    expect(tabLabels(['Intro', 'Outro'])).toEqual(['Intro', 'Outro'])
    expect(tabLabels(['Only file'])).toEqual(['Only file'])
  })
})

describe('drop anywhere (spec 2026-11-16)', () => {
  const dt = (files: File[]) => ({ dataTransfer: { types: ['Files'], files } })
  const png = new File(['x'], 'ref.png', { type: 'image/png' })
  it('dragging a file over the video pauses and shows where it will go', () => {
    const { props } = setup({ wide: true })
    fireEvent.dragEnter(screen.getByTestId('media'), dt([png]))
    expect(props.onPause).toHaveBeenCalled()
    expect(screen.getByTestId('drop-overlay')).toHaveTextContent(/at 0:03/)
  })
  it('a picture dropped on the video goes into the tray, the overlay leaves', () => {
    setup({ wide: true })
    fireEvent.dragEnter(screen.getByTestId('media'), dt([png]))
    fireEvent.drop(screen.getByTestId('media'), dt([png]))
    expect(screen.queryByTestId('drop-overlay')).toBeNull()
    expect(screen.getByLabelText('Images for this comment')).toBeInTheDocument()
  })
  it('a PDF is refused with the existing line and nothing is attached', () => {
    setup({ wide: true })
    fireEvent.drop(screen.getByTestId('media'), dt([new File(['x'], 'a.pdf', { type: 'application/pdf' })]))
    expect(screen.getByText(/Only PNG, JPEG, WebP or GIF/)).toBeInTheDocument()
  })
  it('the phone layout has no drop zone (Alan: no drag and drop on a phone)', () => {
    setup()
    fireEvent.dragEnter(screen.getByTestId('media'), dt([png]))
    expect(screen.queryByTestId('drop-overlay')).toBeNull()
  })
  it('view-only shows no overlay', () => {
    setup({ wide: true, canComment: false })
    fireEvent.dragEnter(screen.getByTestId('media'), dt([png]))
    expect(screen.queryByTestId('drop-overlay')).toBeNull()
  })
  it('a file dropped anywhere on the page never opens in the tab', () => {
    setup()
    const e = new Event('drop', { cancelable: true }) as Event & { dataTransfer: unknown }
    Object.defineProperty(e, 'dataTransfer', { value: { types: ['Files'] } })
    window.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true)
  })
})

describe('FlowView embed: per-part approve, share link only when every part is approved (founder, 2026-11-18)', () => {
  const parts = ['Hook 1', 'Hook 2', 'Hook 3', 'Body', 'CTA']
  const embed = (over: Partial<FlowViewProps> = {}) => setup({ embed: true, files: parts.map((name, i) => ({ id: `a${i + 1}`, name })), onUndoApprove: vi.fn().mockResolvedValue(undefined), ...over })

  it('approving one of five shows "1 of 5 approved" and no Copy share link, and Undo stays', async () => {
    const view = embed({ parts: { approved: 0, total: 5 } })
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await screen.findByText('Approved')
    view.rerender({ parts: { approved: 1, total: 5 } })
    expect(screen.getByTestId('parts-progress')).toHaveTextContent('1 of 5 approved')
    expect(screen.queryByRole('button', { name: 'Copy share link' })).toBeNull()
    expect(screen.getByRole('button', { name: /^Undo/ })).toBeInTheDocument()
    expect(screen.queryByTestId('confetti')).toBeNull()
  })

  it('the last part approved (server hands back the link) offers Copy share link', async () => {
    embed({ parts: { approved: 4, total: 5 }, onApprove: vi.fn().mockResolvedValue({ token: 'tok', share_url: 'https://x/d/tok' }) })
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(await screen.findByRole('button', { name: 'Copy share link' })).toBeInTheDocument()
  })

  it('without comments Approve is the primary action', () => {
    embed({ parts: { approved: 0, total: 5 }, unsentFeedback: 0 })
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send feedback' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Approve this part' })).toBeNull()
  })

  it('with comments Send feedback is primary, closes the round, and Approve is a quiet per-part action', async () => {
    const onSent = vi.fn()
    const onApprove = vi.fn().mockResolvedValue(undefined)
    embed({ parts: { approved: 1, total: 5 }, unsentFeedback: 3, onSent, onApprove })
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }))
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1))
    expect(onApprove).not.toHaveBeenCalled()
  })

  it('"Approve this part" approves just this part while comments are open', async () => {
    const onApprove = vi.fn().mockResolvedValue(undefined)
    const onSent = vi.fn()
    embed({ parts: { approved: 0, total: 5 }, unsentFeedback: 2, onApprove, onSent })
    fireEvent.click(screen.getByRole('button', { name: 'Approve this part' }))
    await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(1))
    expect(onSent).not.toHaveBeenCalled()
  })
})
