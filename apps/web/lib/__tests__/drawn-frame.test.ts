import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { drawnFrameFile, nearestShot, snapshotVideo, DRAWN_FRAME_NAME } from '../drawn-frame'
import { sendNotePayload } from '../note-outbox'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
const frame = new File([new Uint8Array([1, 2, 3])], DRAWN_FRAME_NAME, { type: 'image/jpeg' })
const ink = { format: 'ink.v1' }

/** jsdom has no canvas: a minimal 2d context is enough to follow the calls. */
function stubCanvas(opts: { tainted?: boolean } = {}) {
  const ctx = { drawImage: vi.fn(), getImageData: vi.fn(() => { if (opts.tainted) throw new DOMException('tainted', 'SecurityError') }),
    beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), quadraticCurveTo: vi.fn(), arc: vi.fn(), stroke: vi.fn() }
  const real = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    if (tag !== 'canvas') return real(tag)
    return { width: 0, height: 0, getContext: () => ctx, toBlob: (cb: (b: Blob) => void) => cb(new Blob(['jpg'], { type: 'image/jpeg' })) } as unknown as HTMLCanvasElement
  })
  return ctx
}
const video = { videoWidth: 1920, videoHeight: 1080, readyState: 4 } as HTMLVideoElement

describe('drawn frame picture', () => {
  it('renders frame plus ink into a drawn-frame.jpg, long side at most 1280', async () => {
    stubCanvas()
    const shot = { t: 2, canvas: snapshotVideo(video)! }
    expect(shot.canvas.width).toBe(1280)
    expect(shot.canvas.height).toBe(720)
    const f = await drawnFrameFile(shot, [{ k: 'stroke', points: [[0.1, 0.1], [0.5, 0.5], [0.9, 0.2]] }, { k: 'dot', points: [[0.3, 0.3]] }])
    expect(f?.name).toBe('drawn-frame.jpg')
    expect(f?.type).toBe('image/jpeg')
  })
  it('a tainted canvas gives no picture instead of throwing', () => {
    stubCanvas({ tainted: true })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(snapshotVideo(video)).toBeNull()
  })
  it('takes the shot closest to the comment time and none from another frame', () => {
    const a = { t: 1, canvas: {} as HTMLCanvasElement }, b = { t: 5, canvas: {} as HTMLCanvasElement }
    expect(nearestShot([a, b], 5.1)).toBe(b)
    expect(nearestShot([a, b], 3)).toBeNull()
  })
})

describe('sendNotePayload with a drawn frame', () => {
  const project = { kind: 'project', assetId: 'a1', versionId: 'v1', text: 'Fix', t: 2, annotation: ink } as const
  const slot = { attachment_id: 'att1', upload_url: 'https://s3/put' }
  const mockFetch = () => {
    const f = vi.fn(async (url: string) => (url.includes('/attachments') && !url.includes('complete') ? json(slot) : json({}))) as unknown as typeof fetch
    vi.stubGlobal('fetch', f); return f as unknown as ReturnType<typeof vi.fn>
  }

  it('counts it in attachments_expected and uploads one attachment named drawn-frame.jpg after the comment', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ id: 'c1' })
    const f = mockFetch()
    await sendNotePayload({ ...project, drawnFrame: frame }, 'k1')
    expect(post.mock.calls[0][1]).toMatchObject({ attachments_expected: 1 })
    const req = f.mock.calls.find(c => String(c[0]).endsWith('/comments/c1/attachments'))!
    expect(JSON.parse(req[1].body)).toMatchObject({ file_name: 'drawn-frame.jpg', content_type: 'image/jpeg' })
    expect(f.mock.calls.some(c => String(c[0]).endsWith('/comments/c1/attachments/att1/complete'))).toBe(true)
  })
  it('adds to the reviewer images in attachments_expected', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ id: 'c1' })
    mockFetch()
    await sendNotePayload({ ...project, images: [new File(['x'], 'a.png', { type: 'image/png' })], drawnFrame: frame }, 'k2')
    expect(post.mock.calls[0][1]).toMatchObject({ attachments_expected: 2 })
  })
  it('a comment without ink asks for no attachment and uploads nothing', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ id: 'c1' })
    const f = mockFetch()
    await sendNotePayload({ ...project, annotation: null }, 'k3')
    expect(post.mock.calls[0][1]).not.toHaveProperty('attachments_expected')
    expect(f).not.toHaveBeenCalled()
  })
  it('a failing upload is retried once, then the round is released and the comment stays saved', async () => {
    vi.spyOn(api, 'post').mockResolvedValue({ id: 'c1' })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const f = vi.fn(async (url: string) => (url.includes('send-without-missing') ? json({}) : json({ detail: 'nope' }, 500)))
    vi.stubGlobal('fetch', f)
    await expect(sendNotePayload({ ...project, drawnFrame: frame }, 'k4')).resolves.toBeUndefined()
    expect(f.mock.calls.filter(c => String(c[0]).endsWith('/comments/c1/attachments'))).toHaveLength(2)
    expect(f.mock.calls.some(c => String(c[0]).includes('/comments/c1/attachments/send-without-missing'))).toBe(true)
  })
})
