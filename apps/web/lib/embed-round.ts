/** Embed round handling: close the round when the iframe goes away, ask the server for the round's state, tell Gen the note count. */
import { sessionQuery } from './share-flow'

const API_URL = () => process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

export interface LeaveArgs { token: string; assetId: string; shareSession?: string | null; /** A note is recording, transcribing or uploading: then nothing is sent. */ busy: boolean }

/**
 * Closes the open round as `left` (server: only if it holds a note). sendBeacon cannot send headers or JSON, so the reason
 * rides the query and the share session too; fetch keepalive is the fallback. Never throws.
 */
export function leaveRound(a: LeaveArgs, nav: { sendBeacon?: (url: string) => boolean } = typeof navigator !== 'undefined' ? navigator : {}): boolean {
  if (a.busy) return false
  const q = `?by=left${a.shareSession ? `&share_session=${encodeURIComponent(a.shareSession)}` : ''}`
  const url = `${API_URL()}/share/${a.token}/assets/${a.assetId}/feedback-done${q}`
  try { if (nav.sendBeacon?.(url)) return true } catch { /* fall through to fetch */ }
  try { fetch(url, { method: 'POST', keepalive: true }).catch(() => {}) } catch { /* nothing more to try */ }
  return true
}

/** One send per page life: pagehide and gen:close can both fire. A busy attempt (a note in progress) keeps the chance. */
export class EmbedRoundState {
  private sent = false
  leave(a: LeaveArgs, nav?: { sendBeacon?: (url: string) => boolean }): boolean {
    if (this.sent || a.busy) return false
    this.sent = true
    return leaveRound(a, nav)
  }
}

export interface RoundSyncResult { notes: number; closed_by: 'all_reviewed' | null }

/** After a note or an approve: the server closes the round if every module is reviewed, and counts the open round's notes. */
export async function roundSync(token: string, assetId: string, shareSession?: string | null): Promise<RoundSyncResult | null> {
  try {
    const res = await fetch(`${API_URL()}/share/${token}/assets/${assetId}/round-sync${sessionQuery(shareSession)}`, { method: 'POST' })
    if (!res.ok) return null
    const b = await res.json()
    return typeof b?.notes === 'number' ? { notes: b.notes, closed_by: b.closed_by ?? null } : null
  } catch { return null }
}

const lastCount = new Map<string, number>()

/** Posts the count only when it changed (the first one always). Module-level memory: the embed remounts per module. */
export function createNotesReporter(requestId: string, out: (count: number) => void) {
  return { report(count: number) { if (lastCount.get(requestId) === count) return; lastCount.set(requestId, count); out(count) } }
}
