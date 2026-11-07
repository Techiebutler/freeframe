import * as React from 'react'
import { api } from './api'
import { getUsableAccessToken } from './auth'
import { authHeaders } from './auth-headers'
import { createOutbox, idbStore, statusLine, summarize, type Outbox, type OutboxEntry } from './outbox'
import { uploadImages } from './comment-images'
import { postGuestNote, sessionQuery, type GuestIdentity } from './share-flow'

const API_URL = () => process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

/** images: reference screenshots that belong to THIS comment (kept as Files, IndexedDB stores them as is). */
export interface NoteBody { text: string; t: number; annotation: Record<string, unknown> | null; images?: File[] }
/** Everything a note needs to be sent later, from any screen: it must not depend on component state. */
export type NotePayload =
  | ({ kind: 'project'; assetId: string; versionId: string } & NoteBody)
  | ({ kind: 'share'; token: string; assetId: string; versionId?: string; identity?: GuestIdentity | null; shareSession?: string | null } & NoteBody)

/** The comment first (its Idempotency-Key makes a resend find it), then its images. If an image fails the
 *  whole entry is retried: the same comment comes back and the server reuses the image's row. */
export async function sendNotePayload(p: NotePayload, idempotencyKey: string): Promise<void> {
  const headers = { 'Idempotency-Key': idempotencyKey }
  const images = p.images ?? []
  const token = await getUsableAccessToken().catch(() => null)
  if (p.kind === 'project') {
    const body: Record<string, unknown> = { body: p.text, version_id: p.versionId, timecode_start: Math.round(p.t * 1000) / 1000 }
    if (p.annotation) body.annotation = { drawing_data: p.annotation }
    if (images.length) body.attachments_expected = images.length
    const c = await api.post<{ id: string }>(`/assets/${p.assetId}/comments`, body, { headers })
    if (images.length) await uploadImages({ base: `${API_URL()}/comments/${c.id}/attachments`, headers: authHeaders(token) }, images)
    return
  }
  const identity = token ? null : p.identity
  const id = await postGuestNote(p.token, { text: p.text, t: p.t, annotation: p.annotation, attachmentsExpected: images.length }, {
    identity, shareSession: p.shareSession, assetId: p.assetId, versionId: p.versionId,
    headers: { ...authHeaders(token), ...headers },
  })
  if (images.length && id) {
    await uploadImages({ base: `${API_URL()}/share/${p.token}/comments/${id}/attachments`, query: sessionQuery(p.shareSession),
      headers: authHeaders(token), guestEmail: identity?.email }, images)
  }
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
  return { entries, summary, line: statusLine(summary), enqueue: outbox.enqueue, retry: outbox.retry, byId: (id: string) => entries.find(e => e.id === id) }
}
