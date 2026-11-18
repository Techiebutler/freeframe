import * as React from 'react'
import { api } from './api'
import { getUsableAccessToken } from './auth'
import { authHeaders } from './auth-headers'
import { createOutbox, idbStore, statusLine, summarize, type Outbox, type OutboxEntry } from './outbox'
import { uploadDictationAudio, uploadImages, type ImageRoute } from './comment-images'
import { postGuestNote, sessionQuery, type GuestIdentity } from './share-flow'

const API_URL = () => process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

/** images: reference screenshots that belong to THIS comment (kept as Files, IndexedDB stores them as is). */
export interface NoteBody { text: string; t: number; annotation: Record<string, unknown> | null; images?: File[]; dropMissingImages?: boolean
  /** drawn-frame.jpg: the video frame with the ink on it. Never blocks the comment: see uploadDrawnFrame. */
  drawnFrame?: File
  /** Spoken note: the whole dictation (shared by its sentence-notes), this note's number in it, and - on the first note only - the recording. */
  dictation?: unknown; segmentIndex?: number; dictationAudio?: { blob: Blob; duration_s: number } }
/** Everything a note needs to be sent later, from any screen: it must not depend on component state. */
export type NotePayload =
  | ({ kind: 'project'; assetId: string; versionId: string } & NoteBody)
  | ({ kind: 'share'; token: string; assetId: string; versionId?: string; identity?: GuestIdentity | null; shareSession?: string | null } & NoteBody)

/** The comment first (its Idempotency-Key makes a resend find it), then its images. If an image fails the
 *  whole entry is retried: the same comment comes back and the server reuses the image's row. */
/** After the comment exists: upload the drawn frame, one retry, and if it still fails release the round without it. Never throws. */
export async function uploadDrawnFrame(route: ImageRoute, file: File, release: () => Promise<void>): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await uploadImages(route, [file]); return } catch (e) { console.warn('drawn-frame: upload failed', attempt ? '(giving up)' : '(retrying)', e) }
  }
  await release().catch(() => undefined)
}

/** The recording is a bonus for the agent: one retry, and if it still fails the round is released without it (never blocks the words). */
async function uploadAudioOrRelease(route: ImageRoute, a: { blob: Blob; duration_s: number }, release: () => Promise<void>): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await uploadDictationAudio(route, a.blob, a.duration_s); return } catch (e) { console.warn('dictation audio: upload failed', attempt ? '(giving up)' : '(retrying)', e) }
  }
  await release().catch(() => undefined)
}

/** Classic comment box: the comment is already saved; the picture follows in the background (fire and forget). */
export async function sendDrawnFrame(commentId: string, file: File): Promise<void> {
  const token = await getUsableAccessToken().catch(() => null)
  const base = `${API_URL()}/comments/${commentId}/attachments`
  await uploadDrawnFrame({ base, headers: authHeaders(token) }, file, () => withoutMissing(`${base}/send-without-missing`, {}, authHeaders(token)))
}

export async function sendNotePayload(p: NotePayload, idempotencyKey: string): Promise<void> {
  const headers = { 'Idempotency-Key': idempotencyKey }
  const images = p.images ?? []
  const expected = images.length + (p.drawnFrame ? 1 : 0) + (p.dictationAudio ? 1 : 0)
  const token = await getUsableAccessToken().catch(() => null)
  if (p.kind === 'project') {
    const body: Record<string, unknown> = { body: p.text, version_id: p.versionId, timecode_start: Math.round(p.t * 1000) / 1000 }
    if (p.annotation) body.annotation = { drawing_data: p.annotation }
    if (p.dictation) { body.dictation = p.dictation; body.segment_index = p.segmentIndex ?? 0 }
    if (expected) body.attachments_expected = expected
    const c = await api.post<{ id: string }>(`/assets/${p.assetId}/comments`, body, { headers })
    const release = () => withoutMissing(`${API_URL()}/comments/${c.id}/attachments/send-without-missing`, {}, authHeaders(token))
    const route = { base: `${API_URL()}/comments/${c.id}/attachments`, headers: authHeaders(token) }
    if (p.dropMissingImages) await release()
    else {
      if (images.length) await uploadImages(route, images)
      if (p.dictationAudio) await uploadAudioOrRelease(route, p.dictationAudio, release)
      if (p.drawnFrame) await uploadDrawnFrame(route, p.drawnFrame, release)
    }
    return
  }
  const identity = token ? null : p.identity
  const id = await postGuestNote(p.token, { text: p.text, t: p.t, annotation: p.annotation, attachmentsExpected: expected, dictation: p.dictation, segmentIndex: p.segmentIndex }, {
    identity, shareSession: p.shareSession, assetId: p.assetId, versionId: p.versionId,
    headers: { ...authHeaders(token), ...headers },
  })
  if (!id) return
  const release = () => withoutMissing(`${API_URL()}/share/${p.token}/comments/${id}/send-without-missing${sessionQuery(p.shareSession)}`, { guest_email: identity?.email }, authHeaders(token))
  const route = { base: `${API_URL()}/share/${p.token}/comments/${id}/attachments`, query: sessionQuery(p.shareSession),
    headers: authHeaders(token), guestEmail: identity?.email }
  if (p.dropMissingImages) await release()
  else {
    if (images.length) await uploadImages(route, images)
    if (p.dictationAudio) await uploadAudioOrRelease(route, p.dictationAudio, release)
    if (p.drawnFrame) await uploadDrawnFrame(route, p.drawnFrame, release)
  }
}

/** The author chose to send the comment without the images that never arrived. */
async function withoutMissing(url: string, body: unknown, headers: Record<string, string>) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
  if (!res.ok) throw Object.assign(new Error('send_without_images_failed'), { status: res.status })
}

let singleton: Outbox | null = null
/** One outbox per page load: it keeps sending while the reviewer moves on to the next file. */
export function getNoteOutbox(): Outbox {
  if (!singleton) {
    singleton = createOutbox({
      store: idbStore('flow-note-outbox'),
      send: sendNotePayload,
      onOnline: cb => { window.addEventListener('online', cb); return () => window.removeEventListener('online', cb) },
    })
    void singleton.load()
  }
  return singleton
}
export const resetNoteOutboxForTests = () => { singleton = null }

export function useNoteOutbox(outbox: Outbox = getNoteOutbox()) {
  const [entries, setEntries] = React.useState<OutboxEntry[]>(() => outbox.entries())
  React.useEffect(() => {
    setEntries(outbox.entries())
    return outbox.subscribe(() => setEntries(outbox.entries()))
  }, [outbox])
  const summary = React.useMemo(() => summarize(entries), [entries])
  return { entries, summary, line: statusLine(summary), enqueue: outbox.enqueue, retry: outbox.retry, retryWith: outbox.retryWith, byId: (id: string) => entries.find(e => e.id === id) }
}
