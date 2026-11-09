import type { DictationResult } from './agents'

const API_URL = () => process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

export interface GuestIdentity { name: string; email: string }
export interface GuestNote { text: string; t: number; annotation: Record<string, unknown> | null; attachmentsExpected?: number }

export class ShareFlowError extends Error {
  status: number
  detail: string
  constructor(status: number, detail: string) { super(detail); this.status = status; this.detail = detail }
}

export const sessionQuery = (shareSession?: string | null) => (shareSession ? `?share_session=${encodeURIComponent(shareSession)}` : '')

async function fail(res: Response, fallback: string): Promise<never> {
  const detail = await res.json().then(d => (typeof d?.detail === 'string' ? d.detail : null)).catch(() => null)
  throw new ShareFlowError(res.status, detail ?? fallback)
}

/** A guest note becomes a timed comment on the share link (the endpoint already takes timecode_start and annotation). */
export async function postGuestNote(
  token: string,
  note: GuestNote,
  opts: { identity?: GuestIdentity | null; shareSession?: string | null; assetId?: string; versionId?: string; headers?: Record<string, string> } = {},
): Promise<string | undefined> {
  const body: Record<string, unknown> = { body: note.text, timecode_start: Math.round(note.t * 1000) / 1000 }
  if (note.annotation) body.annotation = { drawing_data: note.annotation }
  if (note.attachmentsExpected) body.attachments_expected = note.attachmentsExpected
  if (opts.identity) { body.guest_name = opts.identity.name; body.guest_email = opts.identity.email }
  if (opts.assetId) body.asset_id = opts.assetId
  if (opts.versionId) body.version_id = opts.versionId
  const res = await fetch(`${API_URL()}/share/${token}/comment${sessionQuery(opts.shareSession)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    body: JSON.stringify(body),
  })
  if (!res.ok) await fail(res, 'Failed to post comment')
  return (await res.json().catch(() => null))?.id
}

/** Guests are not logged in, so dictation goes through the share link: POST /share/{token}/dictate (Lane A). */
export async function guestDictate(token: string, audio: Blob, shareSession?: string | null): Promise<DictationResult> {
  const fd = new FormData()
  fd.append('audio', audio, 'dictation.webm')
  const res = await fetch(`${API_URL()}/share/${token}/dictate${sessionQuery(shareSession)}`, { method: 'POST', body: fd })
  if (!res.ok) await fail(res, 'dictation_unavailable')
  const r = await res.json()
  return { text: r.text, segments: r.segments ?? [], ...(r.words?.length ? { words: r.words } : {}) }
}

/** Approve one asset through a folder share link: POST /share/{token}/assets/{asset_id}/approve (Lane A). */
export async function approveSharedAsset(
  token: string,
  assetId: string,
  opts: { identity?: GuestIdentity | null; shareSession?: string | null; versionId?: string; headers?: Record<string, string> } = {},
): Promise<void> {
  const body: Record<string, unknown> = {}
  if (opts.versionId) body.version_id = opts.versionId
  if (opts.identity) { body.guest_name = opts.identity.name; body.guest_email = opts.identity.email }
  const res = await fetch(`${API_URL()}/share/${token}/assets/${assetId}/approve${sessionQuery(opts.shareSession)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    body: JSON.stringify(body),
  })
  if (!res.ok) await fail(res, 'Failed to approve')
}

/** The file tab after `currentId`, or null at the end of the briefing. */
export function nextFileId(files: { id: string }[], currentId: string): string | null {
  const i = files.findIndex(f => f.id === currentId)
  return i >= 0 && i < files.length - 1 ? files[i + 1].id : null
}

/** Takes an approval back: DELETE /share/{token}/assets/{asset_id}/approve (idempotent, 204). */
export async function undoApproveSharedAsset(
  token: string,
  assetId: string,
  opts: { shareSession?: string | null; versionId?: string; headers?: Record<string, string> } = {},
): Promise<void> {
  const q = new URLSearchParams()
  if (opts.versionId) q.set('version_id', opts.versionId)
  if (opts.shareSession) q.set('share_session', opts.shareSession)
  const qs = q.toString()
  const res = await fetch(`${API_URL()}/share/${token}/assets/${assetId}/approve${qs ? `?${qs}` : ''}`, { method: 'DELETE', headers: opts.headers })
  if (!res.ok) await fail(res, 'Failed to undo')
}

/** Send pressed: close the feedback round now so a waiting agent starts at once. Best effort: the 5-minute idle close is the fallback. */
export function shareFeedbackDone(token: string, assetId: string, shareSession?: string | null): void {
  const qs = shareSession ? `?share_session=${encodeURIComponent(shareSession)}` : ''
  fetch(`${API_URL()}/share/${token}/assets/${assetId}/feedback-done${qs}`, { method: 'POST' }).catch(() => {})
}
