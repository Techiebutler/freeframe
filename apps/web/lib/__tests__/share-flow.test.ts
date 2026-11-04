import { afterEach, describe, expect, it, vi } from 'vitest'
import { approveSharedAsset, guestDictate, nextFileId, postGuestNote, ShareFlowError } from '../share-flow'

afterEach(() => vi.unstubAllGlobals())
const ok = (b: unknown = {}, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })

describe('postGuestNote', () => {
  it('posts a timed comment with the drawing and the guest identity', async () => {
    const f = vi.fn().mockResolvedValue(ok({}, 201)); vi.stubGlobal('fetch', f)
    await postGuestNote('tok', { text: 'Hook slow', t: 3.14159, annotation: { format: 'ink.v1' } }, { identity: { name: 'Ann', email: 'a@x.co' }, shareSession: 's 1', assetId: 'a1' })
    const [url, init] = f.mock.calls[0]
    expect(url).toMatch(/\/share\/tok\/comment\?share_session=s%201$/)
    expect(JSON.parse(init.body)).toEqual({ body: 'Hook slow', timecode_start: 3.142, annotation: { drawing_data: { format: 'ink.v1' } }, guest_name: 'Ann', guest_email: 'a@x.co', asset_id: 'a1' })
  })
  it('omits annotation and identity when there are none (logged-in viewer)', async () => {
    const f = vi.fn().mockResolvedValue(ok({}, 201)); vi.stubGlobal('fetch', f)
    await postGuestNote('tok', { text: 'x', t: 1, annotation: null }, { headers: { Authorization: 'Bearer z' } })
    const [, init] = f.mock.calls[0]
    expect(JSON.parse(init.body)).toEqual({ body: 'x', timecode_start: 1 })
    expect(init.headers.Authorization).toBe('Bearer z')
  })
  it('throws the server detail', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({ detail: 'This share link does not allow commenting' }, 403)))
    await expect(postGuestNote('tok', { text: 'x', t: 1, annotation: null })).rejects.toMatchObject({ status: 403, detail: 'This share link does not allow commenting' })
  })
})

describe('guestDictate', () => {
  it('uploads to the share dictate endpoint and defaults segments', async () => {
    const f = vi.fn().mockResolvedValue(ok({ text: 'hello' })); vi.stubGlobal('fetch', f)
    expect(await guestDictate('tok', new Blob(['a']))).toEqual({ text: 'hello', segments: [] })
    expect(f.mock.calls[0][0]).toMatch(/\/share\/tok\/dictate$/)
    expect(f.mock.calls[0][1].body).toBeInstanceOf(FormData)
  })
  it('fails with a ShareFlowError when the endpoint is missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({ detail: 'Not Found' }, 404)))
    await expect(guestDictate('tok', new Blob(['a']))).rejects.toBeInstanceOf(ShareFlowError)
  })
})

describe('approveSharedAsset', () => {
  it('posts to the asset approve endpoint of the share link with the guest identity', async () => {
    const f = vi.fn().mockResolvedValue(ok({}, 200)); vi.stubGlobal('fetch', f)
    await approveSharedAsset('tok', 'a1', { identity: { name: 'Ann', email: 'a@x.co' }, shareSession: 's1', versionId: 'v2' })
    const [url, init] = f.mock.calls[0]
    expect(url).toMatch(/\/share\/tok\/assets\/a1\/approve\?share_session=s1$/)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ version_id: 'v2', guest_name: 'Ann', guest_email: 'a@x.co' })
  })
  it('throws the server detail so the notes and button stay put', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({ detail: 'This share link does not allow approving' }, 403)))
    await expect(approveSharedAsset('tok', 'a1')).rejects.toMatchObject({ status: 403, detail: 'This share link does not allow approving' })
  })
})

describe('nextFileId', () => {
  const files = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  it('moves to the next tab and stops at the end', () => {
    expect(nextFileId(files, 'a')).toBe('b')
    expect(nextFileId(files, 'c')).toBeNull()
    expect(nextFileId(files, 'zzz')).toBeNull()
  })
})
