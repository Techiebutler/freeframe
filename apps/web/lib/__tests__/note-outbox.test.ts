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

describe('sendNotePayload - spoken notes (spec 2026-11-18)', () => {
  const dictation = { id: 'd-1', text: 'Eins.', words: [], segments: [] }
  it('sends the dictation with its segment number, announces the audio, and uploads it as dictation_audio', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ id: 'c1' })
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/attachments')) return new Response(JSON.stringify({ upload_url: 'https://put/x', attachment_id: 'att1', key: 'k' }), { status: 201 })
      return new Response('{}', { status: 200 })
    })
    vi.stubGlobal('fetch', f)
    const blob = new Blob(['voice'], { type: 'audio/webm;codecs=opus' })
    await sendNotePayload({ kind: 'project', assetId: 'a1', versionId: 'v1', text: 'Eins.', t: 3, annotation: null, dictation, segmentIndex: 0, dictationAudio: { blob, duration_s: 7.61234 } }, 'k1')
    expect(post.mock.calls[0][1]).toMatchObject({ dictation, segment_index: 0, attachments_expected: 1 })
    const [, slotInit] = f.mock.calls[0]
    expect(JSON.parse(String(slotInit?.body))).toMatchObject({ kind: 'dictation_audio', content_type: 'audio/webm', duration_s: 7.61, file_name: 'dictation.webm' })
    const put = f.mock.calls.find(c => c[0] === 'https://put/x')
    expect(new Headers(put?.[1]?.headers).get('Content-Type')).toBe('audio/webm')
    expect(f.mock.calls.some(c => String(c[0]).endsWith('/attachments/att1/complete'))).toBe(true)
  })
  it('a later sentence of the same dictation carries the dictation but no second recording', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ id: 'c2' })
    await sendNotePayload({ kind: 'project', assetId: 'a1', versionId: 'v1', text: 'Zwei.', t: 5, annotation: null, dictation, segmentIndex: 1 }, 'k2')
    expect(post.mock.calls[0][1]).toMatchObject({ dictation, segment_index: 1 })
    expect(post.mock.calls[0][1]).not.toHaveProperty('attachments_expected')
  })
  it('a typed note has no dictation fields at all', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({})
    await sendNotePayload({ kind: 'project', assetId: 'a1', versionId: 'v1', text: 'typed', t: 1, annotation: null }, 'k3')
    expect(post.mock.calls[0][1]).not.toHaveProperty('dictation')
    expect(post.mock.calls[0][1]).not.toHaveProperty('segment_index')
  })
  it('a failed audio upload is retried once, then the round is released without it (the words are never blocked)', async () => {
    vi.spyOn(api, 'post').mockResolvedValue({ id: 'c1' })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const f = vi.fn(async (url: string) => (String(url).includes('send-without-missing') ? new Response('{}', { status: 200 }) : new Response('{}', { status: 500 })))
    vi.stubGlobal('fetch', f)
    await sendNotePayload({ kind: 'project', assetId: 'a1', versionId: 'v1', text: 'Eins.', t: 3, annotation: null, dictation, segmentIndex: 0, dictationAudio: { blob: new Blob(['v']), duration_s: 1 } }, 'k4')
    expect(f.mock.calls.filter(c => String(c[0]).endsWith('/attachments')).length).toBe(2)
    expect(f.mock.calls.some(c => String(c[0]).includes('send-without-missing'))).toBe(true)
  })
})
