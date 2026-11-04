import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { sendNotePayload } from '../note-outbox'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('sendNotePayload', () => {
  it('posts a project note as a timed comment with the Idempotency-Key header', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({})
    await sendNotePayload({ kind: 'project', assetId: 'a1', versionId: 'v1', text: 'Hook slow', t: 3.14159, annotation: { format: 'ink.v1' } }, 'uuid-1')
    expect(post).toHaveBeenCalledWith('/assets/a1/comments',
      { body: 'Hook slow', version_id: 'v1', timecode_start: 3.142, annotation: { drawing_data: { format: 'ink.v1' } } },
      { headers: { 'Idempotency-Key': 'uuid-1' } })
  })
  it('posts a share note through the share endpoint, guest identity and key included', async () => {
    const f = vi.fn().mockResolvedValue(new Response('{}', { status: 201 })); vi.stubGlobal('fetch', f)
    await sendNotePayload({ kind: 'share', token: 'tok', assetId: 'a1', text: 'x', t: 1, annotation: null, identity: { name: 'Ann', email: 'a@x.co' } }, 'uuid-2')
    const [url, init] = f.mock.calls[0]
    expect(url).toMatch(/\/share\/tok\/comment/)
    expect(init.headers['Idempotency-Key']).toBe('uuid-2')
    expect(JSON.parse(init.body)).toMatchObject({ body: 'x', timecode_start: 1, guest_name: 'Ann', asset_id: 'a1' })
  })
  it('lets the API error through with its status so the outbox can tell 4xx from 5xx', async () => {
    vi.spyOn(api, 'post').mockRejectedValue(Object.assign(new Error('nope'), { status: 503 }))
    await expect(sendNotePayload({ kind: 'project', assetId: 'a', versionId: 'v', text: 'x', t: 0, annotation: null }, 'k')).rejects.toMatchObject({ status: 503 })
  })
})
