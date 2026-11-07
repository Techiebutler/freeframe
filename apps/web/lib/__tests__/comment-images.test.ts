import { afterEach, describe, expect, it, vi } from 'vitest'
import { pickImages } from '../comment-images'
import { sendNotePayload } from '../note-outbox'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
const png = (name = 'ref.png', size = 10) => new File([new Uint8Array(size)], name, { type: 'image/png' })
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })

describe('pickImages', () => {
  it('keeps images up to 4 and says why the rest stayed out', () => {
    expect(pickImages([], [png(), new File(['x'], 'a.mp4', { type: 'video/mp4' })]).skipped).toMatch(/PNG, JPEG/)
    const four = pickImages([], [png('1'), png('2'), png('3'), png('4'), png('5')])
    expect(four.images).toHaveLength(4)
    expect(four.skipped).toMatch(/Up to 4/)
    expect(pickImages([], [png()]).skipped).toBeNull()
  })
})

describe('a share note with an image', () => {
  it('posts the comment announcing 1 image, then creates, uploads and confirms it on that comment', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(json({ id: 'c1' }, 201))
      .mockResolvedValueOnce(json({ upload_url: 'https://s3/put', attachment_id: 'i1', key: 'k' }, 201))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(json({ id: 'i1' }))
    vi.stubGlobal('fetch', f)
    await sendNotePayload({ kind: 'share', token: 'tok', assetId: 'a1', text: 'Like this', t: 2, annotation: null,
      identity: { name: 'Ann', email: 'a@x.co' }, images: [png()] }, 'k1')
    const urls = f.mock.calls.map(c => c[0] as string)
    expect(JSON.parse(f.mock.calls[0][1].body)).toMatchObject({ body: 'Like this', attachments_expected: 1 })
    expect(urls[1]).toMatch(/\/share\/tok\/comments\/c1\/attachments$/)
    expect(JSON.parse(f.mock.calls[1][1].body)).toMatchObject({ content_type: 'image/png', guest_email: 'a@x.co' })
    expect([urls[2], f.mock.calls[2][1].method]).toEqual(['https://s3/put', 'PUT'])
    expect(urls[3]).toMatch(/\/share\/tok\/comments\/c1\/attachments\/i1\/complete$/)
  })

  it('a failed upload throws so the outbox retries the whole note with the same key', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(json({ id: 'c1' }, 201))
      .mockResolvedValueOnce(json({ upload_url: 'https://s3/put', attachment_id: 'i1', key: 'k' }, 201))
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
    vi.stubGlobal('fetch', f)
    await expect(sendNotePayload({ kind: 'share', token: 'tok', assetId: 'a1', text: 'x', t: 0, annotation: null, images: [png()] }, 'k1')).rejects.toThrow(/image_put_500/)
  })
})

describe('send without the image', () => {
  it('replays the same comment (same key) and tells the server to drop the missing images', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(json({ id: 'c1' }, 200))
      .mockResolvedValueOnce(json({ attachments_expected: 0, removed: 1 }))
    vi.stubGlobal('fetch', f)
    await sendNotePayload({ kind: 'share', token: 'tok', assetId: 'a1', text: 'x', t: 0, annotation: null,
      identity: { name: 'Ann', email: 'a@x.co' }, images: [], dropMissingImages: true }, 'k1')
    expect(f.mock.calls[0][1].headers['Idempotency-Key']).toBe('k1')
    expect(f.mock.calls[1][0]).toMatch(/\/share\/tok\/comments\/c1\/send-without-missing$/)
    expect(JSON.parse(f.mock.calls[1][1].body)).toEqual({ guest_email: 'a@x.co' })
  })

  it('a refused image fails fast with the server reason (no blind retries)', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(json({ id: 'c1' }, 201))
      .mockResolvedValueOnce(json({ detail: 'Images can be up to 10 MB.' }, 422))
    vi.stubGlobal('fetch', f)
    await expect(sendNotePayload({ kind: 'share', token: 'tok', assetId: 'a1', text: 'x', t: 0, annotation: null, images: [png()] }, 'k'))
      .rejects.toMatchObject({ status: 422, detail: 'Images can be up to 10 MB.' })
  })
})
